'use strict';
const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const yauzl = require('yauzl');
const tar = require('tar');
const { spawn } = require('child_process');
const cfg = require('./config');
const { resolveSafe } = require('./fsops');

// 检查可选二进制是否存在（7z）
function has7z() {
  try {
    require('child_process').execSync('command -v 7z || command -v 7za', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

// 校验解压条目不逃逸目标目录（防 zip slip）
function safeEntryName(name) {
  const p = path.normalize(name);
  if (p.startsWith('..') || path.isAbsolute(p)) return null;
  return p;
}

// 创建压缩包：format ∈ zip | tar.gz | 7z
function create(format, entries, destPath) {
  const dest = resolveSafe(destPath);
  return new Promise((resolve, reject) => {
    if (format === '7z') {
      if (!has7z()) return reject(new Error('当前环境未安装 7z，无法创建 7z 压缩包'));
      const args = ['a', dest, ...entries.map((e) => resolveSafe(e))];
      const child = spawn('7z', args);
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve({ ok: true, path: dest }) : reject(new Error(err || '7z 失败'))));
      return;
    }
    const out = fs.createWriteStream(dest);
    const arc =
      format === 'tar.gz'
        ? archiver('tar', { gzip: true })
        : archiver('zip', { zlib: { level: 6 } });
    out.on('close', () => resolve({ ok: true, path: dest, bytes: arc.pointer() }));
    arc.on('error', reject);
    arc.pipe(out);
    for (const e of entries) {
      const abs = resolveSafe(e);
      const stat = fs.statSync(abs);
      arc.file(abs, { name: path.basename(abs) });
    }
    arc.finalize();
  });
}

// 解压炸弹防护上限
const MAX_EXTRACT_ENTRIES = 200000;
const MAX_EXTRACT_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

// 校验某路径是否仍位于 base 目录内（防 zip/tar/7z slip）
function isInside(base, target) {
  const rel = path.relative(base, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 仅列出 7z 条目路径（不实际写出文件），用于提前拒绝非法条目
function list7zEntries(arc) {
  return new Promise((resolve, reject) => {
    const child = spawn('7z', ['l', '-slt', arc]);
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || '7z 列出条目失败'));
      const names = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^Path\s*=\s*(.*)$/);
        if (m) names.push(m[1]);
      }
      resolve(names);
    });
  });
}

// 安全解压 7z：先列出校验 → 解到临时目录 → 逐项核对真实路径后搬移（F-01 Zip-Slip）
async function extract7zSafe(arc, dest) {
  const entries = await list7zEntries(arc);
  if (entries.length > MAX_EXTRACT_ENTRIES) throw new Error('压缩包条目过多，已拒绝解压');
  for (const e of entries) {
    const norm = path.normalize(e);
    if (norm.startsWith('..') || path.isAbsolute(norm)) {
      throw new Error('7z 含非法路径，已拒绝解压: ' + e);
    }
  }
  const tmp = fs.mkdtempSync(path.join(dest, '.aura-extract-'));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('7z', ['x', '-y', arc, `-o${tmp}`]);
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || '7z 解压失败'))));
    });
    let total = 0, count = 0;
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (!isInside(tmp, full)) throw new Error('7z 解压越界，已中止');
        if (ent.isSymbolicLink()) {
          const link = fs.readlinkSync(full);
          if (!isInside(tmp, path.resolve(path.dirname(full), link))) {
            throw new Error('7z 含逃逸符号链接，已中止');
          }
          continue;
        }
        if (ent.isDirectory()) { walk(full); continue; }
        const rel = path.relative(tmp, full);
        total += fs.statSync(full).size;
        if (total > MAX_EXTRACT_BYTES) throw new Error('解压体积超出上限，已中止');
        if (++count > MAX_EXTRACT_ENTRIES) throw new Error('解压条目过多，已中止');
        const outFile = path.join(dest, rel);
        fs.ensureDirSync(path.dirname(outFile));
        fs.moveSync(full, outFile, { overwrite: true });
      }
    };
    walk(tmp);
    return { ok: true };
  } finally {
    fs.removeSync(tmp);
  }
}

// 解压：自动识别类型
function extract(archivePath, destDir) {
  const arc = resolveSafe(archivePath);
  const dest = resolveSafe(destDir || '.');
  const ext = path.extname(arc).toLowerCase();
  fs.ensureDirSync(dest);
  if (ext === '.zip') return extractZip(arc, dest);
  if (ext === '.gz' || ext === '.tgz' || path.basename(arc).endsWith('.tar.gz')) {
    return tar.x({ file: arc, cwd: dest, strip: 0 }).then(() => ({ ok: true }));
  }
  if (ext === '.7z') {
    if (!has7z()) return Promise.reject(new Error('当前环境未安装 7z，无法解压 7z'));
    return extract7zSafe(arc, dest);
  }
  return Promise.reject(new Error('不支持的压缩格式: ' + ext));
}

function extractZip(arc, dest) {
  let count = 0, total = 0;
  return new Promise((resolve, reject) => {
    yauzl.open(arc, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on('error', reject);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = safeEntryName(entry.fileName);
        if (!name) return zipfile.readEntry(); // 跳过非法条目
        if (++count > MAX_EXTRACT_ENTRIES) { zipfile.close(); return reject(new Error('解压条目过多，已中止')); }
        total += entry.uncompressedSize || 0;
        if (total > MAX_EXTRACT_BYTES) { zipfile.close(); return reject(new Error('解压体积超出上限，已中止')); }
        const target = path.join(dest, name);
        if (/\/$/.test(entry.fileName)) {
          fs.ensureDirSync(target);
          return zipfile.readEntry();
        }
        fs.ensureDirSync(path.dirname(target));
        zipfile.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const out = fs.createWriteStream(target);
          stream.pipe(out);
          out.on('close', () => zipfile.readEntry());
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve({ ok: true }));
    });
  });
}

module.exports = { create, extract, has7z };
