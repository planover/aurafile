'use strict';
const path = require('path');
const fs = require('fs');

// ---- 运行时配置（全部来自环境变量，便于 fpk/Docker 注入） ----
const ROOT = process.env.AURAFILE_ROOT || '/data';
const PORT = parseInt(process.env.PORT || '8011', 10);

// 应用数据目录（索引库 / 回收站 / 缩略图缓存）。优先使用独立配置卷，避免污染用户数据。
const DATA =
  process.env.AURAFILE_DATA ||
  (fs.existsSync('/config') ? path.join('/config', 'aurafile') : path.join(process.cwd(), '.aurafile-data'));

const TRASH_DIR = path.join(DATA, 'trash');
const THUMB_DIR = path.join(DATA, 'thumbs');
const DB_PATH = path.join(DATA, 'index.db');

// 容器内运行身份映射（避免 NAS 文件属主权限问题）
const APP_UID = process.env.AURAFILE_UID ? parseInt(process.env.AURAFILE_UID, 10) : null;
const APP_GID = process.env.AURAFILE_GID ? parseInt(process.env.AURAFILE_GID, 10) : null;

const VERSION = require('../package.json').version;
const COMMIT = process.env.AURAFILE_COMMIT || 'dev';
const REPO = 'planover/aurafile';

// 触发缩略图/文本抽取的大小上限（字节），防止巨型文件拖垮索引
const MAX_INDEX_TEXT = 5 * 1024 * 1024; // 5MB
const MAX_THUMB_FILE = 50 * 1024 * 1024; // 50MB

// 不应被索引/展示的隐藏目录（应用自身数据）
const EXCLUDE_DIRS = new Set(['.aurafile', '.aurafile-data', '.git', 'node_modules']);

module.exports = {
  ROOT,
  PORT,
  DATA,
  TRASH_DIR,
  THUMB_DIR,
  DB_PATH,
  APP_UID,
  APP_GID,
  VERSION,
  COMMIT,
  REPO,
  MAX_INDEX_TEXT,
  MAX_THUMB_FILE,
  EXCLUDE_DIRS,
};
