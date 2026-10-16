/* 划线笔记（2026-10-16）：选中文字 → 四色划线 / 下划线 / 批注；「笔记本」里集中看、搜、跳回原文；导出 JSON、Markdown，导入 JSON。
   手感照高数。每件作品各自内嵌一份（不共用文件），记录存在本机浏览器里这件作品自己的键下，不影响作品原有的书签、笔记。
   作品在前面写好 window.__NOTES_CONFIG：
     key     本机存储的键（每件作品不同）        title   导出文件和笔记本标题
     blocks  () => [{el, id}]：能划线的文字容器和它稳定的编号（同一件作品里唯一、文件不改就不变）
     label   (id, el) => 这一段在笔记本里显示的出处（章节、条文号……）
     go      (id) => 跳到这一段（可以返回 Promise）；返回后会在页面里找这一段并闪一下
     mount   () => 放「笔记」按钮的容器；没有就放右下角浮动按钮      btnClass  按钮沿用作品自己的样式类 */
(function () {
  'use strict';
  const C = window.__NOTES_CONFIG; if (!C || window.__notesKit) return; window.__notesKit = true;
  const COLORS = ['yellow', 'green', 'blue', 'pink'], CN = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉' };
  const $ = (s, r = document) => r.querySelector(s), esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const valid = n => n && typeof n.id === 'string' && Array.isArray(n.segs) && n.segs.length && n.segs.every(s => s && typeof s.b === 'string' && s.e > s.s && typeof s.t === 'string') && COLORS.includes(n.color);
  let S = { version: 1, notes: [] }, canStore = true;
  try { const v = JSON.parse(localStorage.getItem(C.key) || 'null'); if (v && Array.isArray(v.notes)) S.notes = v.notes.filter(valid); } catch (e) { canStore = false; }
  function save() { try { localStorage.setItem(C.key, JSON.stringify(S)); canStore = true; } catch (e) { canStore = false; } refreshCount(); if (!drawer.hidden) renderList(); }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* ── 界面 ── */
  const ui = document.createElement('div'); ui.className = 'sdn-ui';
  ui.innerHTML = `
<div class="sdn-bar" role="toolbar" aria-label="划线和批注" hidden>${COLORS.map(c => `<button type="button" class="sdn-sw sdn-${c}" data-sdn-color="${c}" title="${CN[c]}色划线" aria-label="${CN[c]}色划线"></button>`).join('')}<span class="sdn-div"></span><button type="button" data-sdn-under title="下划线">U̲</button><button type="button" data-sdn-note>＋批注</button></div>
<dialog class="sdn-dialog"><form method="dialog" onsubmit="return false">
 <header><h2>批注</h2><button type="button" class="sdn-x" data-sdn-close aria-label="关闭">×</button></header>
 <p class="sdn-src"></p><blockquote class="sdn-quote"></blockquote>
 <textarea rows="6" placeholder="记下理解、疑问，或下次复习要再看的地方。" aria-label="批注内容"></textarea>
 <div class="sdn-style">${COLORS.map(c => `<label class="sdn-pick"><input type="radio" name="sdn-c" value="${c}"><span class="sdn-sw sdn-${c}"></span></label>`).join('')}<label class="sdn-ul"><input type="checkbox"> 下划线</label></div>
 <footer><button type="button" class="sdn-del" data-sdn-del>删除</button><span></span><button type="button" data-sdn-close>取消</button><button type="button" class="sdn-ok" data-sdn-save>保存</button></footer>
</form></dialog>
<aside class="sdn-drawer" aria-label="笔记本" hidden>
 <header><h2>笔记本 <small></small></h2><button type="button" class="sdn-x" data-sdn-hide aria-label="关闭笔记本">×</button></header>
 <input type="search" class="sdn-q" placeholder="搜索划线和批注" aria-label="搜索笔记">
 <div class="sdn-io"><button type="button" data-sdn-json>导出 JSON</button><button type="button" data-sdn-md>导出 Markdown</button><button type="button" data-sdn-import>导入</button><input type="file" accept="application/json,.json" hidden></div>
 <p class="sdn-hint"></p><div class="sdn-list"></div>
</aside><div class="sdn-toast" role="status" hidden></div>`;
  document.body.appendChild(ui);
  const bar = $('.sdn-bar', ui), dlg = $('.sdn-dialog', ui), drawer = $('.sdn-drawer', ui), list = $('.sdn-list', ui), toastEl = $('.sdn-toast', ui);
  let toastT = 0; const toast = t => { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => toastEl.hidden = true, 2600); };
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sdn-open ' + (C.btnClass || ''); btn.innerHTML = '<i class="sdn-l">划线笔记</i><i class="sdn-i" aria-hidden="true">✎</i> <b>0</b>'; btn.setAttribute('aria-label', '划线笔记');   // 用 <i> 不用 <span>：有的作品会在手机上把按钮里的 span 藏掉
  const before = C.mountBefore && C.mountBefore(), host = before ? before.parentNode : C.mount && C.mount();
  if (before) host.insertBefore(btn, before); else if (host) host.appendChild(btn); else { btn.classList.add('sdn-fab'); document.body.appendChild(btn); }
  function refreshCount() { btn.querySelector('b').textContent = S.notes.length; $('h2 small', drawer).textContent = S.notes.length ? '· ' + S.notes.length : ''; }

  /* ── 定位：编号 + 段内字符偏移，另存原文片段，文字对不上时在段内重新找 ── */
  let map = new Map();
  function scan() { map = new Map(); for (const x of C.blocks()) if (x && x.el && x.id && !map.has(x.id)) map.set(x.id, x.el); return map; }
  function texts(el) { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), a = []; let n; while ((n = w.nextNode())) a.push(n); return a; }
  function offsetIn(el, node, off) { const r = document.createRange(); r.selectNodeContents(el); try { r.setEnd(node, off); } catch (e) { return null; } return r.toString().length; }
  function locate(seg, el) {   // 原位置的字对得上就用；对不上就在这一段里找最近的同样片段
    const t = el.textContent; if (t.slice(seg.s, seg.e) === seg.t) return [seg.s, seg.e];
    let best = -1, i = -1; while ((i = t.indexOf(seg.t, i + 1)) !== -1) if (best < 0 || Math.abs(i - seg.s) < Math.abs(best - seg.s)) best = i;
    return best < 0 ? null : [best, best + seg.t.length];
  }
  function unwrap(el) { for (const m of el.querySelectorAll('mark.sdn')) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); } }
  function wrap(el, s, e, note, last) {
    let pos = 0;
    for (const n of texts(el)) {
      const len = n.data.length, a = Math.max(s, pos), b = Math.min(e, pos + len);
      if (a < b) {
        let mid = n; if (a > pos) mid = n.splitText(a - pos); if (b < pos + len) mid.splitText(b - a);
        const m = document.createElement('mark'); m.className = `sdn sdn-${note.color}${note.under ? ' sdn-u' : ''}`; m.dataset.sdn = note.id;
        mid.parentNode.insertBefore(m, mid); m.appendChild(mid);
      }
      pos += len; if (pos >= e) break;
    }
    if (last) { const ms = el.querySelectorAll(`mark.sdn[data-sdn="${note.id}"]`), lm = ms[ms.length - 1]; if (lm && note.body) lm.classList.add('sdn-has'); }
  }
  // 作品自己重新排版、搜索高亮会冲掉划线：DOM 一变就把缺了的补回去。自己改 DOM 产生的变动记录当场丢掉，免得来回触发
  let pend = 0; const lost = new Set();   // 段落改过、原文片段找不到的划线：只在笔记本里留着，不反复尝试
  const mo = new MutationObserver(() => { clearTimeout(pend); pend = setTimeout(heal, 180); });
  function applyBlock(id, el) {
    unwrap(el);
    const segs = []; for (const n of S.notes) n.segs.forEach((g, k) => { if (g.b === id) segs.push({ g, n, last: k === n.segs.length - 1 }); });
    segs.sort((x, y) => x.g.s - y.g.s);
    for (const { g, n, last } of segs) { const r = locate(g, el); if (r) { wrap(el, r[0], r[1], n, last); lost.delete(n.id + '|' + id); } else lost.add(n.id + '|' + id); }
    mo.takeRecords();
  }
  function applyAll() { scan(); const want = new Set(); for (const n of S.notes) for (const g of n.segs) want.add(g.b);
    for (const [id, el] of map) if (want.has(id) || el.querySelector('mark.sdn')) applyBlock(id, el); }
  function heal() {
    scan(); const need = new Map(); for (const n of S.notes) for (const g of n.segs) { if (!need.has(g.b)) need.set(g.b, []); need.get(g.b).push(n.id); }
    // 作品自己缓存过整段 HTML（比如搜索后还原）时，可能带回已经删掉的划线：认不出的一律拆掉
    const live = new Set(S.notes.map(n => n.id)); for (const m of document.querySelectorAll('mark.sdn')) if (!live.has(m.dataset.sdn)) { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); }
    mo.takeRecords();
    for (const [id, ids] of need) { const el = map.get(id); if (el && ids.some(nid => !lost.has(nid + '|' + id) && !el.querySelector(`mark.sdn[data-sdn="${nid}"]`))) applyBlock(id, el); }
  }
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  /* ── 选区 → 划线 ── */
  let pending = null;   // 当前选区换算成的片段
  function fromSelection() {
    const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0); if (ui.contains(r.commonAncestorContainer)) return null; scan(); const segs = [];
    for (const [id, el] of map) {
      if (!r.intersectsNode(el)) continue;
      const s = el.contains(r.startContainer) ? offsetIn(el, r.startContainer, r.startOffset) : 0, e = el.contains(r.endContainer) ? offsetIn(el, r.endContainer, r.endOffset) : el.textContent.length;
      if (s == null || e == null || e <= s) continue; const t = el.textContent.slice(s, e); if (!t.trim()) continue; segs.push({ b: id, s, e, t });
    }
    return segs.length ? segs : null;
  }
  function showBar() {
    pending = fromSelection(); if (!pending) { bar.hidden = true; return; }
    const rc = getSelection().getRangeAt(0).getBoundingClientRect(); bar.hidden = false;
    if (matchMedia('(pointer:coarse)').matches) { bar.classList.add('sdn-dock'); return; }   // 手机：停在底部，不和系统的选区菜单打架
    bar.classList.remove('sdn-dock'); const w = bar.offsetWidth, h = bar.offsetHeight;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, rc.left + rc.width / 2 - w / 2)) + 'px';
    bar.style.top = (rc.top > h + 16 ? rc.top - h - 10 : rc.bottom + 10) + 'px';
  }
  let selT = 0; document.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(showBar, matchMedia('(pointer:coarse)').matches ? 350 : 120); });
  addEventListener('scroll', () => { if (!bar.hidden && !matchMedia('(pointer:coarse)').matches) showBar(); }, { passive: true, capture: true });
  function create(color, under, body = '') {
    if (!pending) return null; const now = Date.now();
    const n = { id: uid(), segs: pending, quote: pending.map(g => g.t).join(' … '), where: label(pending[0].b), color, under: !!under, body, created: now, updated: now };   // where：划线时的出处，换页以后找不到原段落也能显示
    S.notes.push(n); pending = null; bar.hidden = true; getSelection()?.removeAllRanges(); save(); for (const g of n.segs) { const el = map.get(g.b); if (el) applyBlock(g.b, el); } return n;
  }
  bar.addEventListener('mousedown', e => e.preventDefault());   // 点工具条时别把选区点没了
  bar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sdnColor) { create(b.dataset.sdnColor, false); toast(canStore ? '已划线，自动保存在本机' : '已划线；本机存不下，记得导出备份'); }
    else if ('sdnUnder' in b.dataset) { create('yellow', true); toast('已加下划线'); }
    else if ('sdnNote' in b.dataset) openDialog(null);
  });

  /* ── 批注框 ── */
  let editing = null, draft = null;
  function openDialog(id) {
    editing = id ? S.notes.find(n => n.id === id) : null; draft = editing ? null : pending; if (!editing && !draft) return;
    const segs = editing ? editing.segs : draft; scan();
    $('.sdn-src', dlg).textContent = label(segs[0].b) || (editing && editing.where) || ''; $('.sdn-quote', dlg).textContent = segs.map(g => g.t).join(' … ');
    $('textarea', dlg).value = editing ? editing.body || '' : ''; const c = editing ? editing.color : 'yellow';
    dlg.querySelectorAll('input[name="sdn-c"]').forEach(r => r.checked = r.value === c); $('.sdn-ul input', dlg).checked = !!(editing && editing.under);
    $('[data-sdn-del]', dlg).hidden = !editing; $('h2', dlg).textContent = editing ? '编辑批注' : '添加批注'; bar.hidden = true;
    dlg.showModal(); setTimeout(() => $('textarea', dlg).focus(), 30);
  }
  dlg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) { if (e.target === dlg) dlg.close(); return; }
    if ('sdnClose' in b.dataset) dlg.close();
    else if ('sdnDel' in b.dataset && editing) { S.notes = S.notes.filter(n => n !== editing); const ids = editing.segs.map(g => g.b); save(); scan(); ids.forEach(id => { const el = map.get(id); if (el) applyBlock(id, el); }); dlg.close(); toast('已删除'); }
    else if ('sdnSave' in b.dataset) {
      const body = $('textarea', dlg).value.trim(), color = (dlg.querySelector('input[name="sdn-c"]:checked') || {}).value || 'yellow', under = $('.sdn-ul input', dlg).checked;
      if (editing) { Object.assign(editing, { body, color, under, updated: Date.now() }); save(); scan(); editing.segs.forEach(g => { const el = map.get(g.b); if (el) applyBlock(g.b, el); }); }
      else { pending = draft; create(color, under, body); }
      dlg.close(); toast(canStore ? '批注已保存在本机' : '已记下；本机存不下，记得导出备份');
    }
  });
  document.addEventListener('click', e => { const m = e.target.closest('mark.sdn'); if (m && !getSelection()?.toString()) { e.preventDefault(); openDialog(m.dataset.sdn); } });

  /* ── 笔记本 ── */
  function label(id) { try { return C.label(id, map.get(id)) || ''; } catch (e) { return ''; } }
  function renderList() {
    scan(); const q = $('.sdn-q', drawer).value.trim().toLowerCase();
    const ns = S.notes.filter(n => !q || (n.quote + ' ' + (n.body || '') + ' ' + (label(n.segs[0].b) || n.where || '')).toLowerCase().includes(q)).sort((a, b) => b.updated - a.updated);
    $('.sdn-hint', drawer).textContent = S.notes.length ? (canStore ? '记录保存在这台设备的浏览器里。换设备前先导出，到新设备再导入。' : '这个浏览器存不了记录，请及时导出。') : '';
    list.innerHTML = ns.length ? ns.map(n => `<article class="sdn-card sdn-c-${n.color}"><p class="sdn-from">${esc(label(n.segs[0].b) || n.where || '原文')}</p><blockquote>${esc(n.quote.length > 220 ? n.quote.slice(0, 220) + '…' : n.quote)}</blockquote>${n.body ? `<p class="sdn-body">${esc(n.body)}</p>` : ''}<div class="sdn-row"><button type="button" data-sdn-go="${n.id}">回到原文 ↗</button><button type="button" data-sdn-edit="${n.id}">编辑</button></div></article>`).join('')
      : `<div class="sdn-empty">${q ? '没有找到。' : '还没有划线。<br>在正文里选中一段字，就会出现划线工具。'}</div>`;
  }
  btn.addEventListener('click', () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) { renderList(); } });
  drawer.addEventListener('input', e => { if (e.target.matches('.sdn-q')) renderList(); });
  drawer.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if ('sdnHide' in b.dataset) drawer.hidden = true;
    else if (b.dataset.sdnEdit) openDialog(b.dataset.sdnEdit);
    else if (b.dataset.sdnGo) {
      const n = S.notes.find(x => x.id === b.dataset.sdnGo); if (!n) return; if (innerWidth < 900) drawer.hidden = true;
      try { await C.go(n.segs[0].b); } catch (err) {}
      setTimeout(() => { scan(); const el = map.get(n.segs[0].b); if (el && !el.querySelector(`mark[data-sdn="${n.id}"]`)) applyBlock(n.segs[0].b, el);
        const m = document.querySelector(`mark[data-sdn="${n.id}"]`) || el; if (m) { m.scrollIntoView({ block: 'center' }); m.classList.remove('sdn-flash'); void m.offsetWidth; m.classList.add('sdn-flash'); } }, 260);
    }
    else if ('sdnJson' in b.dataset) download(new Blob([JSON.stringify({ kind: 'sidereal-notes', key: C.key, title: C.title, exported: new Date().toISOString(), notes: S.notes }, null, 1)], { type: 'application/json' }), `${C.title}_划线笔记_${new Date().toISOString().slice(0, 10)}.json`);
    else if ('sdnMd' in b.dataset) download(new Blob([markdown()], { type: 'text/markdown' }), `${C.title}_划线笔记_${new Date().toISOString().slice(0, 10)}.md`);
    else if ('sdnImport' in b.dataset) $('input[type=file]', drawer).click();
  });
  $('input[type=file]', drawer).addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d || d.kind !== 'sidereal-notes' || !Array.isArray(d.notes)) throw 0; if (d.key && d.key !== C.key && !confirm('这份备份来自另一件作品，仍然导入？')) return;
      const have = new Map(S.notes.map(n => [n.id, n])); let add = 0, upd = 0;
      for (const n of d.notes.filter(valid)) { const o = have.get(n.id); if (!o) { S.notes.push(n); add++; } else if ((n.updated || 0) > (o.updated || 0)) { Object.assign(o, n); upd++; } }
      save(); applyAll(); toast(`导入完成：新增 ${add} 条，更新 ${upd} 条`); } catch (err) { toast('这个文件不是划线笔记的备份'); }
  });
  function download(blob, name) { const a = document.createElement('a'), u = URL.createObjectURL(blob); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000); }
  function markdown() { scan(); const out = [`# ${C.title} · 我的划线笔记`, '', `导出：${new Date().toLocaleString('zh-CN')}　共 ${S.notes.length} 条`, ''];
    for (const n of S.notes.slice().sort((a, b) => a.created - b.created)) { out.push(`## ${label(n.segs[0].b) || n.where || '原文'}`, '', ...n.quote.split('\n').map(l => '> ' + l), ''); if (n.body) out.push(n.body, ''); }
    return out.join('\n'); }

  refreshCount();
  const boot = () => { try { applyAll(); } catch (e) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  setTimeout(boot, 1200);   // 作品自己的初始化（展开目录、按网址跳转）跑完以后再补一遍
})();
