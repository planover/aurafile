'use strict';
const path = require('path');
const exifr = require('exifr');

// 读取 EXIF / 元数据。返回扁平化键值对（值可序列化）。
async function readExif(filePath) {
  try {
    const raw = await exifr.parse(filePath, { exif: true, ifd0: true, gps: true, xmp: true });
    if (!raw) return { ok: true, tags: {} };
    const tags = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && !(v instanceof Date)) continue; // 跳过嵌套块
      tags[k] = v instanceof Date ? v.toISOString() : v;
    }
    return { ok: true, tags };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 写回（P2）：写前由调用方备份原文件
async function writeExif(filePath, updates) {
  // exifr 仅支持读取；写回需 exiftool。此处预留接口，未启用编辑 UI。
  throw new Error('EXIF 写回为 P2 功能（需 exiftool，且写前自动备份）');
}

module.exports = { readExif, writeExif };
