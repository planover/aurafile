'use strict';
// Aurafile 冒烟测试：真实启动服务并调用各 API，验证端到端可用。
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-root-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-data-'));
process.env.AURAFILE_ROOT = ROOT;
process.env.AURAFILE_DATA = DATA;
process.env.PORT = '8099';

// 预置测试文件
fs.ensureDirSync(path.join(ROOT, 'sub'));
fs.writeFileSync(path.join(ROOT, 'hello.txt'), 'hello aurafile\n');
fs.writeFileSync(path.join(ROOT, 'note.md'), 'dreamy soft offline file manager\n');
fs.writeFileSync(path.join(ROOT, 'sub', 'deep.txt'), 'nested content for fulltext search keyword zebra\n');
fs.writeFileSync(path.join(ROOT, 'big.bin'), Buffer.alloc(1024));

const BASE = 'http://127.0.0.1:8099';
const j = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  const b = await r.json().catch(() => ({}));
  return { status: r.status, body: b };
};
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? JSON.stringify(extra) : ''); }
}

(async () => {
  require('../server.js');
  await new Promise((r) => setTimeout(r, 1800)); // 等初始索引扫描

  console.log('— 元信息 / 健康检查 —');
  let r = await j('/api/health'); check('health', r.status === 200 && r.body.ok);
  r = await j('/api/version'); check('version 含 offline 标记', r.body.offline === true && r.body.repo === 'planover/aurafile');
  r = await j('/api/about'); check('about 含 github 链接', /github\.com\/planover\/aurafile/.test(r.body.github));

  console.log('— 浏览 / 搜索 —');
  r = await j('/api/browse?path=.'); check('browse 列出文件', r.body.ok && r.body.items.length >= 3, r.body);
  r = await j('/api/search?q=zebra'); check('全文搜索命中 deep.txt', r.body.items.some((x) => x.name === 'deep.txt'), r.body);
  r = await j('/api/search?type=doc'); check('按类型筛选 doc', r.body.items.every((x) => x.kind === 'doc'));

  console.log('— 文件操作 —');
  r = await post('/api/rename', { path: 'hello.txt', name: 'hi.txt' });
  check('重命名', r.body.ok && r.body.path === 'hi.txt');
  r = await j('/api/browse?path=.'); check('重命名后原文件消失', !r.body.items.some((x) => x.name === 'hello.txt'));

  r = await post('/api/copy', { paths: ['hi.txt'] });
  r = await post('/api/paste', {});
  check('复制粘贴生成副本', r.body.ok);
  r = await j('/api/browse?path=.'); check('存在 hi.txt 与 hi(1).txt 或类似', r.body.items.filter((x) => x.name.startsWith('hi')).length >= 2);

  r = await post('/api/trash', { path: 'note.md' });
  check('删除至回收站', r.body.ok);
  r = await j('/api/trash'); check('回收站可见 note.md', r.body.items.some((x) => x.original === 'note.md'));

  r = await post('/api/undo'); check('撤销（还原回收站）', r.body.ok);
  r = await j('/api/browse?path=.'); check('撤销后 note.md 回到目录', r.body.items.some((x) => x.name === 'note.md'));

  // F-03 回归：回收站还原接口不得接受越界名称（路径穿越）
  r = await post('/api/trash', { path: 'note.md' });
  r = await post('/api/trash/restore', { name: '../../../../etc/shadow', dir: '.' });
  check('还原接口拒绝越界名称（F-03）', r.status === 400, r.body);
  await post('/api/undo'); // 把 note.md 还原回 ROOT，供后续压缩测试使用

  console.log('— 压缩 / 解压 —');
  r = await post('/api/archive', { format: 'zip', entries: ['hi.txt', 'note.md'], dest: 'pack.zip' });
  check('创建 zip', r.body.ok && fs.existsSync(path.join(ROOT, 'pack.zip')));
  fs.ensureDirSync(path.join(ROOT, 'unpacked'));
  r = await post('/api/extract', { archive: 'pack.zip', dest: 'unpacked' });
  check('解压 zip', r.body.ok && fs.existsSync(path.join(ROOT, 'unpacked', 'hi.txt')));

  console.log('— EXIF —');
  r = await j('/api/exif?path=hi.txt'); check('exif 接口可用（无崩溃）', r.body.ok === true || r.body.ok === false);

  console.log('— 路径穿越防护 —');
  r = await j('/api/browse?path=../../etc');
  check('越界路径被拒绝', r.status === 400, r.body);

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟测试异常：', e); process.exit(2); });
