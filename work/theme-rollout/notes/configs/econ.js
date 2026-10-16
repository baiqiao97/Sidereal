/* 经济法课程资料：翻页式阅读器，正文是当前页 .readbody 里的段落；编号 = 文件/页/第几段（文件和页从网址 #文件/页 读，阅读器翻页时会改网址）。
   跳回别的页：借页面上任意一个「打开」按钮（data-open），改掉它要打开的文件和页再点——阅读器在点的那一刻才读这两个值；找不到再改网址刷新 */
(function () {
  const here = () => { const [d, p] = decodeURIComponent(location.hash.slice(1)).split('/'); return d && p !== undefined ? d + '/' + p : ''; };
  window.__NOTES_CONFIG = {
    key: '__KEY__', title: '__TITLE__',
    blocks: () => { const at = here(); if (!at) return []; return Array.from(document.querySelectorAll('.readbody > p, .readbody > h3'), (el, i) => ({ el, id: at + '/' + i })); },
    label: (id, el) => { if (!el) return ''; const h = document.querySelector('.readerhead h1'), p = Number(id.split('/')[1]); return [(h && h.textContent.trim().slice(0, 30)) || '', '第 ' + (p + 1) + ' 页'].filter(Boolean).join(' · '); },
    go: id => {
      const [d, p] = id.split('/'); if (here() === d + '/' + p) return;
      const b = document.querySelector('[data-open]');
      if (b) { b.dataset.open = d; b.dataset.page = p; b.click(); return new Promise(r => setTimeout(r, 250)); }
      location.hash = d + '/' + p; location.reload();
    },
    mountBefore: () => document.getElementById('help'), btnClass: 'help'
  };
})();
