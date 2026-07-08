'use strict';
// Aurafile 前端逻辑（完全离线，仅调用本地 API）

const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('请求失败 ' + r.status));
  return j;
};
const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// HTML 转义，防止文件名/路径/EXIF 内容造成存储型 XSS（F-05）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

let state = {
  selected: new Set(),
  filters: { q: '', type: 'all', minSize: null, maxSize: null, from: null, to: null },
};

const ICONS = { image: '🖼️', video: '🎬', doc: '📄', audio: '🎵', archive: '🗜️', folder: '📁', other: '📦' };

// ---------- 时间轴分组 ----------
function bucketOf(mtime) {
  const d = new Date(mtime);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86400000;
  const diff = startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (diff <= 0) return '今天';
  if (diff === day) return '昨天';
  if (diff <= 7 * day) return '本周';
  if (diff <= 30 * day) return '本月';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 渲染时间轴 ----------
async function loadTimeline() {
  const tl = $('#timeline');
  tl.innerHTML = '<div class="empty">加载中…</div>';
  let items;
  const f = state.filters;
  if (f.q || f.type !== 'all' || f.minSize != null || f.maxSize != null || f.from || f.to) {
    const q = new URLSearchParams();
    if (f.q) q.set('q', f.q);
    if (f.type !== 'all') q.set('type', f.type);
    if (f.minSize != null) q.set('minSize', f.minSize * 1048576);
    if (f.maxSize != null) q.set('maxSize', f.maxSize * 1048576);
    if (f.from) q.set('from', new Date(f.from).getTime());
    if (f.to) q.set('to', new Date(f.to).getTime() + 86400000);
    const r = await api('/api/search?' + q.toString());
    items = r.items.map((x) => ({ ...x, mtime: x.mtime }));
  } else {
    const r = await api('/api/timeline?limit=800');
    items = r.items;
  }
  renderGroups(items);
}

function renderGroups(items) {
  const tl = $('#timeline');
  tl.innerHTML = '';
  if (!items.length) {
    tl.innerHTML = '<div class="empty">这里还没有文件，或没有匹配结果 🌥️</div>';
    return;
  }
  const groups = new Map();
  for (const it of items) {
    const b = bucketOf(it.mtime);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(it);
  }
  for (const [label, list] of groups) {
    const g = document.createElement('div');
    g.className = 'tl-group';
    g.innerHTML = `<div class="tl-label">${label}</div>`;
    const grid = document.createElement('div');
    grid.className = 'tl-grid';
    for (const it of list) grid.appendChild(fileCard(it));
    g.appendChild(grid);
    tl.appendChild(g);
  }
}

function fileCard(it) {
  const card = document.createElement('div');
  card.className = 'file-card' + (state.selected.has(it.path) ? ' selected' : '');
  const icon = ICONS[it.kind] || ICONS.other;
  let inner;
  if (it.kind === 'image' || it.kind === 'video') {
    inner = `<div class="thumb"><img loading="lazy" src="/api/thumbnail?path=${encodeURIComponent(it.path)}&w=320" onerror="this.parentNode.textContent='${icon}'"></div>`;
  } else {
    inner = `<div class="thumb">${icon}</div>`;
  }
  card.innerHTML =
    inner +
    `<div class="name" title="${esc(it.name)}">${esc(it.name)}</div>` +
    `<div class="meta">${it.isDir ? '文件夹' : fmtSize(it.size)} · ${fmtDate(it.mtime).slice(0, 10)}</div>`;
  card.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(it.path, card);
    } else if (it.isDir) {
      // 进入文件夹：以该目录为根重新浏览（简化：直接打开详情）
      openDetail(it);
    } else {
      selectOnly(it.path, card);
    }
  });
  return card;
}

// ---------- 选择 ----------
function clearSelection() { state.selected.clear(); }
function selectOnly(path, card) {
  document.querySelectorAll('.file-card.selected').forEach((c) => c.classList.remove('selected'));
  state.selected.clear(); state.selected.add(path);
  card.classList.add('selected'); updateToolbar();
}
function toggleSelect(path, card) {
  if (state.selected.has(path)) { state.selected.delete(path); card.classList.remove('selected'); }
  else { state.selected.add(path); card.classList.add('selected'); }
  updateToolbar();
}
function updateToolbar() {
  const tb = $('#toolbar');
  const n = state.selected.size;
  $('#selCount').textContent = `已选 ${n} 项`;
  tb.hidden = n === 0;
}

// ---------- 详情面板 ----------
async function openDetail(it) {
  const panel = $('#detail');
  const body = $('#detailBody');
  body.innerHTML = '<div class="empty">加载中…</div>';
  panel.hidden = false;
  let meta = it;
  if (!it.size && !it.perms) {
    try { meta = (await api('/api/file?path=' + encodeURIComponent(it.path))).file; } catch (_) {}
  }
  let html = '';
  if (meta.kind === 'image') {
    html += `<img class="detail-preview" src="/api/thumbnail?path=${encodeURIComponent(meta.path)}&w=320" onerror="this.style.display='none'">`;
  }
  html += kv('名称', meta.name) + kv('路径', '/' + meta.path) + kv('类型', meta.kind);
  if (!meta.isDir) {
    html += kv('大小', fmtSize(meta.size));
    html += kv('修改时间', fmtDate(meta.mtime)) + kv('创建时间', fmtDate(meta.ctime));
    html += kv('权限', meta.perms || '');
  }
  body.innerHTML = html;

  if (meta.kind === 'image') {
    try {
      const ex = await api('/api/exif?path=' + encodeURIComponent(meta.path));
      if (ex.ok && ex.tags && Object.keys(ex.tags).length) {
        let exHtml = '<h4 style="margin:16px 0 6px;color:var(--text-1)">EXIF</h4>';
        const want = ['Make', 'Model', 'DateTimeOriginal', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength', 'Software', 'Orientation', 'ImageWidth', 'ImageHeight', 'GPSLatitude', 'GPSLongitude'];
        for (const k of want) if (ex.tags[k] != null) exHtml += kv(k, String(ex.tags[k]));
        body.insertAdjacentHTML('beforeend', exHtml);
      }
    } catch (_) {}
  }
}
function kv(k, v) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v ?? '')}</span></div>`; }

// ---------- 操作 ----------
async function doAction(act) {
  const paths = [...state.selected];
  if (!paths.length && !['paste', 'undo', 'redo'].includes(act)) return toast('请先选择文件');
  try {
    if (act === 'rename') {
      const name = await promptText('重命名为', paths[0].split('/').pop());
      if (!name) return;
      await post('/api/rename', { path: paths[0], name });
    } else if (act === 'copy') {
      await post('/api/copy', { paths }); return toast('已复制');
    } else if (act === 'cut') {
      await post('/api/cut', { paths }); return toast('已剪切');
    } else if (act === 'paste') {
      await post('/api/paste', {}); return toast('已粘贴');
    } else if (act === 'trash') {
      for (const p of paths) await post('/api/trash', { path: p });
      toast('已移至回收站');
    } else if (act === 'delete') {
      if (!confirm('彻底删除不可恢复，确定？')) return;
      for (const p of paths) await post('/api/delete', { path: p });
      toast('已彻底删除');
    } else if (act === 'undo') { await post('/api/undo'); return toast('已撤销'); }
    else if (act === 'redo') { await post('/api/redo'); return toast('已重做'); }
    else if (act === 'archive') {
      const name = await promptText('压缩包名称（不含扩展名）', 'archive');
      if (!name) return;
      const fmt = 'zip';
      await post('/api/archive', { format: fmt, entries: paths, dest: (paths[0].includes('/') ? paths[0].slice(0, paths[0].lastIndexOf('/')) + '/' : '') + name + '.' + fmt });
      toast('已创建压缩包');
    } else if (act === 'extract') {
      const p = paths[0];
      await post('/api/extract', { archive: p, dest: p.slice(0, p.lastIndexOf('.')) || '.' });
      toast('已解压');
    } else if (act === 'convert') {
      const target = await promptText('转换目标扩展名（如 png/webp/jpg）', 'png');
      if (!target) return;
      const p = paths[0];
      const dest = p.slice(0, p.lastIndexOf('.')) + '.' + target.replace(/^\./, '');
      await post('/api/convert', { path: p, target: '.' + target.replace(/^\./, ''), dest });
      toast('已转换');
    } else if (act === 'details') {
      const it = JSON.parse(sessionStorage.getItem('lastDetail') || 'null') || { path: paths[0] };
      openDetail({ ...it, path: paths[0] });
      return;
    }
    state.selected.clear(); updateToolbar();
    await loadTimeline();
  } catch (e) {
    toast('操作失败：' + e.message);
  }
}

// ---------- 通用弹层 ----------
function promptText(title, def) {
  return new Promise((res) => {
    const m = $('#promptModal');
    $('#promptTitle').textContent = title;
    const inp = $('#promptInput');
    inp.value = def || '';
    m.hidden = false; inp.focus(); inp.select();
    const ok = () => { m.hidden = true; res(inp.value.trim()); };
    const cancel = () => { m.hidden = true; res(null); };
    $('#promptOk').onclick = ok;
    $('#promptCancel').onclick = cancel;
    inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel(); };
  });
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------- 事件绑定 ----------
$('#searchInput').addEventListener('input', (e) => {
  state.filters.q = e.target.value.trim();
  clearTimeout(window._st);
  window._st = setTimeout(loadTimeline, 300);
});
$('#toolbar').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act) doAction(act);
});
$('#undoBtn').onclick = () => doAction('undo');
$('#redoBtn').onclick = () => doAction('redo');
$('#detailClose').onclick = () => ($('#detail').hidden = true);

$('#filterBtn').onclick = () => ($('#filterModal').hidden = false);
$('#filterApply').onclick = () => {
  state.filters.type = $('#fType').value;
  state.filters.minSize = $('#fMin').value ? +$('#fMin').value : null;
  state.filters.maxSize = $('#fMax').value ? +$('#fMax').value : null;
  state.filters.from = $('#fFrom').value || null;
  state.filters.to = $('#fTo').value || null;
  $('#filterModal').hidden = true;
  loadTimeline();
};
$('#filterReset').onclick = () => {
  state.filters = { q: '', type: 'all', minSize: null, maxSize: null, from: null, to: null };
  $('#filterModal').hidden = true; loadTimeline();
};

$('#aboutBtn').onclick = async () => {
  const a = await api('/api/about');
  $('#aboutVer').textContent = 'v' + a.version;
  $('#aboutGithub').href = a.github;
  $('#aboutModal').hidden = false;
};
$('#aboutClose').onclick = (e) => { e.preventDefault(); $('#aboutModal').hidden = true; };

document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; })
);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doAction('undo'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doAction('redo'); }
});

// ---------- 启动 ----------
loadTimeline();
