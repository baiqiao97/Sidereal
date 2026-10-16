/* 结构化学习版教材：每段 <p data-block> 里的 .source-text 是正文；跳转靠网址里的 #段落编号（教材自己的 route 会展开对应章节） */
window.__NOTES_CONFIG = {
  key: '__KEY__', title: '__TITLE__',
  blocks: () => Array.from(document.querySelectorAll('[data-block] > .source-text'), el => ({ el, id: el.parentElement.dataset.block })),
  label: (id, el) => {
    const p = el ? el.parentElement : document.getElementById(id), u = p && p.closest('.book-unit'), h = u && u.querySelector('h1, h2');
    return [(h && h.textContent.trim().slice(0, 40)) || '', p && p.dataset.pdfPage ? 'PDF ' + p.dataset.pdfPage : ''].filter(Boolean).join(' · ');
  },
  go: id => { if (location.hash === '#' + id) location.hash = ''; location.hash = id; return new Promise(r => setTimeout(r, 160)); },
  mountBefore: () => document.getElementById('saved-button')   // 放在「书签笔记」前面：教材在手机上会把顶栏最后一个按钮限宽到 37px
};
