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

function search({ text, type, minSize, maxSize, from, to, limit = 200, offset = 0 }) {
  const d = getDb();
  const params = [];
  let sql = 'SELECT f.* FROM files f';
  const conds = ['f.mtime >= ?', 'f.mtime <= ?'];
  params.push(from != null ? from : 0, to != null ? to : Date.now() + 1e9);

  if (text && text.trim()) {
    sql += ' JOIN fts ON f.path = fts.path';
    conds.push('fts MATCH ?');
    params.push(text.trim());
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
  sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY f.mtime DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return d.prepare(sql).all(...params);
}

function count() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM files').get().c;
}

function clearAll() {
  const d = getDb();
  d.exec('DELETE FROM files; DELETE FROM fts;');
}

module.exports = { init, getDb, upsert, remove, get, timeline, search, count, clearAll, kindOf };
