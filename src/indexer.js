'use strict';
const path = require('path');
const fs = require('fs-extra');
const chokidar = require('chokidar');
const cfg = require('./config');
const db = require('./db');

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'yml', 'yaml',
  'js', 'ts', 'jsx', 'tsx', 'java', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'rb', 'php',
]);

function isExcluded(dir) {
  const base = path.basename(dir);
  return cfg.EXCLUDE_DIRS.has(base);
}

function extractText(filePath, ext) {
  if (!TEXT_EXT.has(ext)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > cfg.MAX_INDEX_TEXT) return null;
    return fs.readFileSync(filePath, 'utf8').slice(0, cfg.MAX_INDEX_TEXT);
  } catch (_) {
    return null;
  }
}

async function indexFile(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (_) {
    return;
  }
  if (!stat.isFile()) return;
  const rel = path.relative(cfg.ROOT, filePath);
  if (rel.startsWith('..')) return;
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  const content = extractText(filePath, ext);
  db.upsert({
    path: filePath,
    name: path.basename(filePath),
    kind: db.kindOf(ext),
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    ctime: Math.floor(stat.ctimeMs),
    mode: stat.mode,
    content: content || undefined,
  });
}

// v0.1.16：索引目录本身，使目录名也可被搜索（Everything 式）。
// 目录无内容抽取、无扩展名；size 记为 0，mtime 取目录本身 mtime。
async function indexDir(dirPath) {
  let stat;
  try {
    stat = await fs.stat(dirPath);
  } catch (_) {
    return;
  }
  if (!stat.isDirectory()) return;
  const rel = path.relative(cfg.ROOT, dirPath);
  if (rel.startsWith('..')) return;
  db.upsert({
    path: dirPath,
    name: path.basename(dirPath),
    kind: 'folder',
    size: 0,
    mtime: Math.floor(stat.mtimeMs),
    ctime: Math.floor(stat.ctimeMs),
    mode: stat.mode,
    isDir: 1,
  });
}

// 按实际类型派发：目录走 indexDir，文件走 indexFile（用于重命名/转换等回调）
async function indexItem(p) {
  let stat;
  try {
    stat = await fs.stat(p);
  } catch (_) {
    return;
  }
  if (stat.isDirectory()) return indexDir(p);
  return indexFile(p);
}

async function unindex(filePath) {
  db.remove(filePath);
}

// 初始全量扫描：分批 + 让出事件循环 + 错误隔离，避免大 NAS 上 OOM 被 kill 导致容器无限重启
const SCAN_BATCH = 200;        // 每批索引文件数
const SCAN_DIR_BATCH = 200;    // 每批索引目录数（v0.1.16 新增：目录也入库）
const SCAN_YIELD_MS = 5;       // 每批后让出事件循环，给 GC 与 IO 喘息
const SCAN_MAX_DEPTH = 25;     // 目录递归深度上限，防极深目录栈溢出
const SCAN_MAX_FILES = 3000000; // 全量扫描文件数上限（v0.1.15：原 50万 不够，用户 /data 已有 52.7万文件被漏扫 2.7万；提到 300万留足余量）
const SCAN_MAX_DIRS = 3000000;  // 全量扫描目录数上限（v0.1.16 新增：目录名也需入库，单独预算避免目录数挤掉文件）

async function initialScan() {
  let pending = [];
  let pendingDirs = [];
  let fileTotal = 0;
  let dirTotal = 0;
  const flush = async () => {
    const batch = pending;
    pending = [];
    // 并发写入本批，单个失败不影响整体
    await Promise.all(batch.map((f) => indexFile(f).catch(() => {})));
  };
  const flushDirs = async () => {
    const batch = pendingDirs;
    pendingDirs = [];
    await Promise.all(batch.map((d) => indexDir(d).catch(() => {})));
  };
  // v0.1.17：支持符号链接。lstat 语义下 e.isDirectory() 对「指向目录的软链」为 false，
  // 软链目录既不会被 indexDir 入库、也不会被递归进其下内容，导致搜不到。改为：
  //   普通目录/文件 → 与 v0.1.16 完全一致；
  //   符号链接 → fs.stat 跟随判断真实类型，目录按目录处理、文件按文件处理；
  //   断链/无权限 → continue 跳过。
  // 循环保护：visited 存已递归目录的 realpath。普通目录不做额外 syscall（性能），
  // 仅「经软链进入的目录」才用 realpath 校验（软链在实际 NAS 上很少）。A→B→A 环
  // 在第二次遇到已访问 realpath 时只索引不递归，避免死循环/栈溢出。
  const walk = async (dir, depth, visited, viaSymlink) => {
    if (fileTotal >= SCAN_MAX_FILES && dirTotal >= SCAN_MAX_DIRS) return;
    if (depth > SCAN_MAX_DEPTH) return;
    // 仅经软链进入的目录做环检测（realpath 开销只发生在软链上）
    if (viaSymlink) {
      let realDir;
      try {
        realDir = await fs.realpath(dir);
      } catch (_) {
        realDir = dir; // 极端断链：退回原始路径，至少本次能跑完
      }
      if (visited.has(realDir)) return; // 环：已递归过，仅索引上层、不向下
      visited.add(realDir);
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 权限不足等错误不应阻塞整个扫描，但必须可追踪（v0.1.18：原 catch (_) 静默吞掉，
      // 导致 99.97% 漏扫时管理员完全无感知）。按错误类型分类告警，便于定位为何索引量骤降。
      if (err.code === 'EACCES') {
        console.warn(`[Aurafile] 索引跳过（权限不足）：${dir}`);
      } else if (err.code === 'ENOENT') {
        console.warn(`[Aurafile] 索引跳过（路径不存在）：${dir}`);
      } else if (err.code === 'ELOOP') {
        console.warn(`[Aurafile] 索引跳过（符号链环路）：${dir}`);
      } else {
        console.warn(`[Aurafile] 索引跳过（${err.code || '未知错误'}）：${dir}`);
      }
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full)) continue;
        // v0.1.16：索引目录本身（目录名可搜索），与文件分开预算，互不挤占
        if (dirTotal < SCAN_MAX_DIRS) {
          pendingDirs.push(full);
          dirTotal++;
          if (pendingDirs.length >= SCAN_DIR_BATCH) {
            await flushDirs();
            await new Promise((r) => setTimeout(r, SCAN_YIELD_MS)); // 让出事件循环，避免内存累积 OOM
          }
        }
        await walk(full, depth + 1, visited, false);
      } else if (e.isFile()) {
        if (fileTotal >= SCAN_MAX_FILES) continue;
        pending.push(full);
        fileTotal++;
        if (pending.length >= SCAN_BATCH) {
          await flush();
          await new Promise((r) => setTimeout(r, SCAN_YIELD_MS)); // 让出事件循环，避免内存累积 OOM
        }
      } else if (e.isSymbolicLink()) {
        // v0.1.17：跟随软链判定真实类型；断链/无权限则跳过
        let st;
        try {
          st = await fs.stat(full); // 跟随软链
        } catch (_) {
          continue;
        }
        if (st.isDirectory()) {
          if (!isExcluded(full)) {
            // 索引软链目录自身（path 存软链路径如 /data/link，使搜索该软链名可命中）
            if (dirTotal < SCAN_MAX_DIRS) {
              pendingDirs.push(full);
              dirTotal++;
              if (pendingDirs.length >= SCAN_DIR_BATCH) {
                await flushDirs();
                await new Promise((r) => setTimeout(r, SCAN_YIELD_MS));
              }
            }
            // 环检测：仅当真实目录未访问过才递归其内部（防 A→B→A 死循环）
            let realFull;
            try { realFull = await fs.realpath(full); } catch (_) { realFull = full; }
            if (!visited.has(realFull)) {
              await walk(full, depth + 1, visited, true);
            }
          }
        } else if (st.isFile()) {
          if (fileTotal >= SCAN_MAX_FILES) continue;
          pending.push(full);
          fileTotal++;
          if (pending.length >= SCAN_BATCH) {
            await flush();
            await new Promise((r) => setTimeout(r, SCAN_YIELD_MS));
          }
        }
      }
      if (fileTotal >= SCAN_MAX_FILES && dirTotal >= SCAN_MAX_DIRS) return;
    }
  };
  try {
    await walk(cfg.ROOT, 0, new Set(), false);
    await flush();
    await flushDirs();
    console.log(`[Aurafile] 初始索引完成：扫描 ${fileTotal} 个文件，${dirTotal} 个目录`);
  } catch (e) {
    // 扫描失败不得让进程崩溃——服务仍应正常起来，依赖 watcher 增量补充
    console.error('[Aurafile] 初始索引部分失败（已跳过，服务继续）：', e.message);
  }
}

let watcher = null;
let pending = new Set();
let timer = null;

function flush() {
  const batch = [...pending];
  pending.clear();
  for (const f of batch) {
    if (f.action === 'unlinkDir') unindex(f.path);
    else if (f.action === 'addDir') indexDir(f.path); // v0.1.16：新目录入库，使其可被搜索
    else if (f.action === 'unlink') unindex(f.path);
    else indexFile(f.path);
  }
}

function schedule(file, action) {
  pending.add({ path: file, action });
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 800); // 去抖 800ms
}

function start() {
  // 初始扫描在后台进行，失败不影响 HTTP 服务起来
  initialScan()
    .catch((e) => console.error('[Aurafile] 初始索引启动失败：', e.message))
    .then(() => {
      try {
        watcher = chokidar.watch(cfg.ROOT, {
          ignoreInitial: true,
          ignored: (p) => isExcluded(p),
          depth: 20,
          followSymlinks: true, // v0.1.17：让新建软链目录触发 addDir→入库、删除触发 unlinkDir→移除
          persistent: true,
        });
        watcher
          .on('error', (e) => console.error('[Aurafile] 文件监听错误（增量索引可能不完整）：', e.message))
          .on('add', (p) => schedule(p, 'add'))
          .on('change', (p) => schedule(p, 'change'))
          .on('unlink', (p) => schedule(p, 'unlink'))
          .on('addDir', (p) => schedule(p, 'addDir'))       // v0.1.16：新目录入库
          .on('unlinkDir', (p) => schedule(p, 'unlinkDir')); // v0.1.16：删除目录同步移除
      } catch (e) {
        console.error('[Aurafile] 文件监听启动失败（增量索引不可用，但 HTTP 服务正常）：', e.message);
      }
    });
  return watcher;
}

function stop() {
  if (watcher) watcher.close();
}

module.exports = { start, stop, indexFile, indexDir, indexItem, unindex, initialScan };
