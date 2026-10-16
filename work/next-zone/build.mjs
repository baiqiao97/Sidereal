// 特区版构建：打包外壳 → dist/，再拼出一个可本地预览的完整站点。
// 用法：OPEN_KEY=… node build.mjs（不给 OPEN_KEY 就是密码门）。先在 vendor/ 里 npm install 装 esbuild 和 three
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(here, 'dist'), src = path.join(here, 'src');
fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

// 1. 打包 JS（含 Three.js），文件名带内容哈希，方便长期缓存
execFileSync(path.join(here, 'vendor/node_modules/.bin/esbuild'), [path.join(src, 'main.js'), '--bundle', '--minify', '--format=iife', '--target=es2020', '--legal-comments=none', `--outfile=${path.join(dist, 'app.js')}`, `--resolve-extensions=.js`, `--alias:three=${path.join(here, 'vendor/node_modules/three/build/three.module.js')}`], { stdio: 'inherit' });
// 公开版：环境变量 OPEN_KEY（公开层钥匙，base64，由站点密码算出来）打进主程序，门口点 Enter 就进；不给就仍是密码门
{ const f = path.join(dist, 'app.js'), k = process.env.OPEN_KEY || ''; if (k && !/^[A-Za-z0-9+/]{43}=$/.test(k)) throw Error('OPEN_KEY 格式不对'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('__OPEN_KEY__').join(k)); console.log(k ? '门口：公开（Enter 进入）' : '门口：密码'); }
const js = fs.readFileSync(path.join(dist, 'app.js')), jsName = `app-${crypto.createHash('sha256').update(js).digest('hex').slice(0, 10)}.js`;
fs.renameSync(path.join(dist, 'app.js'), path.join(dist, 'assets', jsName));
// 2026-10-15 首屏提速：样式直接写进页面（少一次往返，标题和占位夜空马上出来）；主程序在 <head> 里就开始预取，和页面并行下载
{ const css = fs.readFileSync(path.join(src, 'gate.css'), 'utf8'), link = '<link rel="stylesheet" href="/gate.css">';
  let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8'); if (!html.includes(link)) throw Error('index.html 里找不到 gate.css 的引用');
  html = html.replace(link, () => `<link rel="preload" as="script" href="/assets/${jsName}"><style>${css}</style>`).split('APP_JS').join(jsName);
  // 公开版：主程序还没到时门口就已经是 Enter，不先闪一个密码框；标题也马上淡入
  if (process.env.OPEN_KEY) { const a = '<html lang="en" data-view="gate">', b = '<h1 id="title" class="title">';
    if (!html.includes(a) || !html.includes(b)) throw Error('index.html 结构变了，公开版门口没法预先标记');
    html = html.replace(a, '<html lang="en" data-view="gate" class="open-gate">').replace(b, '<h1 id="title" class="title on">');
    // 隐藏的密码框不能带 required：主程序到之前按 Enter，浏览器会因为「必填项为空」静默拒绝提交，看起来就是按了没反应（2026-10-15 用户遇到）
    const pw = ' spellcheck="false" required>'; if (html.split(pw).length !== 2) throw Error('index.html 里的密码框变了');
    html = html.replace(pw, ' spellcheck="false" disabled>'); }
  fs.writeFileSync(path.join(dist, 'index.html'), html); }
fs.copyFileSync(path.join(src, 'gate.css'), path.join(dist, 'gate.css'));
for (const dir of ['sky', 'planets']) for (const f of fs.readdirSync(path.join(here, 'assets-src', dir))) if (/^[a-z0-9-]+\.(?:jpg|png|bin)$/.test(f)) fs.copyFileSync(path.join(here, 'assets-src', dir, f), path.join(dist, 'assets', f));

// 2. sw.js：在浏览器里解密作品的 Service Worker，原样复制
fs.copyFileSync(path.join(src, 'sw.js'), path.join(dist, 'sw.js'));
console.log('dist ready:', fs.readdirSync(dist).join(' '), '| assets:', fs.readdirSync(path.join(dist, 'assets')).join(' '), `| ${jsName} ${(js.length / 1024).toFixed(0)} KB`);
