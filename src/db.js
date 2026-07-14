'use strict';
const path = require('path');
const fs = require('fs-extra');
const Database = require('better-sqlite3');
const cfg = require('./config');

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
  `);
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
  const now = Date.now();
  d.prepare(
    `INSERT INTO files (path, name, ext, kind, size, mtime, ctime, mode, indexed_at)
     VALUES (@path, @name, @ext, @kind, @size, @mtime, @ctime, @mode, @indexed_at)
     ON CONFLICT(path) DO UPDATE SET
       name=@name, ext=@ext, kind=@kind, size=@size, mtime=@mtime, ctime=@ctime, mode=@mode, indexed_at=@indexed_at`
  ).run({ ...meta, ext, kind, indexed_at: now });

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
    conds.push('f.kind = ?');
    params.push(type);
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
  sql += ' ORDER BY f.mtime DESC LIMIT ? OFFSET ?';
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

function clearAll() {
  const d = getDb();
  d.exec('DELETE FROM files; DELETE FROM fts;');
}

module.exports = { init, getDb, upsert, remove, get, timeline, search, count, clearAll, kindOf };
