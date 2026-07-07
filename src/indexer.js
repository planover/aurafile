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

// 初始全量扫描（带去抖，避免一次性打满 IO）
async function initialScan() {
  const walk = async (dir) => {
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
        await walk(full);
      } else if (e.isFile()) {
        await indexFile(full);
      }
    }
  };
  await walk(cfg.ROOT);
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
  initialScan().then(() => {
    watcher = chokidar.watch(cfg.ROOT, {
      ignoreInitial: true,
      ignored: (p) => isExcluded(p),
      depth: 99,
      persistent: true,
    });
    watcher
      .on('add', (p) => schedule(p, 'add'))
      .on('change', (p) => schedule(p, 'change'))
      .on('unlink', (p) => schedule(p, 'unlink'))
      .on('addDir', () => {})
      .on('unlinkDir', (p) => {
        // 目录下文件由 unlink 事件逐条处理；此处仅占位
      });
  });
  return watcher;
}

function stop() {
  if (watcher) watcher.close();
}

module.exports = { start, stop, indexFile, unindex, initialScan };
