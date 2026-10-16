/* 民法典骨架 × 民法总论：总论正文是一段段 .tx，法典骨架是表格里的 .d 格子，都没有编号——按它们在文件里的先后顺序编（文件不改，编号就不变）。
   跳转：先切到对应的标签页（法典 / 总论），再打开收起的章节 */
(function () {
  const all = () => Array.from(document.querySelectorAll('p.tx, li.tx, .row > .d'));
  const idOf = (el, i) => (el.classList.contains('d') ? 'd-' : 'tx-') + i;
  window.__NOTES_CONFIG = {
    key: '__KEY__', title: '__TITLE__',
    blocks: () => { let t = 0, d = 0; return all().map(el => ({ el, id: el.classList.contains('d') ? 'd-' + d++ : 'tx-' + t++ })); },
    label: (id, el) => {
      if (!el) return ''; const ch = el.closest('details.ch'), nm = ch && ch.querySelector('summary .nm'), bk = el.closest('.bk') || null;
      const k = el.classList.contains('d') ? (el.parentElement.querySelector('.k') || {}).textContent : '';
      return [el.closest('#view-book') ? '民法总论' : '民法典', nm ? nm.textContent.trim() : '', k || ''].filter(Boolean).join(' · ');
    },
    go: id => {
      const el = (window.__NOTES_CONFIG.blocks().find(x => x.id === id) || {}).el; if (!el) return;
      const view = el.closest('#view-book') ? 'book' : 'code';
      if (document.body.dataset.view !== view) { const t = document.querySelector(`.tab[data-view="${view}"]`); if (t) t.click(); }
      for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
      return new Promise(r => setTimeout(r, 150));
    },
    mountBefore: () => document.getElementById('all')
  };
})();
