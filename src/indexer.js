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

async function unindex(filePath) {
  db.remove(filePath);
}

// 初始全量扫描：分批 + 让出事件循环 + 错误隔离，避免大 NAS 上 OOM 被 kill 导致容器无限重启
const SCAN_BATCH = 200;        // 每批索引文件数
const SCAN_YIELD_MS = 5;       // 每批后让出事件循环，给 GC 与 IO 喘息
const SCAN_MAX_DEPTH = 25;     // 目录递归深度上限，防极深目录栈溢出
const SCAN_MAX_FILES = 500000; // 全量扫描文件数上限，超出则停止（依赖 watcher 增量补充）

async function initialScan() {
  let pending = [];
  let total = 0;
  const flush = async () => {
    const batch = pending;
    pending = [];
    // 并发写入本批，单个失败不影响整体
    await Promise.all(batch.map((f) => indexFile(f).catch(() => {})));
  };
  const walk = async (dir, depth) => {
    if (total >= SCAN_MAX_FILES) return;
    if (depth > SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        pending.push(full);
        total++;
        if (pending.length >= SCAN_BATCH) {
          await flush();
          await new Promise((r) => setTimeout(r, SCAN_YIELD_MS)); // 让出事件循环，避免内存累积 OOM
        }
      }
      if (total >= SCAN_MAX_FILES) return;
    }
  };
  try {
    await walk(cfg.ROOT, 0);
    await flush();
    console.log(`[Aurafile] 初始索引完成：扫描 ${total} 个文件`);
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
    if (f.action === 'unlink') unindex(f.path);
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
          persistent: true,
        });
        watcher
          .on('error', (e) => console.error('[Aurafile] 文件监听错误（增量索引可能不完整）：', e.message))
          .on('add', (p) => schedule(p, 'add'))
          .on('change', (p) => schedule(p, 'change'))
          .on('unlink', (p) => schedule(p, 'unlink'))
          .on('addDir', () => {})
          .on('unlinkDir', (p) => {});
      } catch (e) {
        console.error('[Aurafile] 文件监听启动失败（增量索引不可用，但 HTTP 服务正常）：', e.message);
      }
    });
  return watcher;
}

function stop() {
  if (watcher) watcher.close();
}

module.exports = { start, stop, indexFile, unindex, initialScan };
