'use strict';
// Aurafile 前端逻辑（v0.1.12 — 内联交互模式，废弃 modal 弹窗以兼容 fnOS iframe）

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
  card.dataset.path = it.path;
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

  // 点击行为：如果正在内联编辑状态则不触发选择
  card.addEventListener('click', (e) => {
    // 如果点击的是内联编辑的 input 或其容器，不触发选择逻辑
    if (card.classList.contains('inline-editing')) return;
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(it.path, card);
    } else if (it.isDir) {
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
  // 记住最后查看的详情
  sessionStorage.setItem('lastDetail', JSON.stringify(meta));
}
function kv(k, v) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v ?? '')}</span></div>`; }

// ══════════════════════════════════════════════════════════════
// ★ 内联操作系统（v0.1.12 — 替代所有 modal 弹窗）★
// ══════════════════════════════════════════════════════════════

/**
 * 内联重命名：将选中文件的名称变为可编辑 input
 * - Enter 确认并调用 API
 * - Escape 取消恢复原样
 * - 失焦时自动确认
 */
function startInlineRename(card, path) {
  // 清除已有的其他内联编辑
  cancelInlineEdit();

  const nameEl = card.querySelector('.name');
  if (!nameEl) return;

  const oldName = path.split('/').pop();
  nameEl.innerHTML = `<input id="__renameInput" type="text" value="${esc(oldName)}" class="inline-input" />`;
  card.classList.add('inline-editing');

  const inp = $('#__renameInput');
  inp.focus();
  // 选中扩展名前的部分（类似 Finder 行为）
  const dotPos = oldName.lastIndexOf('.');
  if (dotPos > 0) { inp.setSelectionRange(0, dotPos); } else { inp.select(); }

  let confirmed = false;

  const doRename = async () => {
    if (confirmed) return;
    confirmed = true;
    const newName = inp.value.trim();
    if (!newName || newName === oldName) {
      nameEl.textContent = oldName;  // 取消/无变化
      card.classList.remove('inline-editing');
      return;
    }
    try {
      await post('/api/rename', { path, name: newName });
      nameEl.textContent = newName;
      card.classList.remove('inline-editing');
      toast(`已重命名为 ${newName}`);
      state.selected.clear(); updateToolbar();
      await loadTimeline();
    } catch (e) {
      nameEl.textContent = oldName;
      card.classList.remove('inline-editing');
      toast('重命名失败：' + e.message);
    }
  };

  const cancel = () => {
    if (confirmed) return;
    confirmed = true;
    nameEl.textContent = oldName;
    card.classList.remove('inline-editing');
  };

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doRename(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  inp.addEventListener('blur', () => { setTimeout(doRename, 100); });  // 延迟让 click 先处理
}

/**
 * 内联输入条：在工具栏下方展开一个临时输入区域
 * 用于压缩包命名、格式转换等需要用户输入的操作
 * - 显示标题、提示文字、input
 * - 确定按钮直接执行操作
 * - 取消/X 关闭
 */
let _activeInlineBar = null;

function showInlineBar(title, placeholder, hint, onSubmit) {
  cancelInlineEdit();  // 清除已有内联编辑

  // 移除已有 inline bar
  if (_activeInlineBar) { _activeInlineBar.remove(); _activeInlineBar = null; }

  const bar = document.createElement('div');
  bar.className = 'inline-action-bar';
  bar.id = '__inlineActionBar';

  bar.innerHTML = `
    <span class="inline-bar-title">${esc(title)}</span>
    ${hint ? `<span class="inline-bar-hint">${esc(hint)}</span>` : ''}
    <input id="__inlineInput" type="text" value="${esc(placeholder || '')}" placeholder="${esc(placeholder || '请输入…')}" />
    <button id="__inlineOk" type="button" class="inline-btn primary">确定</button>
    <button id="__inlineCancel" type="button" class="inline-btn ghost">取消</button>
    <button id="__inlineClose" class="inline-bar-close">×</button>
  `;

  // 插入到 timeline 上方（toolbar 下方）
  const tl = $('#timeline');
  tl.parentNode.insertBefore(bar, tl);

  _activeInlineBar = bar;

  const inp = $('#__inlineInput');
  requestAnimationFrame(() => { try { inp.focus(); inp.select(); } catch(_) {} });

  let resolved = false;

  const submit = async () => {
    if (resolved) return;
    resolved = true;
    const val = inp.value.trim();
    bar.remove();
    _activeInlineBar = null;
    if (val) await onSubmit(val);
  };

  const close = () => {
    if (resolved) return;
    resolved = true;
    bar.remove();
    _activeInlineBar = null;
  };

  // 绑定事件 — 使用多种方式确保在 fnOS iframe 中工作
  const bind = (id, fn) => {
    const el = $(id);
    if (!el) return;
    el.onclick = fn;
    el.addEventListener('click', fn);
    el.addEventListener('pointerdown', function(e) { e.preventDefault(); e.stopPropagation(); fn.call(this, e); });
  };

  bind('#__inlineOk', submit);
  bind('#__inlineCancel', close);
  bind('#__inlineClose', close);

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // 点击 bar 外部区域关闭
  setTimeout(() => {
    document.addEventListener('click', function __outsideClick(e) {
      if (bar.contains(e.target)) return;
      close();
      document.removeEventListener('click', __outsideClick);
    });
  }, 50);
}

/** 取消当前的内联编辑/输入条 */
function cancelInlineEdit() {
  // 清除 inline rename
  const editing = document.querySelector('.file-card.inline-editing');
  if (editing) {
    editing.classList.remove('inline-editing');
    const nameEl = editing.querySelector('.name');
    if (nameEl && nameEl.querySelector('input')) {
      const oldName = nameEl.querySelector('input').value || '';
      nameEl.textContent = oldName;
    }
  }
  // 清除 inline bar
  if (_activeInlineBar) { _activeInlineBar.remove(); _activeInlineBar = null; }
}

// ---------- 操作 ----------
async function doAction(act) {
  const paths = [...state.selected];
  if (!paths.length && !['paste', 'undo', 'redo'].includes(act)) return toast('请先选择文件');
  try {
    if (act === 'rename') {
      // ★ 内联重命名：找到对应 card 并进入编辑模式
      const cards = document.querySelectorAll('.file-card');
      let targetCard = null;
      for (const c of cards) { if (c.dataset.path === paths[0]) { targetCard = c; break; } }
      if (targetCard) {
        startInlineRename(targetCard, paths[0]);
      } else {
        // 找不到 card 时 fallback 到 inline bar
        const oldName = paths[0].split('/').pop();
        showInlineBar('重命名', oldName, '输入新的文件/文件夹名称', async (newName) => {
          await post('/api/rename', { path: paths[0], name: newName });
          toast(`已重命名为 ${newName}`);
          state.selected.clear(); updateToolbar();
          await loadTimeline();
        });
      }
      return;  // 不刷新列表（由回调处理）
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
      // ★ 内联输入条：压缩包名称
      showInlineBar('新建压缩包', 'archive', '输入压缩包名称（不需扩展名），将创建 .zip 文件', async (name) => {
        const dest = (paths[0].includes('/') ? paths[0].slice(0, paths[0].lastIndexOf('/')) + '/' : '') + name + '.zip';
        await post('/api/archive', { format: 'zip', entries: paths, dest });
        toast('已创建压缩包 ' + name + '.zip');
        state.selected.clear(); updateToolbar();
        await loadTimeline();
      });
      return;
    } else if (act === 'extract') {
      const p = paths[0];
      await post('/api/extract', { archive: p, dest: p.slice(0, p.lastIndexOf('.')) || '.' });
      toast('已解压');
    } else if (act === 'convert') {
      // ★ 内联输入条：格式转换目标
      showInlineBar('格式转换', 'png', '输入目标格式扩展名，如 png / webp / jpg', async (target) => {
        const p = paths[0];
        const dest = p.slice(0, p.lastIndexOf('.')) + '.' + target.replace(/^\./, '');
        await post('/api/convert', { path: p, target: '.' + target.replace(/^\./, ''), dest });
        toast('已转换为 ' + target);
        state.selected.clear(); updateToolbar();
        await loadTimeline();
      });
      return;
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

$('#aboutBtn').onclick = () => { window.location.href = '/about'; };

// 筛选弹层的背景点击关闭
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; })
);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doAction('undo'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doAction('redo'); }
});

// ---------- 启动 ----------
loadTimeline();
