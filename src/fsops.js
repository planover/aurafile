'use strict';
const path = require('path');
const fs = require('fs-extra');
const cfg = require('./config');

// ---------- 路径安全：所有用户路径必须落在指定 base 目录内 ----------
function resolveWithin(base, segments) {
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('非法的路径：越出允许目录');
    err.code = 'EOUTSIDE';
    throw err;
  }
  return target;
}

// 默认以 ROOT 为基准（保留旧调用签名）
function resolveSafe(...segments) {
  return resolveWithin(cfg.ROOT, segments);
}

// ---------- 操作日志 / 撤销重做 ----------
// 每个 entry = { revert, replay }
//   revert : 撤销该操作（回到操作前状态）
//   replay: 重做该操作（再次执行）
const undoStack = [];
const redoStack = [];

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

async function undo() {
  const entry = undoStack.pop();
  if (!entry) return { ok: false, reason: '没有可撤销的操作' };
  if (entry.revert) await entry.revert();
  redoStack.push(entry);
  return { ok: true };
}

async function redo() {
  const entry = redoStack.pop();
  if (!entry) return { ok: false, reason: '没有可重做的操作' };
  if (entry.replay) await entry.replay();
  undoStack.push(entry);
  return { ok: true };
}

// ---------- 重命名 ----------
async function rename(oldPath, newName) {
  const abs = resolveSafe(oldPath);
  const dir = path.dirname(abs);
  const dest = path.join(dir, path.basename(newName));
  if (dest === abs) return { ok: true };
  await fs.rename(abs, dest);
  pushUndo({
    revert: () => fs.rename(dest, abs),
    replay: () => fs.rename(abs, dest),
  });
  return { ok: true, path: path.relative(cfg.ROOT, dest) };
}

// ---------- 删除至回收站 ----------
async function trash(filePath) {
  const abs = resolveSafe(filePath);
  const meta = await fs.stat(abs);
  const stamp = Date.now();
  const safeName = path.basename(abs).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const dest = path.join(cfg.TRASH_DIR, `${stamp}_${safeName}`);
  await fs.ensureDir(cfg.TRASH_DIR);
  await fs.move(abs, dest, { overwrite: false });
  pushUndo({
    revert: () => fs.move(dest, abs, { overwrite: false }), // 撤销 = 还原
    replay: () => fs.move(abs, dest, { overwrite: false }), // 重做 = 再丢回收站
  });
  return { ok: true, trashed: path.basename(dest), size: meta.size };
}

// ---------- 彻底删除（不可撤销） ----------
async function permanentDelete(filePath) {
  const abs = resolveSafe(filePath);
  await fs.remove(abs);
  // 彻底删除无法恢复，不写入撤销栈
  return { ok: true };
}

// ---------- 复制 / 粘贴 ----------
let clipboard = null; // { paths: [...], op: 'copy' | 'cut' }

function setClipboard(paths, op) {
  clipboard = { paths: paths.map((p) => path.relative(cfg.ROOT, resolveSafe(p))), op };
  return { ok: true };
}

function getClipboard() {
  return clipboard;
}

// 同名冲突时自动加 " (1)" / " (2)" 后缀，避免覆盖或自拷贝失败
function uniqueName(dir, name) {
  let cand = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, cand))) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    cand = `${base} (${i})${ext}`;
    i++;
  }
  return cand;
}

async function paste(destDir) {
  if (!clipboard) return { ok: false, reason: '剪贴板为空' };
  const base = resolveSafe(destDir || '.');
  for (const rel of clipboard.paths) {
    const src = resolveSafe(rel);
    const dest = path.join(base, uniqueName(base, path.basename(src)));
    if (clipboard.op === 'copy') {
      await fs.copy(src, dest, { overwrite: false, preserveTimestamps: true });
      pushUndo({
        revert: () => fs.remove(dest),
        replay: () => fs.copy(src, dest, { overwrite: false, preserveTimestamps: true }),
      });
    } else {
      await fs.move(src, dest, { overwrite: false });
      pushUndo({
        revert: () => fs.move(dest, src, { overwrite: false }),
        replay: () => fs.move(src, dest, { overwrite: false }),
      });
    }
  }
  const wasCut = clipboard.op === 'cut';
  if (wasCut) clipboard = null; // 剪切粘贴后清空
  return { ok: true, op: clipboard ? 'copy' : 'cut' };
}

// ---------- 还原（从回收站） ----------
async function restore(trashName, destDir) {
  // 关键：trashName 必须先约束在 TRASH_DIR 内，拒绝任何 ../ 或绝对路径，
  // 否则可借机读取/移动 ROOT 之外的任意文件（安全审计 F-03 路径穿越）。
  const src = resolveWithin(cfg.TRASH_DIR, [trashName]);
  const destBase = resolveSafe(destDir || '.');
  const dest = path.join(destBase, uniqueName(destBase, trashName.replace(/^\d+_/, '')));
  await fs.move(src, dest, { overwrite: false });
  pushUndo({
    revert: () => fs.move(dest, src, { overwrite: false }), // 撤销还原 = 重新进回收站
    replay: () => fs.move(src, dest, { overwrite: false }),
  });
  return { ok: true, restored: path.relative(cfg.ROOT, dest) };
}

async function listTrash() {
  const items = await fs.readdir(cfg.TRASH_DIR);
  return items.map((n) => {
    const p = path.join(cfg.TRASH_DIR, n);
    let mtime = null;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch (_) {}
    return { name: n, original: n.replace(/^\d+_/, ''), mtime };
  });
}

module.exports = {
  resolveSafe,
  rename,
  trash,
  permanentDelete,
  setClipboard,
  getClipboard,
  paste,
  restore,
  listTrash,
  undo,
  redo,
};
