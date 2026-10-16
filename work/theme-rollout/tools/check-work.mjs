// 作品体检：GPT 或别的 AI 交来的 HTML，发布前先跑一遍，看是否符合《作品视觉规范》。
// 用法：node check-work.mjs <作品.html> [--category "⚖️ 法学/⛓️ 刑法"] [--fix]
//   --category  作品在网页库里放在哪个分类下。文件已经在「AI 网页成品/…」目录里时可以省略，会自动推断。
//   --fix       自动补能机械修好的项：主题脚本和变量层的引用、<html data-field>、viewport。会先备份成 .bak。
// 退出码：0 = 通过（可以有提醒），1 = 有必须改的问题，2 = 用法错误。
import fs from 'node:fs'; import path from 'node:path';

const args = process.argv.slice(2), file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--category');
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
if (!file) { console.error('用法：node check-work.mjs <作品.html> [--category "⚖️ 法学/⛓️ 刑法"] [--fix]'); process.exit(2); }
let html = fs.readFileSync(file, 'utf8');
const FIX = args.includes('--fix');

// 分类 → 主题相对路径、应有的大类
let category = opt('--category');
if (!category) { const abs = path.resolve(file), k = abs.indexOf('/AI 网页成品/'); if (k >= 0) category = path.dirname(abs.slice(k + '/AI 网页成品/'.length)); }
if (!category || category === '.') { console.error('推断不出分类，请加 --category'); process.exit(2); }
const segs = category.split('/').filter(Boolean), rel = '../'.repeat(segs.length) + '_theme/';
const FIELD_BY_TOP = { '法学': 'law', '数理': 'science', '英语': 'english', '钢琴': 'piano', '小工具与游戏': 'tools' };
const wantField = FIELD_BY_TOP[(segs[0] || '').replace(/^[^\p{L}\p{N}]+\s*/u, '')];

const errors = [], warns = [], fixed = [];
const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
// 打印样式（白纸黑字）不算：先把 @media print 整段去掉
const css = ((html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n') + '\n' + [...html.matchAll(/\sstyle="([^"]*)"/gi)].map(m => m[1]).join(';\n')).replace(/@media\s+print\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, '');

// 1. 主题脚本：在 <head> 里，早于任何样式
const jsRe = /<script[^>]*src="([^"]*_theme\/sidereal\.js)"[^>]*><\/script>/i, jsM = head.match(jsRe);
if (!jsM) errors.push(`缺主题脚本：<head> 里要有 <script src="${rel}sidereal.js"></script>，放在样式之前`);
else { if (jsM[1] !== rel + 'sidereal.js') errors.push(`主题脚本路径应为 ${rel}sidereal.js，现在是 ${jsM[1]}`);
  const firstStyle = head.search(/<link[^>]+stylesheet|<style/i); if (firstStyle >= 0 && head.indexOf(jsM[0]) > firstStyle) errors.push('主题脚本要放在所有样式之前，否则深色模式下会先白闪一下'); }
// 2. 变量层
const tokRe = /<link[^>]*href="([^"]*_theme\/sidereal-tokens\.css)"[^>]*>/i, tokM = head.match(tokRe);
if (!tokM) errors.push(`缺变量层：<head> 里要有 <link rel="stylesheet" href="${rel}sidereal-tokens.css">`);
else if (tokM[1] !== rel + 'sidereal-tokens.css') errors.push(`变量层路径应为 ${rel}sidereal-tokens.css，现在是 ${tokM[1]}`);
// 3. 大类
const fieldM = html.match(/<html[^>]*\sdata-field="([^"]*)"/i);
if (!fieldM) errors.push(`<html> 上缺 data-field（这个分类应为 data-field="${wantField || '?'}"）`);
else if (!['law', 'science', 'english', 'piano', 'tools'].includes(fieldM[1])) errors.push(`data-field="${fieldM[1]}" 不是有效值`);
else if (wantField && fieldM[1] !== wantField) warns.push(`data-field="${fieldM[1]}" 和分类「${segs[0]}」对应的 ${wantField} 不一致`);
// 4. 被否掉的颜色
const BANNED = ['#1f6751', '#214e40', '#216951', '#d97757', '#c96442', '#e8a48f', '#262624'];
const lower = css.toLowerCase(), banned = BANNED.filter(c => lower.includes(c));
if (banned.length) errors.push(`用了被否掉的颜色：${banned.join(' ')}（森林绿、Claude 橙那一族），改用 var(--accent) 等变量`);
const hsl = hex => { const n = hex.replace('#', ''), f = n.length === 3 ? [...n].map(c => c + c).join('') : n; const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (!d) return [0, 0, l]; const s = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(h * 60 + 360) % 360, s, l]; };
const near = [...new Set((lower.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/g) || []))].filter(c => { const [h, s, l] = hsl(c); return (h >= 135 && h <= 175 && s > .3 && l < .45) || (h >= 10 && h <= 24 && s > .45 && l > .45 && l < .75); });
if (near.length) warns.push(`有接近森林绿或 Claude 橙的颜色：${near.slice(0, 6).join(' ')}${near.length > 6 ? ' …' : ''}`);
// 5. 写死的颜色（变量定义以外）
const decls = css.split(/[;{}]/).map(s => s.trim()).filter(s => /:/.test(s) && !/^--/.test(s) && !/^@/.test(s));
const NEUTRAL = /#0{3}[0-9a-f]?\b|#0{6}[0-9a-f]{2}\b|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/i;   // 纯黑半透明的阴影、遮罩，深浅两种模式都适用，不算
const hard = decls.filter(d => { const v = d.split(':').slice(1).join(':'); if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(v) || /var\(--/.test(v)) return false; return (v.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || []).some(c => !NEUTRAL.test(c)); });
if (hard.length) warns.push(`有 ${hard.length} 处写死的颜色（应改成变量），例如：${hard.slice(0, 3).map(s => s.replace(/\s+/g, ' ').slice(0, 60)).join(' ｜ ')}`);
// 6. 自己存深浅设置
const keys = [...new Set([...html.matchAll(/localStorage\.(?:getItem|setItem)\(\s*['"]([^'"]*(?:theme|dark|mode)[^'"]*)['"]/gi)].map(m => m[1]))].filter(k => k !== 'sidereal-theme');
if (keys.length) errors.push(`作品自己存了深浅设置（${keys.join('、')}），要统一用 sidereal.js（键名 sidereal-theme），把自己的切换逻辑删掉`);
// 7. 覆盖了主题变量
const redefined = [...new Set([...css.matchAll(/(--(?:page|sheet|sheet-2|sheet-3|ink|ink-2|ink-3|line|line-2|mark|accent|accent-soft|accent-ink))\s*:/g)].map(m => m[1]))];
if (redefined.length) warns.push(`作品里重新定义了主题变量 ${redefined.join(' ')}，会盖掉全站主题；没有特别理由就删掉`);
// 8. 手写体用在正文或按钮上
if (/(?:^|[,}\s])(?:body|p|button|td|li)\s*\{[^}]*font-family\s*:\s*var\(--font-hand\)/i.test(css)) warns.push('手写体（--font-hand）用在了正文、按钮或表格上，规范只允许用于标题和点缀');
// 9. viewport
if (!/<meta[^>]+name=["']viewport["']/i.test(head)) errors.push('缺 <meta name="viewport">，手机上会缩成一团');
// 10. 外网资源
const ext = [...new Set([...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map(m => new URL(m[1]).host))];
if (ext.length) warns.push(`引用了外网资源（${ext.join('、')}），离线或网络不好时会缺东西；能内嵌就内嵌`);

// --fix：机械可修的项
if (FIX && (!jsM || !tokM || !fieldM || !/<meta[^>]+name=["']viewport["']/i.test(head))) {
  fs.copyFileSync(file, file + '.bak');
  let add = '';
  if (!/<meta[^>]+name=["']viewport["']/i.test(head)) { add += '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'; fixed.push('补了 viewport'); }
  if (!jsM) { add += `<script src="${rel}sidereal.js"></script>\n`; fixed.push('补了主题脚本'); }
  if (!tokM) { add += `<link rel="stylesheet" href="${rel}sidereal-tokens.css">\n`; fixed.push('补了变量层'); }
  if (add) { const cm = html.match(/<meta[^>]*charset[^>]*>/i);   // 字符集声明留在最前，主题引用紧跟其后
    html = cm ? html.replace(cm[0], cm[0] + '\n' + add.trimEnd()) : html.replace(/<head([^>]*)>/i, `<head$1>\n<meta charset="utf-8">\n${add.trimEnd()}`); }
  if (!fieldM && wantField) { html = html.replace(/<html([^>]*)>/i, `<html$1 data-field="${wantField}">`); fixed.push(`补了 data-field="${wantField}"`); }
  fs.writeFileSync(file, html);
}

const name = path.basename(file), FIXABLE = /缺主题脚本|缺变量层|缺 data-field|缺 <meta name="viewport">/;
const left = errors.filter(e => !(FIX && fixed.length && FIXABLE.test(e)));
console.log(`${left.length ? '✗ 不通过' : '✓ 通过'}  ${name}  （分类 ${category}，主题路径 ${rel}）`);
for (const e of left) console.log('  ✗ ' + e);
for (const w of warns) console.log('  △ ' + w);
for (const f of fixed) console.log('  ↻ 已自动修：' + f + (f === fixed[0] ? `（原文件备份为 ${name}.bak）` : ''));
process.exit(left.length ? 1 : 0);
