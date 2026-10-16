// Markdown → 统一主题的作品 HTML。GPT 只交内容（Markdown），样式全部来自共享主题，不可能跑偏。
// 用法：node md2work.mjs <输入.md> <输出.html>
// Markdown 开头写一段设置（--- 包起来）：
//   ---
//   title: 刑法学 · 总论            作品名（必填）
//   subtitle: 第二版 · 学习笔记      副标题（可选）
//   category: ⚖️ 法学/⛓️ 刑法       放在网页库哪个分类下（必填，决定主题文件的相对路径）
//   field: law                      大类主色，不写就按分类推断：law / science / english / piano / tools
//   script: a quiet study of law     英文小语（可选，Caveat 手写体）
//   toc: true                       是否显示左侧目录（默认显示）
//   numbered: true                  二级标题是否自动编号 01、02…（默认编号）
//   ---
// 正文扩展：==重点== → 标记黄；
//   :::statute 《刑法》第十三条      条文框（主色左边线）
//   条文内容……
//   :::
//   :::tip                          提示框（标记黄底）
//   内容……
//   :::
import fs from 'node:fs'; import path from 'node:path';
import { Marked } from 'marked';

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('用法：node md2work.mjs <输入.md> <输出.html>'); process.exit(2); }
let src = fs.readFileSync(inFile, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// 1. 设置段
const meta = {}; const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
if (fm) { for (const line of fm[1].split('\n')) { const m = line.match(/^(\w+)\s*:\s*(.*)$/); if (m) meta[m[1]] = m[2].trim(); } src = src.slice(fm[0].length); }
const fail = msg => { console.error('✗ ' + msg); process.exit(1); };
if (!meta.title) fail('设置段里缺 title');
if (!meta.category) fail('设置段里缺 category（例如：⚖️ 法学/⛓️ 刑法）');
const FIELD_BY_TOP = { '法学': 'law', '数理': 'science', '英语': 'english', '钢琴': 'piano', '小工具与游戏': 'tools' };
const segs = meta.category.split('/').map(s => s.trim()).filter(Boolean);
const topName = (segs[0] || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');
const field = meta.field || FIELD_BY_TOP[topName];
if (!['law', 'science', 'english', 'piano', 'tools'].includes(field)) fail(`推断不出大类主色（分类「${segs[0]}」），请在设置段里写 field`);
const rel = '../'.repeat(segs.length) + '_theme/';   // 作品在「AI 网页成品/分类…/文件.html」，主题在「AI 网页成品/_theme/」
const toc = meta.toc !== 'false', numbered = meta.numbered !== 'false';

// 2. 容器块 :::statute / :::tip
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
src = src.replace(/^:::(statute|tip)[ \t]*(.*)\n([\s\S]*?)\n:::[ \t]*$/gm, (_, kind, title, body) => kind === 'statute'
  ? `<div class="sd-statute">${title ? `<span class="sd-art">${esc(title)}</span>` : ''}\n\n${body}\n\n</div>`
  : `<div class="sd-callout">\n\n${body}\n\n</div>`);

// 3. Markdown → HTML
const heads = []; let h2n = 0;
const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [{ name: 'mark', level: 'inline', start: s => s.indexOf('=='), tokenizer(s) { const m = s.match(/^==(?!=)([\s\S]+?)==/); if (m) return { type: 'mark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; }, renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; } }],
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      if (depth === 1) return `<h2 class="sd-h1-demoted">${text}</h2>\n`;   // 作品名已经是 h1，正文里的 # 降一级
      const id = 'sec-' + (heads.length + 1), plain = text.replace(/<[^>]+>/g, '');
      if (depth === 2) { h2n++; heads.push({ id, level: 2, text: plain, no: String(h2n).padStart(2, '0') }); return `<h2 id="${id}">${numbered ? `<span class="sd-no">${String(h2n).padStart(2, '0')}</span>` : ''}${text}</h2>\n`; }
      if (depth === 3) { heads.push({ id, level: 3, text: plain }); return `<h3 id="${id}">${text}</h3>\n`; }
      return `<h${depth}>${text}</h${depth}>\n`;
    },
    image({ href, title, text }) { return `<figure><img src="${esc(href)}" alt="${esc(text)}" loading="lazy">${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`; }
  }
});
const body = marked.parse(src).replace(/<table>/g, '<div class="sd-table"><table>').replace(/<\/table>/g, '</table></div>');
const tocHTML = heads.map(h => `<a href="#${h.id}" class="sd-l${h.level}">${h.no ? h.no + '　' : ''}${esc(h.text)}</a>`).join('');
const useToc = toc && heads.length >= 2;

// 4. 套模板
const html = `<!doctype html>
<html lang="zh-CN" data-field="${field}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="generator" content="sidereal md2work v1">
<title>${esc(meta.title)}</title>
<script src="${rel}sidereal.js"></script>
<link rel="stylesheet" href="${rel}sidereal-tokens.css">
<link rel="stylesheet" href="${rel}sidereal-base.css">
</head>
<body>
<header class="sd-top"><span class="sd-brand">${esc(meta.title)}</span>${meta.script ? `<span class="sd-script">${esc(meta.script)}</span>` : ''}<span class="sd-spacer"></span><button type="button" data-sd-theme></button></header>
<div class="sd-page${useToc ? '' : ' sd-single'}">
${useToc ? `<nav class="sd-toc" aria-label="目录"><details open><summary>目录</summary><p>Contents</p>${tocHTML}</details></nav>` : ''}
<main class="sd-main"><article class="sd-card sd-prose"><span class="sd-tape" aria-hidden="true"></span>
<h1>${esc(meta.title)}</h1>${meta.subtitle ? `<p class="sd-sub">${esc(meta.subtitle)}</p>` : ''}
${body}</article></main>
</div>
<button type="button" class="sd-totop" aria-label="回到顶部">↑</button>
<script>
(function(){var links=[].slice.call(document.querySelectorAll('.sd-toc a')),secs=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1));}),top=document.querySelector('.sd-totop'),d=document.querySelector('.sd-toc details');
if(d&&innerWidth<=900)d.removeAttribute('open');
function spy(){var y=innerHeight*0.25,cur=0;for(var i=0;i<secs.length;i++){if(secs[i]&&secs[i].getBoundingClientRect().top<=y)cur=i;}links.forEach(function(a,i){a.classList.toggle('on',i===cur);});top.classList.toggle('show',scrollY>600);}
addEventListener('scroll',spy,{passive:true});spy();top.onclick=function(){scrollTo({top:0,behavior:'smooth'});};
links.forEach(function(a){a.addEventListener('click',function(){if(d&&innerWidth<=900)d.removeAttribute('open');});});})();
</script>
</body>
</html>
`;
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`✓ ${outFile}  大类 ${field} · ${heads.filter(h => h.level === 2).length} 个二级标题 · 主题路径 ${rel}`);
