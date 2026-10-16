/* 法条检索版：每条下面的 <p id> 是正文段落（编号如 cpl-art-1-p-1）；跳转靠网址里的 #编号（检索版自己会切到对应文件并滚过去） */
window.__NOTES_CONFIG = {
  key: '__KEY__', title: '__TITLE__',
  blocks: () => Array.from(document.querySelectorAll('.law-text p[id], .preamble p[id]'), el => ({ el, id: el.id })),
  label: (id, el) => {
    el = el || document.getElementById(id); const a = el && el.closest('.law-article'), d = el && el.closest('.document'), h = d && d.querySelector('.doc-header h2');
    return [(h && h.textContent.trim().slice(0, 24)) || '', a ? (a.querySelector('h3') || {}).textContent || '' : '序言'].filter(Boolean).join(' · ');
  },
  go: id => { if (location.hash === '#' + id) location.hash = ''; location.hash = id; return new Promise(r => setTimeout(r, 200)); },
  mountBefore: () => document.getElementById('sourceButton')
};
