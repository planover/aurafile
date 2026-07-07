'use strict';
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cfg = require('./config');

let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {
  sharp = null;
}

function hasFfmpeg() {
  try {
    require('child_process').execSync('command -v ffmpeg', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function cacheKey(filePath, mtime, size, w) {
  const h = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
  return `${h}_${mtime}_${size}_${w}.jpg`;
}

function fromCache(key) {
  const p = path.join(cfg.THUMB_DIR, key);
  return fs.existsSync(p) ? p : null;
}

// 返回 { buffer, contentType } 或 null（无缩略图能力时）
async function getThumbnail(filePath, width = 320) {
  if (!sharp) return null;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (_) {
    return null;
  }
  if (stat.size > cfg.MAX_THUMB_FILE) return null;

  const key = cacheKey(filePath, stat.mtimeMs, stat.size, width);
  const cached = fromCache(key);
  if (cached) return { buffer: await fs.readFile(cached), contentType: 'image/jpeg' };

  const ext = path.extname(filePath).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.avif', '.heic'].includes(ext);
  const isVideo = ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v'].includes(ext);

  let input = filePath;
  let frameTmp = null;
  try {
    if (isVideo) {
      if (!hasFfmpeg()) return null;
      frameTmp = path.join(cfg.THUMB_DIR, `frame_${key}.png`);
      await new Promise((res, rej) => {
        const child = spawn('ffmpeg', ['-y', '-i', filePath, '-ss', '00:00:01', '-vframes', '1', frameTmp]);
        child.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg 失败'))));
      });
      input = frameTmp;
    } else if (!isImage) {
      return null; // 文档缩略图（P1）暂未实现
    }
    const buf = await sharp(input)
      .rotate() // 按 EXIF 方向自动摆正
      .resize(width, Math.round(width * 1.4), { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    const out = path.join(cfg.THUMB_DIR, key);
    await fs.writeFile(out, buf);
    if (frameTmp) await fs.remove(frameTmp).catch(() => {});
    return { buffer: buf, contentType: 'image/jpeg' };
  } catch (e) {
    if (frameTmp) await fs.remove(frameTmp).catch(() => {});
    return null;
  }
}

// 图片格式互转（P1 基础实现，依赖 sharp）
async function convertImage(filePath, targetExt, destPath) {
  if (!sharp) throw new Error('未安装 sharp，无法转换图片');
  const buf = await sharp(filePath).rotate().toFormat(targetExt.replace(/^\./, '')).toBuffer();
  await fs.ensureDir(path.dirname(destPath));
  await fs.writeFile(destPath, buf);
  return { ok: true, path: destPath };
}

module.exports = { getThumbnail, convertImage, hasFfmpeg };
