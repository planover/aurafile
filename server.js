'use strict';
const path = require('path');
const fs = require('fs-extra');
const express = require('express');
const cfg = require('./src/config');
const db = require('./src/db');
const fsops = require('./src/fsops');
const archive = require('./src/archive');
const thumb = require('./src/thumb');
const exif = require('./src/exif');
const indexer = require('./src/indexer');

try {
  db.init();
} catch (e) {
  // DB 初始化失败只记录，不让进程立即退出（避免容器重启循环）；HTTP 仍可起，便于排查
  console.error('[Aurafile] 数据库初始化失败：', e.message);
}

let hasSharp = false;
try {
  require('sharp');
  hasSharp = true;
} catch (_) {}

const app = express();
app.use(express.json({ limit: '5mb' }));
// 基础安全响应头（F-10）
// 注意：故意不设 X-Frame-Options。fnOS 桌面“窗口化打开”是用 iframe 把 app 嵌进
// 桌面窗口（嵌入源与 app 服务跨源），若设 SAMEORIGIN/DENY，浏览器会拒绝渲染 → 打不开。
// 对照成功案例 nasdash 同样不设该头。保留 nosniff 与 Referrer-Policy 即可。
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// ---------- 工具 ----------
function perms(mode) {
  const f = (m, s) =>
    (m & s ? 'r' : '-') + (m & (s >> 1) ? 'w' : '-') + (m & (s >> 2) ? 'x' : '-');
  const u = f(mode, 0o400),
    g = f(mode >> 3, 0o400),
    o = f(mode >> 6, 0o400);
  const type = (mode & 0o170000) === 0o040000 ? 'd' : '-';
  return type + u + g + o;
}

async function metaFor(p) {
  const st = await fs.stat(p);
  const ext = path.extname(p).replace(/^\./, '').toLowerCase();
  return {
    name: path.basename(p),
    path: path.relative(cfg.ROOT, p),
    isDir: st.isDirectory(),
    size: st.size,
    mtime: st.mtimeMs,
    ctime: st.ctimeMs,
    mode: st.mode,
    perms: perms(st.mode),
    kind: st.isDirectory() ? 'folder' : db.kindOf(ext),
  };
}

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e.code === 'EOUTSIDE') return res.status(400).json({ ok: false, error: e.message });
  // 500 不向客户端泄露内部路径/堆栈（F-08）
  console.error('[Aurafile] 服务端错误:', e);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

// ---------- 静态前端（完全离线，无外链） ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 元信息 / 健康检查 ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/version', (req, res) =>
  res.json({ version: cfg.VERSION, commit: cfg.COMMIT, repo: cfg.REPO, offline: true })
);
app.get('/api/config', (req, res) =>
  res.json({
    root: cfg.ROOT,
    version: cfg.VERSION,
    features: {
      fulltext: true,
      videoThumb: thumb.hasFfmpeg(),
      imageConvert: hasSharp,
      sevenZip: archive.has7z(),
    },
  })
);
app.get('/api/about', (req, res) =>
  res.json({
    name: 'Aurafile',
    tagline: '梦幻柔和的离线 NAS 文件管理器',
    version: cfg.VERSION,
    github: `https://github.com/${cfg.REPO}`,
    repo: cfg.REPO,
    qr: '/about-qr.svg',
    offline: true,
  })
);

// 关于页（独立页面，显式路由，避免依赖静态中间件扩展名回退）
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));

// ---------- 浏览 / 时间轴 / 搜索 ----------
app.get('/api/browse', asyncH(async (req, res) => {
  const p = req.query.path || '/';
  // '/' 解析为 ROOT（避免 path.resolve(ROOT,'/') 越界抛 EOUTSIDE）
  const dir = p === '/' ? cfg.ROOT : fsops.resolveSafe(p);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (cfg.EXCLUDE_DIRS.has(e.name)) continue;
    out.push(await metaFor(path.join(dir, e.name)));
  }
  out.sort((a, b) => (a.isDir === b.isDir ? b.mtime - a.mtime : a.isDir ? -1 : 1));
  res.json({ ok: true, items: out });
}));

app.get('/api/timeline', asyncH(async (req, res) => {
  const q = req.query;
  const rows = db.timeline({
    from: q.from ? +q.from : 0,
    to: q.to ? +q.to : Date.now() + 1e9,
    limit: q.limit ? +q.limit : 500,
    offset: q.offset ? +q.offset : 0,
  });
  res.json({ ok: true, items: rows });
}));

app.get('/api/search', asyncH(async (req, res) => {
  const q = req.query;
  const result = db.search({
    text: q.q,
    type: q.type || 'all',
    minSize: q.minSize ? +q.minSize : null,
    maxSize: q.maxSize ? +q.maxSize : null,
    from: q.from ? +q.from : null,
    to: q.to ? +q.to : null,
    content: q.content === '1' || q.content === 'true',
    limit: q.limit ? +q.limit : 200,
  });
  res.json({ ok: true, items: result.rows, total: result.total });
}));

// 已索引统计（v0.1.16：文件 + 目录）
app.get('/api/stats', asyncH(async (req, res) => {
  const s = db.stats();
  res.json({ ok: true, files: s.files, dirs: s.dirs, total: s.total });
}));

app.get('/api/file', asyncH(async (req, res) => {
  const p = fsops.resolveSafe(req.query.path);
  res.json({ ok: true, file: await metaFor(p) });
}));

// ---------- 文件操作 ----------
app.post('/api/rename', asyncH(async (req, res) => {
  const r = await fsops.rename(req.body.path, req.body.name);
  await indexer.indexItem(fsops.resolveSafe(r.path)); // v0.1.16：目录重命名后按类型重新入库
  res.json({ ok: true, ...r });
}));

app.post('/api/trash', asyncH(async (req, res) => {
  const r = await fsops.trash(req.body.path);
  indexer.unindex(fsops.resolveSafe(req.body.path));
  res.json({ ok: true, ...r });
}));

app.post('/api/delete', asyncH(async (req, res) => {
  await fsops.permanentDelete(req.body.path);
  indexer.unindex(fsops.resolveSafe(req.body.path));
  res.json({ ok: true });
}));

app.post('/api/copy', asyncH(async (req, res) => res.json(fsops.setClipboard(req.body.paths, 'copy'))));
app.post('/api/cut', asyncH(async (req, res) => res.json(fsops.setClipboard(req.body.paths, 'cut'))));
app.post('/api/paste', asyncH(async (req, res) => {
  const r = await fsops.paste(req.body.dir || '.');
  if (r.ok) indexer.initialScan(); // 轻量重扫以刷新索引
  res.json(r);
}));
app.post('/api/undo', asyncH(async (req, res) => res.json(await fsops.undo())));
app.post('/api/redo', asyncH(async (req, res) => res.json(await fsops.redo())));

// 回收站
app.get('/api/trash', asyncH(async (req, res) => res.json({ ok: true, items: await fsops.listTrash() })));
app.post('/api/trash/restore', asyncH(async (req, res) => {
  const r = await fsops.restore(req.body.name, req.body.dir);
  await indexer.initialScan();
  res.json({ ok: true, ...r });
}));

// ---------- 缩略图 / 原文件流 / EXIF ----------
app.get('/api/thumbnail', asyncH(async (req, res) => {
  const p = fsops.resolveSafe(req.query.path);
  const t = await thumb.getThumbnail(p, req.query.w ? +req.query.w : 320);
  if (!t) return res.status(404).json({ ok: false, error: '无缩略图' });
  res.set('Content-Type', t.contentType);
  res.send(t.buffer);
}));

app.get('/api/raw', asyncH(async (req, res) => {
  const p = fsops.resolveSafe(req.query.path);
  const st = await fs.stat(p);
  const range = req.headers.range;
  if (range) {
    const [start, end] = range.replace(/bytes=/, '').split('-').map((n) => (n ? +n : NaN));
    const s = isNaN(start) ? 0 : start;
    const e = isNaN(end) ? st.size - 1 : Math.min(end, st.size - 1);
    // 校验 Range，拒绝非法区间（F-11）
    if (s < 0 || e < s || e >= st.size) {
      return res.status(416).json({ ok: false, error: '非法的 Range 请求' });
    }
    res.status(206).set({
      'Content-Range': `bytes ${s}-${e}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': e - s + 1,
      'Content-Type': 'application/octet-stream',
    });
    fs.createReadStream(p, { start: s, end: e }).pipe(res);
  } else {
    res.set({
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    });
    fs.createReadStream(p).pipe(res);
  }
}));

app.get('/api/exif', asyncH(async (req, res) => res.json(await exif.readExif(fsops.resolveSafe(req.query.path)))));

// ---------- 压缩 / 解压 / 转换 ----------
app.post('/api/archive', asyncH(async (req, res) => {
  const r = await archive.create(req.body.format, req.body.entries, req.body.dest);
  await indexer.initialScan();
  res.json({ ok: true, ...r });
}));
app.post('/api/extract', asyncH(async (req, res) => {
  const r = await archive.extract(req.body.archive, req.body.dest);
  await indexer.initialScan();
  res.json({ ok: true, ...r });
}));
app.post('/api/convert', asyncH(async (req, res) => {
  const r = await thumb.convertImage(
    fsops.resolveSafe(req.body.path),
    req.body.target,
    fsops.resolveSafe(req.body.dest)
  );
  await indexer.indexItem(fsops.resolveSafe(req.body.dest)); // v0.1.16：按类型派发（目录/文件）
  res.json({ ok: true, ...r });
}));

// ---------- 启动 ----------
try {
  indexer.start();
} catch (e) {
  console.error('[Aurafile] 索引器启动失败（HTTP 服务仍正常）：', e.message);
}

const HOST = process.env.AURAFILE_HOST || '0.0.0.0'; // fnOS 窗口代理需从容器外访问 8018；可用 AURAFILE_HOST=127.0.0.1 降级为本机-only
const server = app.listen(cfg.PORT, HOST, () => {
  console.log(`Aurafile v${cfg.VERSION} 已启动：http://${HOST}:${cfg.PORT}`);
  console.log(`管理根目录：${cfg.ROOT} | 数据目录：${cfg.DATA}`);
});

// 端口被占用时给出清晰日志，避免匿名崩溃 + 重启循环
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Aurafile] 端口 ${cfg.PORT} 已被占用，请停止占用该端口的旧容器/进程后重试`);
  } else {
    console.error('[Aurafile] 服务监听失败：', e.message);
  }
  // 不立即 process.exit，交给 restart 策略；日志可助排查
});

module.exports = server;
