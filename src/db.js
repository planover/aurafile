'use strict';
const path = require('path');
const fs = require('fs-extra');
const Database = require('better-sqlite3');
const cfg = require('./config');
// v0.1.18：跨版本升级检测。以 package.json 的 version 为权威版本源，
// 发版门神 bump 版本号后，旧库记录落后于新版本即触发全量重建提示。
const APP_VERSION = require('../package.json').version;

let db;

function ensureDirs() {
  fs.ensureDirSync(cfg.TRASH_DIR);
  fs.ensureDirSync(cfg.THUMB_DIR);
}

function init() {
  ensureDirs();
  db = new Database(cfg.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path      TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      ext       TEXT,
      kind      TEXT,            -- image / video / doc / audio / archive / other
      size      INTEGER,
      mtime     INTEGER,
      ctime     INTEGER,
      mode      INTEGER,
      isDir     INTEGER NOT NULL DEFAULT 0,  -- v0.1.16：是否为目录（目录名也可被搜索，Everything 式）
      indexed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);

    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      path,
      name,
      content,
      tokenize = 'unicode61'
    );

    -- v0.1.18：元数据表，记录索引库的 schema/应用版本，用于跨版本升级检测
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // v0.1.16：目录名可搜索。兼容旧库——若 files 表缺 isDir 列则补齐（ALTER 不破坏已有数据）。
  // 新库已在 CREATE 中加入该列；此处仅对升级用户生效。
  const _fileCols = db.pragma('table_info(files)');
  if (!_fileCols.some((c) => c.name === 'isDir')) {
    db.exec('ALTER TABLE files ADD COLUMN isDir INTEGER NOT NULL DEFAULT 0');
    // 旧库曾把目录以 kind='folder' 入库但未标 isDir，补齐标记使其可被搜索
    db.exec("UPDATE files SET isDir = 1 WHERE kind = 'folder'");
  }
  // v0.1.18：版本/旧库检测。跨版本升级、或旧库无版本标记（老用户从 0.1.17 及之前升级）时，
  // 索引数据可能来自旧的权限/旧 schema，可能包含残留或漏扫记录，会误导前端 stats。
  // 打印一次警告，提示管理员到设置清空索引并重启以全量重建；不自动清除（破坏性操作交由用户决定）。
  const META_KEY = 'schema_version';
  let storedRow = null;
  try {
    storedRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
  } catch (_) {
    storedRow = null; // meta 表极端情况下缺失，降级为无版本记录处理
  }
  const existingCount = db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
  if (!storedRow) {
    if (existingCount > 0) {
      console.warn(
        `[Aurafile] 检测到旧版索引数据库（${existingCount} 条记录，无版本标记）；` +
        `本次升级修复了权限漏扫问题，建议到设置清空索引并重启以全量重建，避免旧数据干扰。`
      );
    }
  } else if (storedRow.value !== APP_VERSION) {
    console.warn(
      `[Aurafile] 索引数据库来自 v${storedRow.value}，当前 v${APP_VERSION}；` +
      `若搜索结果异常，请到设置清空索引并重启以全量重建。`
    );
  }
  // 记录当前版本，供下次升级时对比
  db.prepare(
    'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(META_KEY, APP_VERSION);
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

function kindOf(ext, mime) {
  ext = (ext || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'avif', 'svg', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'flv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub'].includes(ext)) return 'doc';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz'].includes(ext)) return 'archive';
  return 'other';
}

function upsert(meta) {
  const d = getDb();
  const ext = path.extname(meta.path).replace(/^\./, '');
  const kind = meta.kind || kindOf(ext);
  const isDir = meta.isDir ? 1 : 0;
  const now = Date.now();
  d.prepare(
    `INSERT INTO files (path, name, ext, kind, size, mtime, ctime, mode, isDir, indexed_at)
     VALUES (@path, @name, @ext, @kind, @size, @mtime, @ctime, @mode, @isDir, @indexed_at)
     ON CONFLICT(path) DO UPDATE SET
       name=@name, ext=@ext, kind=@kind, size=@size, mtime=@mtime, ctime=@ctime, mode=@mode, isDir=@isDir, indexed_at=@indexed_at`
  ).run({ ...meta, ext, kind, isDir, indexed_at: now });

  if (typeof meta.content === 'string') {
    d.prepare('DELETE FROM fts WHERE path = ?').run(meta.path);
    d.prepare('INSERT INTO fts (path, name, content) VALUES (?, ?, ?)').run(
      meta.path,
      meta.name,
      meta.content.slice(0, cfg.MAX_INDEX_TEXT)
    );
  }
}

function remove(filePath) {
  const d = getDb();
  d.prepare('DELETE FROM fts WHERE path = ?').run(filePath);
  d.prepare('DELETE FROM files WHERE path = ?').run(filePath);
}

function get(filePath) {
  return getDb().prepare('SELECT * FROM files WHERE path = ?').get(filePath);
}

// 时间轴：按 mtime 倒序返回区间内文件
function timeline({ from = 0, to = Date.now() + 1e9, limit = 500, offset = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM files WHERE mtime >= ? AND mtime <= ? ORDER BY mtime DESC LIMIT ? OFFSET ?')
    .all(from, to, limit, offset);
}

// 转义 LIKE 通配符，避免用户输入的 % 或 _ 被当成通配
function escapeLike(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// Everything 式搜索：以「文件名子串匹配」为主（中英文/大小写不敏感，LIKE '%term%'），
// FTS5 全文内容搜索降级为可选增强（仅显式开启时，且对特殊字符清洗防 SQL 语法错）。
function search({ text, type, minSize, maxSize, from, to, content = false, limit = 200, offset = 0 }) {
  const d = getDb();
  const params = [];
  const conds = ['f.mtime >= ?', 'f.mtime <= ?'];
  params.push(from != null ? from : 0, to != null ? to : Date.now() + 1e9);

  let joinFts = false;
  if (text && text.trim()) {
    const t = text.trim();
    const parts = [];
    // 主匹配：文件名子串（支持中文，因为 SQLite LIKE 按字符匹配）
    parts.push('f.name LIKE ? ESCAPE \'\\\'');
    params.push('%' + escapeLike(t) + '%');
    // 可选增强：文件内容全文（FTS5），仅当显式开启；用双引号包成短语查询并剥离引号防注入
    if (content) {
      const safe = t.replace(/["*():^]/g, ' ').trim();
      if (safe) {
        joinFts = true;
        parts.push('fts MATCH ?');
        params.push('"' + safe.replace(/"/g, '') + '"');
      }
    }
    conds.push('(' + parts.join(' OR ') + ')');
  }
  if (type && type !== 'all') {
    // v0.1.17：时间轴分段「仅文件 / 仅文件夹」按 isDir 判定；
    // 其余 MIME 类型（image/video/doc/…）仍按 kind 过滤（来自筛选栏）。
    if (type === 'folder') {
      conds.push('f.isDir = 1');
    } else if (type === 'file') {
      conds.push('f.isDir = 0');
    } else {
      conds.push('f.kind = ?');
      params.push(type);
    }
  }
  if (minSize != null) {
    conds.push('f.size >= ?');
    params.push(minSize);
  }
  if (maxSize != null) {
    conds.push('f.size <= ?');
    params.push(maxSize);
  }

  let sql = 'SELECT f.* FROM files f';
  if (joinFts) sql += ' LEFT JOIN fts ON f.path = fts.path';
  sql += ' WHERE ' + conds.join(' AND ');
  // v0.1.16：目录排在文件前（与 Everything 一致），再按修改时间倒序
  sql += ' ORDER BY f.isDir DESC, f.mtime DESC LIMIT ? OFFSET ?';
  const rows = d.prepare(sql).all(...params, limit, offset);

  // 总数（复用车条件，不含 LIMIT/OFFSET）
  let totalSql = 'SELECT COUNT(*) AS c FROM files f';
  if (joinFts) totalSql += ' LEFT JOIN fts ON f.path = fts.path';
  totalSql += ' WHERE ' + conds.join(' AND ');
  const total = d.prepare(totalSql).get(...params).c;

  return { rows, total };
}

function count() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM files').get().c;
}

// v0.1.16：已索引统计（文件 + 目录）
function stats() {
  const d = getDb();
  const files = d.prepare("SELECT COUNT(*) AS c FROM files WHERE isDir = 0 OR isDir IS NULL").get().c;
  const dirs = d.prepare('SELECT COUNT(*) AS c FROM files WHERE isDir = 1').get().c;
  return { files, dirs, total: files + dirs };
}

function clearAll() {
  const d = getDb();
  d.exec('DELETE FROM files; DELETE FROM fts;');
}

module.exports = { init, getDb, upsert, remove, get, timeline, search, count, stats, clearAll, kindOf };
