// Sidereal 外壳：解锁页和书库是同一片海（解锁后作品星亮起、镜头往前滑）→ 外层星团（3D）→ 内层：航道 / 小弧（星展开成卡片）→ 作品。
// 只有一件作品的大类，点了直接飞向行星打开。
// 只有一道站点密码。与后台解密程序 sw.js 的约定：UNLOCK / STATUS / LOCK。
import * as THREE from 'three';
import { SkyScene, enName } from './sky.js';
import { planetOf } from './planet.js';
import { Ripples } from './ripple.js';
import { Field } from './corridor.js';

const $ = id => document.getElementById(id);
const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = Math.min(innerWidth, innerHeight) < 720 || (navigator.hardwareConcurrency || 8) <= 4;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/* ============ Service Worker ============ */
let swReady;
function rpc(type, data = {}, ms = 60000) {   // 解锁要下载加密目录，慢网下给足 3 分钟（2026-10-15：60 秒在用户网络下会超时）
  return swReady.then(() => new Promise((resolve, reject) => {
    const ch = new MessageChannel(); const to = setTimeout(() => { ch.port1.close(); reject(Error('The browser stopped responding. Reload the page.')); }, ms);
    ch.port1.onmessage = e => { clearTimeout(to); ch.port1.close(); resolve(e.data); };
    navigator.serviceWorker.controller.postMessage({ type, ...data }, [ch.port2]);
  }));
}
async function setup() {
  if (!('serviceWorker' in navigator) || !crypto.subtle || !window.DecompressionStream) throw Error('Open this page in a recent Safari, Chrome or Edge.');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); reg.update().catch(() => {}); await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
}

/* ============ 渲染：按屏幕原生像素，保 60 帧 ============ */
let renderer = null, sky = null, ripples = null, W = 0, H = 0, dpr = 1, running = false, last = 0, raf = 0, readerRendering = false, indexStill = false;
const MAX_DPR = Math.min(window.devicePixelRatio || 1, 3); let dprScale = 1, fpsT = 0, fpsN = 0;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('space'), antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x04050a, 1);
  ripples = new Ripples(renderer);
} catch { root.classList.add('no-webgl'); }
function resize() {
  W = innerWidth; H = innerHeight; dpr = Math.max(1, MAX_DPR * dprScale);
  if (!renderer) return; renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
  if (sky) sky.resize(W, H, dpr); ripples.resize(W, H, dpr);
  const fov = (H > W * 1.1 ? 78 : 60) * Math.PI / 180; root.style.setProperty('--hz', (50 + 50 * Math.tan(0.16) / Math.tan(fov / 2)).toFixed(2) + '%');   // 海天还没到时，CSS 先画一条地平线
}
// 清晰度优先：只有持续掉帧（连续两个 2 秒窗口低于 50 帧）才降一点渲染分辨率，最低 70%；一回到 56 帧以上就升回去。
// 加载大贴图、飞行、转场这类一两秒的卡顿不算数，不能因为它们把整个画面降糊
// 2026-10-15 防闪：改分辨率只在下一帧画之前做（以前画完才改，画布被清空的那一帧就是一次黑闪）；
// 降过一次以后 30 秒内不升回去，升也要连续两个窗口都在 58 帧以上，免得在两档之间来回跳
let adaptHold = 0, lowN = 0, highN = 0, lastDown = -1e9, needResize = false;
const holdAdapt = ms => { adaptHold = Math.max(adaptHold, performance.now() + ms); fpsT = 0; fpsN = 0; };
function adapt(dt) {
  if (performance.now() < adaptHold || busy || fieldBusy || (sky && (sky.anim || sky.focusTick))) { fpsT = 0; fpsN = 0; return; }
  fpsT += dt; fpsN++; if (fpsT < 2) return; const fps = fpsN / fpsT; fpsT = 0; fpsN = 0;
  if (fps < 50) { highN = 0; if (++lowN >= 2 && dprScale > 0.7) { dprScale = Math.max(0.7, dprScale - 0.1); lowN = 0; lastDown = performance.now(); needResize = true; } } else lowN = 0;
  if (fps > 58 && dprScale < 1 && performance.now() - lastDown > 30000) { if (++highN >= 2) { dprScale = Math.min(1, dprScale + 0.1); highN = 0; needResize = true; } } else if (fps <= 58) highN = 0;
}
function frame(now) {
  if (!running) return;
  const raw = Math.max(0, (now - last) / 1000), dt = Math.min(0.05, raw); last = now;
  if (needResize || innerWidth !== W || innerHeight !== H) { needResize = false; resize(); }
  if (sky) { tiltTick(dt); if (field) { field.update(dt); fieldBar(); } sky.update(dt, reduceMotion); if (!ripples.render(sky.scene, sky.camera, dt)) renderer.render(sky.scene, sky.camera); if (view === 'sky') placeOverlay(); }
  else renderer.clear();
  if (raw < 0.25) adapt(raw);
  raf = requestAnimationFrame(frame);
}
function start() { if (!renderer || running || document.hidden || indexStill || (view === 'reader' && !readerRendering)) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
function stop() { running = false; cancelAnimationFrame(raf); }
document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());

/* ============ 天空素材：NASA 16K 银河带 + 全天底图 + 星点（耶鲁亮星星表 + 贴图里的暗星） ============ */
// 2026-10-15 防卡：大图在后台线程解码，主线程不再停住——Chrome / Firefox 用 createImageBitmap，Safari（含 iOS 上的各家浏览器）用 img.decode()
const WEBKIT = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || /crios|fxios/i.test(navigator.userAgent);
const tune = t => { t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy()); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return t; };
async function loadTex(url) {
  if (!WEBKIT && window.createImageBitmap) {
    try { const blob = await (await fetch(url)).blob(), bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); const t = new THREE.Texture(bmp); t.flipY = false; return tune(t); } catch {}
  }
  const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode(); return tune(new THREE.Texture(img));
}
let skyBoot = null, bandW = 0, baseW = 0;
function setBand(t) { const w = t.image?.width || 0; holdAdapt(3000); if (w > bandW) { bandW = w; sky.setBand(t); } else t.dispose(); }   // 先到的 16K 不能被晚到的 8K 换掉
function setBase(t) { const w = t.image?.width || 0; holdAdapt(3000); if (w > baseW) { baseW = w; sky.setBase(t); } else t.dispose(); }   // 4K 底图先到，2K 就不用了
function bootSky() {   // 2026-10-15：不等任何素材——一像素占位底图起步，着色器在后台编好，海和雾马上在动；底图、银河带、星点同时去取，到一样淡入一样
  if (skyBoot || !renderer) return skyBoot;
  const ph = new THREE.DataTexture(new Uint8Array([2, 3, 6, 255]), 1, 1); ph.needsUpdate = true;
  const s = new SkyScene(renderer, { base: ph }, small); s.waitBase(); s.still = view === 'gate'; s.resize(W, H, dpr); s.home(view !== 'gate');
  const base2k = loadTex('/assets/base2-2k.jpg'), band8k = loadTex('/assets/band3-8k.jpg'), base4k = small ? null : loadTex('/assets/base2-4k.jpg');
  const starsBin = fetch('/assets/stars2.bin').then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); });
  skyBoot = (renderer.compileAsync ? renderer.compileAsync(s.scene, s.camera).catch(() => {}) : Promise.resolve()).then(() => {
    sky = s; sky.resize(W, H, dpr); if (works) refreshSky(); root.classList.add('sky-ready');
    base2k.then(setBase).catch(() => {}); band8k.then(setBand).catch(() => {}); if (base4k) base4k.then(setBase).catch(() => {});
    starsBin.then(buf => { const dv = new DataView(buf), n = dv.getUint32(0, true); sky.setStars({ n, nb: dv.getUint32(4, true), dir: new Int16Array(buf, 8, n * 3), col: new Uint8Array(buf, 8 + n * 6, n * 4) }); }).catch(() => {});
    return sky;
  });
  return skyBoot;
}
// 16K 银河带只在画面够细（每度超过 28 个物理像素，比如 4K、视网膜屏）时才要；普通屏 8K 已经够，省掉一次上百 MB 的上传卡顿
const wantHiBand = () => !small && renderer && renderer.capabilities.maxTextureSize >= 16384 && W * dpr / (2 * Math.atan(Math.tan(30 * Math.PI / 180) * W / H) * 180 / Math.PI) > 28;

/* ============ 视图 ============ */
let view = 'gate';
function setView(v) {
  view = v; root.dataset.view = v;
  $('gate').hidden = v !== 'gate'; $('sky').hidden = v !== 'sky'; $('reader').hidden = v !== 'reader';
  $('credit').textContent = v === 'sky' ? 'SKY · NASA SVS / ESA GAIA' : '';
  if (sky) sky.still = v === 'gate';   // 解锁页的镜头静止
  if (v === 'sky' && typeof wakeDock === 'function') wakeDock();
  if (v === 'reader' && !readerRendering) stop(); else start();
  if (v !== 'reader') document.title = 'Sidereal';
}
function setStatus(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function shake(id) { const f = $(id); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); }

/* ============ 作品数据 ============ */
const SUB_EN = { '刑法': 'Criminal Law', '刑事诉讼法': 'Criminal Procedure', '民法': 'Civil Law', '民事诉讼法': 'Civil Procedure', '经济法': 'Economic Law', '考研与法考': 'Exams' };
const SHORT = { '法学': 'Law', '数理': 'Math & Physics', '英语': 'English', '钢琴': 'Piano', '小工具与游戏': 'Toys & Tools' };
// 作品类型从标题判断（标题来自源库，这里不改源数据）。同一科目里按 KIND_ORDER 排：先教材，再法条、导图、练习……
const KIND_RULES = [['Source', /源码/], ['Statutes', /检索版|配套解释|法条/], ['Map', /导图|图谱|骨架|图样板/], ['Textbook', /学习版|讲义|教材|教程/], ['Practice', /题库|真题|练习|背词|抽背|习题/], ['Guide', /说明|路线|指南|手册/], ['Materials', /资料|课程|课件/], ['Lab', /模拟器|实验台|工具|查看器|计算器/], ['Game', /贪吃蛇|游戏/]];
const KIND_ORDER = ['Textbook', 'Statutes', 'Map', 'Practice', 'Guide', 'Materials', 'Lab', 'Game', 'Source', ''];
const typeOf = w => (KIND_RULES.find(([, re]) => re.test(w.title)) || [w.kind === 'package' ? 'Materials' : ''])[0];
// 类型已经单独标出来了，标题里重复说明形式的后缀去掉；分号后面是说明文字，也不进标题。原标题留在悬停提示和阅读页顶栏
const TRIM = ['结构化学习版', '全书原生学习版', '原图交互学习版', '学习工作本', '网页程序源码', '检索版', '（阅读版）', '(阅读版)'];
const dispTitle = t => { let s = String(t).split(/[；;]/)[0].trim(); for (const x of TRIM) if (s.endsWith(x) && s.length > x.length + 1) { s = s.slice(0, -x.length).trim(); break; } return s || String(t); };
const TONES = { '法学': [1.0, 0.93, 0.8], '数理': [0.78, 0.86, 1.0], '英语': [1.0, 0.86, 0.74], '钢琴': [0.92, 0.82, 1.0], '小工具与游戏': [0.8, 1.0, 0.9] };
const splitEmoji = s => { s = String(s || ''); const m = s.match(/^([^\p{L}\p{N}]+?)\s+(.+)$/u); return m ? [m[1], m[2]] : ['', s]; };
let works = null, lib = 'AI 网页成品', query = '';
const store = { get(k) { try { const v = JSON.parse(localStorage.getItem('workbench:' + k) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } }, set(k, v) { try { localStorage.setItem('workbench:' + k, JSON.stringify(v)); } catch {} } };
const workURL = p => '/library/' + p.split('/').map(encodeURIComponent).join('/');
function normalize(list) {
  return list.filter(w => w && typeof w.open === 'string' && !w.missing).map((w, i) => {
    const cat = Array.isArray(w.category) ? w.category : [String(w.category || 'Other')]; const [, top] = splitEmoji(cat[0]); const sub = cat.length > 1 ? splitEmoji(cat[cat.length - 1])[1] : '';
    const openPath = lib + '/' + w.open;
    const n = { ...w, openPath, url: workURL(openPath), top, sub, time: Date.parse(w.modified) || 0, planet: planetOf(hash(openPath)), type: typeOf(w), disp: dispTitle(w.title) };
    n.hay = (w.title + ' ' + cat.join(' ') + ' ' + enName(top) + ' ' + (SHORT[top] || '') + ' ' + (SUB_EN[sub] || '') + ' ' + n.type + ' ' + (w.note || '')).toLowerCase(); return n;
  });
}
function fmtBytes(v) { if (v < 1000) return `${v} B`; const u = v >= 1e9 ? 'GB' : v >= 1e6 ? 'MB' : 'KB'; const s = v / (u === 'GB' ? 1e9 : u === 'MB' ? 1e6 : 1000); return `${s.toLocaleString('en-US', { maximumFractionDigits: s < 10 ? 1 : 0 })} ${u}`; }
const fmtDate = t => t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
const subOf = w => SUB_EN[w.sub] || (w.sub ? w.sub : '');
const catOf = w => subOf(w) || enName(w.top);
const tops = () => [...new Set((works || []).map(w => w.top))];
async function loadCatalog() {
  if (works) return works;
  const r = await fetch('/library/index.html', { cache: 'no-store' }); if (!r.ok) throw Error('Catalog unavailable');
  const m = (await r.text()).match(/<script id="workbench-data" type="application\/json">([\s\S]*?)<\/script>/); if (!m) throw Error('Unknown catalog format');
  const db = JSON.parse(m[1]); lib = db.worksLibrary || lib; let all = Array.isArray(db.works) ? db.works : [];
  const list = normalize(all);
  if (!list.length) throw Error('Empty catalog'); works = list; return list;
}

/* ============ 星团：每个大类一个，位置在 sky.js 的 CLUSTERS ============ */
function buildGroups() { return tops().map(t => ({ key: t, label: enName(t), tone: TONES[t] || [0.86, 0.9, 1.0], works: works.filter(w => w.top === t).map(w => ({ w })) })); }
let labelEls = [];
function refreshSky() {
  if (!sky || !works) return;
  sky.setGroups(buildGroups());
  $('labels').innerHTML = ''; labelEls = sky.groups.map((g, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'lab';
    b.innerHTML = `<span class="no">${String(i + 1).padStart(2, '0')}</span>${esc(g.label)}<small>${g.works.length} ${g.works.length === 1 ? 'work' : 'works'}</small>`;
    b.onclick = () => showCluster(g);
    b.onpointerenter = () => { sky.hoverGroup = g; sky.setHot(sky.hot); }; b.onpointerleave = () => { sky.hoverGroup = null; sky.setHot(sky.hot); };
    $('labels').appendChild(b); return b;
  });
  $('index-count').textContent = works.length; renderIndex();
}
function focusGroup(g) { sky.lookAt(g.center, 1.4); }
function placeOverlay() {
  sky.groups.forEach((g, i) => { const el = labelEls[i]; if (!el) return; const p = sky.project(g.anchor);
    if (!p) { el.style.opacity = '0'; return; }
    const d = sky.camera.position.distanceTo(g.center), k = Math.min(1.15, Math.max(0.75, 90 / d));   // 近大远小，太远就淡出
    el.style.opacity = String(1 - Math.min(1, Math.max(0, (d - 350) / 250)));
    el.style.transform = `translate3d(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px,0) translate(-50%,-100%) scale(${k.toFixed(3)})`; el.classList.toggle('hot', sky.hotGroup === g); });
  if (hovered) { const p = sky.project(hovered.pos); if (!p) hideTip(); else placeTip(p); }
}

/* ============ 陀螺仪：手机微微倾斜，镜头跟着挪一点 ============ */
const tiltState = { on: false, base: null, raw: [0, 0], cur: [0, 0] };
const TILT = false;   // 2026-10-15 关掉：用户说「别动态摇晃给我晃晕了……海面是基地」。代码留着，要恢复改成 true
function askTilt() {
  if (!TILT || reduceMotion || tiltState.on || !window.DeviceOrientationEvent || !matchMedia('(pointer:coarse)').matches) return;
  let asked = false; try { asked = localStorage.getItem('tilt') === 'denied'; } catch {}
  if (asked) return;
  const go = () => { tiltState.on = true; addEventListener('deviceorientation', e => { if (e.beta == null) return; tiltState.raw = [e.gamma || 0, e.beta || 0]; if (!tiltState.base) tiltState.base = tiltState.raw.slice(); }); };
  if (typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') go(); else try { localStorage.setItem('tilt', 'denied'); } catch {} }).catch(() => {});
  else go();
}
function tiltTick(dt) {
  if (!tiltState.on || !sky || !tiltState.base) return;
  const b = tiltState.base, r = tiltState.raw, back = 1 - Math.exp(-dt / 4), smooth = 1 - Math.exp(-dt / 0.25);
  b[0] += (r[0] - b[0]) * back; b[1] += (r[1] - b[1]) * back;   // 基准慢慢回中：怎么拿手机都能用
  const cl = v => Math.max(-1, Math.min(1, v / 20));
  tiltState.cur[0] += (cl(r[0] - b[0]) - tiltState.cur[0]) * smooth; tiltState.cur[1] += (cl(r[1] - b[1]) - tiltState.cur[1]) * smooth;
  const on = view === 'sky' ? 1 : 0;
  sky.tilt.x = tiltState.cur[0] * 0.5 * on; sky.tilt.y = -tiltState.cur[1] * 0.3 * on; sky.tilt.yaw = -tiltState.cur[0] * 1.5 * Math.PI / 180 * on;
}

/* ============ 书库交互 ============ */
let hovered = null, touchTip = false, drag = null;
const tip = $('tip');
function showTip(s, touch) { const w = s.work; tip.innerHTML = `<div><div class="k"><i class="star"></i>${esc(catOf(w))}${w.type ? ' · ' + esc(w.type) : ''}</div><div class="t">${esc(w.disp)}</div></div>`; tip.classList.toggle('touch', !!touch); touchTip = !!touch; tip.hidden = false; sky.planet.preload(w.planet); }
function hideTip() { tip.hidden = true; touchTip = false; hovered = null; if (sky) sky.setHot(null); }
function placeTip(p) { const x = Math.max(190, Math.min(innerWidth - 190, p[0])), below = p[1] < 190; tip.style.transform = `translate3d(${x.toFixed(1)}px,${p[1].toFixed(1)}px,0) translate(-50%,${below ? '28px' : 'calc(-100% - 28px)'})`; }
const cv = $('space');
cv.addEventListener('pointerdown', e => { if (ripples && !reduceMotion && view !== 'reader') ripples.add(e.clientX / innerWidth, 1 - e.clientY / innerHeight); }); // 点哪里，哪里荡开一小圈水波
cv.addEventListener('pointerdown', e => { if (view !== 'sky' || !sky) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, pull: 0, touch: e.pointerType === 'touch' }; if (field) { field.dragging = true; field.dragStart(); } else sky.dragging = true; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => {
  if (view !== 'sky' || !sky) return;
  if (drag && e.pointerId === drag.id) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 6) { if (field) { if (!fieldBusy) { if (!drag.mode) drag.mode = !drag.touch || field.mode === 'arc' || Math.abs(dx) > Math.abs(dy) ? 'look' : 'move';
        if (drag.mode === 'look') { field.lookDrag = true; field.lookBy(dx, dy); } else { if (field.atStart() && dy > 0) drag.pull += dy; else drag.pull = 0; field.dragBy(dy); } } } else { sky.drag(dx, dy); if (hovered && !touchTip) hideTip(); } } return; }
  if (e.pointerType === 'touch' || touchTip) return;
  if (field) { cv.style.cursor = !fieldBusy && field.pick(e.clientX, e.clientY) ? 'pointer' : ''; return; }
  const s = sky.pick(e.clientX, e.clientY, 24); if (s !== hovered) { hovered = s; if (s) { sky.setHot(s); showTip(s, false); cv.style.cursor = 'pointer'; } else { hideTip(); cv.style.cursor = ''; } }
});
// 外层点一下：点中星或星团所在的区域都算点中这个星团（触屏的命中半径大一些）
function clusterAt(x, y, touch) {
  const s = sky.pick(x, y, touch ? 34 : 24); if (s) return [s.group, s.work];
  let best = null, bd = 1e9;
  for (const g of sky.groups) { const c = sky.project(g.center); if (!c) continue; const right = new THREE.Vector3(1, 0, 0).applyQuaternion(sky.camera.quaternion), e = sky.project(g.center.clone().addScaledVector(right, g.spec.r)); const rad = Math.max(e ? Math.hypot(e[0] - c[0], e[1] - c[1]) * 1.15 : 0, touch ? 40 : 28), d = Math.hypot(c[0] - x, c[1] - y); if (d < rad && d < bd) { bd = d; best = g; } }
  return best ? [best, null] : null;
}
const endDrag = e => { if (!drag || e.pointerId !== drag.id) return; const d = drag; drag = null; sky.dragging = false; if (field) { field.dragging = false; field.lookDrag = false; if (d.mode === 'move') field.dragEnd(); else field.from = null; }
  if (field) { if (fieldBusy) return; if (d.pull > 140) { exitField(); return; } if (e.type === 'pointerup' && d.moved <= 6) { const c = field.pick(e.clientX, e.clientY); if (c) openCard(c); } return; }   // 航道起点继续往下滑＝退出
  if (e.type === 'pointerup' && d.moved <= 6) { const hit = clusterAt(e.clientX, e.clientY, d.touch); if (hit) showCluster(hit[0], hit[1]); else { hideTip(); showCluster(null); } } };
cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('wheel', e => { if (view === 'sky' && sky) { e.preventDefault(); if (field) { if (!fieldBusy) { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) field.lookBy(-e.deltaX * 0.6, 0); else field.wheel(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1)); } } else sky.zoom(e.deltaY * 0.0012); } }, { passive: false });
let pinch = null; // 触屏双指缩放
cv.addEventListener('touchstart', e => { if (e.touches.length === 2 && !field) { pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); drag = null; if (sky) sky.dragging = false; } }, { passive: true });
cv.addEventListener('touchmove', e => { if (pinch && e.touches.length === 2 && sky) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); sky.zoom((pinch - d) / 400); pinch = d; } }, { passive: true });
cv.addEventListener('touchend', () => { pinch = null; });
tip.addEventListener('click', () => { if (touchTip && hovered) showCluster(hovered.group, hovered.work); });

/* ============ 星团清单：点星团 → 这一类的作品清单（点哪个开哪个）；航道是清单里的「漫游」入口 ============ */
let clusterG = null, fromCluster = null;
function showCluster(g, focusW, scroll) {
  if (!g) { if (!clusterG) return; $('cluster').hidden = true; $('cluster').classList.remove('tall'); clusterG = null; if (sky) { sky.hoverGroup = null; sky.setHot(null); } return; }
  if (!$('index').hidden) showIndex(false);
  const list = inIndexOrder(g.works.map(x => x.w)), no = String(sky.groups.indexOf(g) + 1).padStart(2, '0'); clusterG = g; hideTip();
  $('cl-no').textContent = `${no} · ${list.length} ${list.length === 1 ? 'work' : 'works'}`; $('cl-name').textContent = enName(g.key);
  $('cl-walk').hidden = list.length < 2; $('cl-walk-t').textContent = list.length >= 4 ? 'Walk the corridor' : 'Fly in';
  let h = ''; for (const sb of new Set(list.map(w => w.sub))) { const l = list.filter(w => w.sub === sb); if (sb) h += `<h4 class="ix-s">${esc(SUB_EN[sb] || sb)}<b>${l.length}</b></h4>`; h += l.map(rowHTML).join(''); }
  $('cl-body').innerHTML = h; $('cluster').hidden = false;
  sky.hoverGroup = g; sky.setHot(null); if (!sky.anim) sky.lookAt(g.center, 1.2, innerWidth <= 640 ? 0.55 : 0);   // 镜头转向这个星团，星团高亮：清单和天上的星对得上
  if (focusW) { const b = [...$('cl-body').querySelectorAll('[data-open]')].find(x => x.dataset.open === focusW.openPath); if (b) { b.classList.add('on'); b.scrollIntoView({ block: 'nearest' }); } }   // 点的是某颗星：高亮那件，确认了再打开
  if (scroll != null) $('cl-body').scrollTop = scroll;
}
$('cl-close').onclick = () => showCluster(null);
$('cl-grip').onclick = () => $('cluster').classList.toggle('tall');   // 手机：点把手展开或收回清单
$('cl-walk').onclick = () => { const g = clusterG; showCluster(null); if (g) enterCluster(g); };
$('cl-body').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (!b) return; const w = works.find(x => x.openPath === b.dataset.open); if (!w) return;
  fromCluster = { g: clusterG, scroll: $('cl-body').scrollTop, w }; showCluster(null); openDirect(w); });

/* ============ 内层：航道（≥ 4 件）/ 小弧（2–3 件），1 件直接打开 ============ */
let field = null, fieldBusy = false, fieldBack = null, fieldBarKey = '';
const inIndexOrder = list => [...new Set(list.map(w => w.sub))].flatMap(sb => list.filter(w => w.sub === sb).sort((a, b) => KIND_ORDER.indexOf(a.type) - KIND_ORDER.indexOf(b.type)));   // 和 Index 一样：先科目，科目里按类型
async function fadeSwap(fn) { const f = $('fade'); f.style.opacity = '1'; await sleep(300); await fn(); f.style.opacity = '0'; await sleep(300); }   // 「减少动态效果」：不飞，淡出淡入直接切换
async function enterCluster(g, focusW) {
  if (!sky || field || busy || fieldBusy || view !== 'sky') return;
  const list = inIndexOrder(g.works.map(x => x.w));
  if (list.length === 1) { openWork(list[0], g.stars.find(s => s.work === list[0])); return; }
  fieldBusy = true; hideTip(); sky.anim = null; sky.still = true; cv.style.cursor = '';
  const v = sky.view, cam = sky.camera.position; fieldBack = { keep: { ...v, vYaw: 0, vPitch: 0, vPx: 0, vPy: 0 }, pose: { x: cam.x, y: cam.y, z: cam.z, yaw: v.yaw, pitch: v.pitch } };
  const subs = [...new Set(list.map(w => w.sub))].map(sb => ({ key: sb, label: SUB_EN[sb] || sb || enName(g.key) }));
  list.forEach(w => { w.card = { kicker: w.type || enName(w.top), title: w.disp, foot: subOf(w) || enName(w.top) }; });
  field = new Field(sky, g, list, { small, subs }); field.no = String(sky.groups.indexOf(g) + 1).padStart(2, '0');
  root.classList.add('in-field'); fieldBar(true);
  if (reduceMotion) await fadeSwap(() => field.enter(tween, true, focusW)); else await field.enter(tween, false, focusW);
  fieldBusy = false;
}
async function exitField() {
  if (!field || fieldBusy) return; fieldBusy = true; const f = field;
  root.classList.remove('in-field');
  if (reduceMotion) await fadeSwap(() => f.exit(tween, true, fieldBack.pose)); else await f.exit(tween, false, fieldBack.pose);
  Object.assign(sky.view, fieldBack.keep); sky.applyCamera(); sky.hideGroup(f.g, 0); f.dispose(); field = null; sky.still = false; fieldBusy = false; fieldBar(true);
}
async function openCard(card) {   // 镜头推近这张卡片，直到它占满视野，再淡入作品
  if (busy || fieldBusy) return; busy = true;
  try { const w = card.w; store.set('recent', [w.openPath, ...store.get('recent').filter(x => x !== w.openPath)].slice(0, 30)); await field.pushIn(card, tween, reduceMotion); await openReader(w.url, w.title, w); }
  finally { busy = false; }
}
function fieldBar(force) {
  const key = field ? `${field.no}|${field.subjectAt()}|${field.position()}` : '';
  if (!force && key === fieldBarKey) return; fieldBarKey = key;
  $('caption-text').textContent = field ? (field.mode === 'corridor' ? 'DRAG TO LOOK · SCROLL TO MOVE' : 'DRAG TO LOOK · TAP A CARD') : 'DRAG TO LOOK · TAP A CLUSTER';
  if (!field) return; const sub = field.subjectAt();
  $('field-title').innerHTML = `<span class="no">${field.no}</span>${esc(enName(field.g.key))}${sub && sub !== enName(field.g.key) ? `<i>${esc(sub)}</i>` : ''}`;
  $('field-pos').textContent = field.mode === 'corridor' ? field.position() : `${field.cards.length} works`;
}
$('field-back').onclick = () => exitField();

/* ============ 索引：编号的大类 → 科目 → 作品（标出类型） ============ *//* ============ 索引：编号的大类 → 科目 → 作品（标出类型） ============ */
const rowHTML = w => `<button class="ix-row" type="button" data-open="${esc(w.openPath)}" title="${esc(w.title)}"><span class="t">${esc(w.disp)}</span><span class="k">${esc(w.type)}</span></button>`;
let fromIndex = null, stillTimer = 0;
function renderIndex() {
  if (!works) return;
  const q = query.trim().toLowerCase(), fields = tops(), hit = w => !q || q.split(/\s+/).every(t => w.hay.includes(t));
  const sorted = l => [...l].sort((a, b) => KIND_ORDER.indexOf(a.type) - KIND_ORDER.indexOf(b.type));   // 稳定排序：同类型保持源库顺序
  const row = rowHTML;
  const by = new Map(works.map(w => [w.openPath, w])), recent = q ? [] : store.get('recent').map(p => by.get(p)).filter(Boolean).slice(0, 4);
  let html = '', rail = '';
  if (recent.length) {
    html += `<section class="ix-sec" data-r="recent"><h3 class="ix-h"><span class="no">↺</span>Recently opened<span class="ct">${recent.length}</span></h3>${recent.map(row).join('')}</section>`;
    rail += `<button class="rl" type="button" data-r="recent"><span class="no">↺</span><span class="nm">Recently opened</span><span class="sh">Recent</span><b>${recent.length}</b></button>`;
  }
  fields.forEach((t, i) => {
    const all = works.filter(w => w.top === t), list = all.filter(hit), no = String(i + 1).padStart(2, '0');
    rail += `<button class="rl${i === 0 && recent.length ? ' gap' : ''}${list.length ? '' : ' dim'}" type="button" data-r="${i}"><span class="no">${no}</span><span class="nm">${esc(enName(t))}</span><span class="sh">${esc(SHORT[t] || enName(t))}</span><b>${list.length}</b></button>`;
    if (!list.length) return;
    let h = `<section class="ix-sec" data-r="${i}"><h3 class="ix-h"><span class="no">${no}</span>${esc(enName(t))}<span class="ct">${list.length}</span></h3>`;
    for (const sub of new Set(list.map(w => w.sub))) { const l = sorted(list.filter(w => w.sub === sub)); if (sub) h += `<h4 class="ix-s">${esc(SUB_EN[sub] || sub)}<b>${l.length}</b></h4>`; h += l.map(row).join(''); }
    html += h + '</section>';
  });
  $('ix-body').innerHTML = html || '<p class="ix-empty">Nothing matches.</p>'; $('ix-rail').innerHTML = rail;
  $('ix-sum').textContent = q ? `${works.filter(hit).length} of ${works.length} works` : `${works.length} works · ${fields.length} fields`;
  padIndex(); spy();
}
// 底部留白，让最后一类也能滚到顶部，点目录时位置和高亮一致
function padIndex() { const box = $('index'); if (box.hidden) return; const secs = box.querySelectorAll('.ix-sec'), last = secs[secs.length - 1];
  $('ix-pad').style.height = last ? Math.max(0, box.clientHeight - (parseFloat(box.style.getPropertyValue('--ix-top')) || 110) - (innerWidth <= 900 ? 60 : 20) - last.offsetHeight - box.querySelector('.ix-foot').offsetHeight) + 'px' : '0'; }
let spyCur = null;
function spy() {   // 滚到哪一类，左边（手机是上方）的目录就亮哪一类
  const box = $('index'); if (box.hidden) return;
  const line = (parseFloat(box.style.getPropertyValue('--ix-top')) || 110) + (innerWidth <= 900 ? 80 : 40);
  let cur = null; for (const s of box.querySelectorAll('.ix-sec')) { if (cur === null || s.getBoundingClientRect().top <= line) cur = s.dataset.r; }
  let on = null; box.querySelectorAll('.rl').forEach(b => { const hitB = b.dataset.r === cur; b.classList.toggle('on', hitB); if (hitB) on = b; });
  if (on && cur !== spyCur && innerWidth <= 900) on.scrollIntoView({ inline: 'nearest', block: 'nearest' }); spyCur = cur;
}
function showIndex(open, opts = {}) {
  const box = $('index'); clearTimeout(stillTimer);
  if (open) {
    const was = !box.hidden; box.hidden = false; root.classList.add('indexing'); $('index-open').setAttribute('aria-expanded', 'true');
    if (!was) { hideTip(); showCluster(null); box.style.setProperty('--ix-top', box.querySelector('.ix-top').offsetHeight + 'px'); renderIndex(); box.scrollTop = opts.scroll || 0; spyCur = null; spy(); }
    if (opts.focus) { $('search').focus({ preventScroll: true }); $('search').select(); }
    stillTimer = setTimeout(() => { if (!box.hidden) { indexStill = true; stop(); } }, 500);   // 索引完全盖住星空以后停掉渲染，省电
    return;
  }
  if (box.hidden) return;
  box.hidden = true; root.classList.remove('indexing'); $('index-open').setAttribute('aria-expanded', 'false');
  if (!opts.keep) { query = ''; $('search').value = ''; }
  $('search').blur(); indexStill = false; start(); wakeDock();
}
$('index-open').onclick = () => showIndex(true, { focus: matchMedia('(hover:hover)').matches });   // 搜索就在索引顶部；电脑上打开就能直接打字，手机上不自动弹键盘
$('index-close').onclick = () => showIndex(false);
$('index').addEventListener('scroll', () => requestAnimationFrame(spy), { passive: true });
addEventListener('resize', () => { const box = $('index'); if (box.hidden) return; box.style.setProperty('--ix-top', box.querySelector('.ix-top').offsetHeight + 'px'); padIndex(); spy(); });
$('ix-rail').addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; const s = $('index').querySelector(`.ix-sec[data-r="${b.dataset.r}"]`); if (s) s.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); });
$('ix-body').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (!b) return; const w = works.find(x => x.openPath === b.dataset.open); if (!w) return;
  fromIndex = $('index').scrollTop; showIndex(false, { keep: true }); openDirect(w); });
let searchTimer;
$('search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = e.target.value; renderIndex(); $('index').scrollTop = 0; }, 90); });
$('search').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); if (e.target.value) { e.target.value = ''; query = ''; renderIndex(); } else showIndex(false); }
  if (e.key === 'Enter') { const b = $('ix-body').querySelector('[data-open]'); if (b) b.click(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('index').hidden) { showIndex(false); return; }
  if (e.key === 'Escape' && clusterG) { showCluster(null); return; }
  if (field && view === 'sky' && $('index').hidden && !fieldBusy && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); field.step(1); return; }
    if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); field.step(-1); return; }
    if (e.key === 'Escape') { exitField(); return; }
  }
  if (view === 'sky' && ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)))) { e.preventDefault(); showIndex(true, { focus: true }); }
});
$('classic').onclick = () => { showIndex(false); openReader('/library/index.html', 'Legacy index', null); };

/* ============ 解锁 ============ */
function nextTarget() { const p = new URLSearchParams(location.search).get('next'); return p?.startsWith('/library/') && p !== '/library/index.html' && p !== '/library/' ? p + location.hash : null; }
function cleanURL() { if (location.search || location.hash) history.replaceState(null, '', '/'); }
let hiBand = false;
async function ensureSky() {
  if (!renderer) return; await (bootSky() || Promise.resolve()).catch(() => null);
  if (sky && wantHiBand() && !hiBand) { hiBand = true; loadTex('/assets/band3-16k.jpg').then(setBand).catch(() => {}); }
}
const tween = (ms, fn, ease = t => t) => new Promise(res => { const t0 = performance.now(); const step = now => { const k = Math.min(1, Math.max(0, (now - t0) / ms)); try { fn(ease(k)); } catch (e) { console.error(e); } if (k < 1) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });   // 单帧出错也要把动画走完，不能把界面卡死
async function enterSky(next, animate) {
  cleanURL(); await ensureSky(); refreshSky();
  if (!works || !sky) { setView('sky'); openReader('/library/index.html', 'Legacy index', null); return; }
  $('title').classList.remove('on');
  if (animate && !reduceMotion) {   // 作品星在远处依次亮起，镜头往前滑进书库
    root.classList.add('arriving'); setView('sky');
    const glide = sleep(450).then(() => sky.glide(2));
    await tween(900, k => sky.setReveal(k)); await glide;
    root.classList.remove('arriving');
  } else { sky.setReveal(1); sky.home(true); setView('sky'); }
  if (next) { const w = works.find(x => x.url === next.replace(/#.*$/, '')); openReader(next, w ? w.title : '', w || null); }
}
/* 公开版（2026-10-14）：构建时打进公开钥匙，门口不要密码，点 Enter 就进；没打进钥匙时仍是密码门 */
const OPEN_KEY = '__OPEN_KEY__', OPEN = /^[A-Za-z0-9+/]{43}=$/.test(OPEN_KEY);
async function resume() {   // sw.js 被系统回收后自动续上：用公开钥匙重新解锁
  const st = await rpc('STATUS').catch(() => null); if (!st?.ok) return true;
  if (!st.unlocked) { if (!OPEN) return false; const r = await rpc('UNLOCK', { key: OPEN_KEY }, 180000).catch(() => null); if (!r?.ok) return false; }
  return true;
}
// 公开版：门口一出现就在后台解锁、取目录（2026-10-15），点 Enter 时多半已经好了；失败了下次再从头来
let warm = null;
// 老访客的浏览器里还留着旧版 sw.js，它读不懂新格式的目录：解锁失败就先等新版 sw.js 接班（最多 15 秒），再自动重试一次
async function swFresh(ms = 15000) {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null); if (!reg) return;
  const swap = new Promise(r => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, ms); });
  await reg.update().catch(() => {}); if (reg.installing || reg.waiting) await swap;
}
function warmUp() {
  if (!OPEN) return null;
  const once = () => rpc('UNLOCK', { key: OPEN_KEY }, 180000).catch(() => null);
  return warm || (warm = once().then(async r => { if (!r?.ok) { await swFresh(); r = await once(); } if (!r?.ok) warm = null; else loadCatalog().catch(() => {}); return r; }));
}
async function openLibrary(password) {
  const btn = $('submit'); btn.disabled = true; setStatus('status', OPEN ? '' : 'Unlocking…');
  const slow = OPEN ? setTimeout(() => setStatus('status', 'Opening the library…'), 500) : 0;   // 还没准备好就告诉人在开，不让人以为卡死了
  try {
    const r = OPEN ? await warmUp() : await rpc('UNLOCK', { password }, 180000); clearTimeout(slow); $('password').value = ''; if (!r?.ok) throw Error(OPEN ? 'Could not open the library. Try again.' : 'Wrong password.');
    setStatus('status', ''); $('gate').classList.add('leaving'); $('password').blur(); btn.blur();
    await Promise.all([loadCatalog().catch(() => {}), ensureSky()]);
    await enterSky(nextTarget(), true);
  } catch (e) { clearTimeout(slow); setStatus('status', e.message, true); shake('unlock'); if (!OPEN) $('password').focus(); }
  finally { btn.disabled = false; }
}
$('unlock').addEventListener('submit', e => { e.preventDefault(); askTilt(); openLibrary($('password').value); }); window.__zone_on = true;   // 页面里的内联兜底从这里起不再接管   // 提交是一次用户手势，iPhone 的陀螺仪授权只能在这时申请
if (OPEN) {   // 门口只剩一个 Enter：点它，或在门口任何地方按回车
  root.classList.add('open-gate'); $('password').disabled = true; $('submit').setAttribute('aria-label', 'Enter');
  addEventListener('keydown', e => { if (e.key === 'Enter' && view === 'gate' && !$('gate').classList.contains('leaving') && document.activeElement !== $('submit')) { e.preventDefault(); $('unlock').requestSubmit(); } });
}
function resetGate() { $('gate').classList.remove('leaving'); $('title').classList.add('on'); root.classList.remove('arriving'); if (sky) sky.setReveal(0); }
function relock(message, next) { fromIndex = null; fromCluster = null; showCluster(null); showIndex(false); if (field) { sky.hideGroup(field.g, 0); field.dispose(); field = null; fieldBusy = false; root.classList.remove('in-field'); if (fieldBack) Object.assign(sky.view, fieldBack.keep); sky.still = false; } blankFrame(); readerRendering = false; resetGate(); setView('gate'); setStatus('status', message, true); if (next) history.replaceState(null, '', '/?next=' + encodeURIComponent(next.replace(/#.*$/, ''))); }
setInterval(() => { if (view === 'gate' || document.hidden) return; resume().then(ok => { if (!ok) relock('Session ended. Enter the password again.'); }); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && view !== 'gate') resume(); });   // 从后台回来先续上，免得作品里的图片取不到

/* ============ 进入作品：飞向星球，作品从星球表面浮现 ============ */
let currentURL = null, busy = false;
const frameEl = $('frame');
function navFrame(url) { try { frameEl.contentWindow.location.replace(url); } catch { frameEl.src = url; } }
async function openDirect(w) {   // 从索引打开：直接进阅读器
  if (busy) return; busy = true;
  try { store.set('recent', [w.openPath, ...store.get('recent').filter(x => x !== w.openPath)].slice(0, 30)); hideTip(); await openReader(w.url, w.title, w); } finally { busy = false; }
}
async function openWork(w, star) {
  if (busy) return; busy = true;
  try {
    store.set('recent', [w.openPath, ...store.get('recent').filter(x => x !== w.openPath)].slice(0, 30));
    hideTip(); root.classList.add('diving');
    if (view === 'sky' && sky && star && !reduceMotion) await sky.dive(star, w.planet);
    await openReader(w.url, w.title, w);
  } finally { busy = false; }
}
async function openReader(url, title, w) {
  if (!(await resume())) { relock('Session ended. Enter the password again.', url); return; }
  const onPlanet = !!(sky && sky.approach > 0.5);
  // 2026-10-15：解密、加载期间星空照常在动（以前从索引打开时这里就停了，Decrypting 那几秒画面是死的）；作品显示出来 0.9 秒后才停
  readerRendering = true; indexStill = false; if (onPlanet) sky.settle(true);
  $('reader-title').textContent = title || ''; document.title = (title || 'Work') + ' · Sidereal';
  $('loadline').textContent = w && w.bytes > 2e6 ? `Decrypting · ${fmtBytes(w.bytes)}` : 'Decrypting'; $('loadline').hidden = false;
  root.classList.remove('reading'); currentURL = url; setView('reader'); navFrame(url);
}
frameEl.addEventListener('load', () => {
  if (!currentURL) return;
  root.classList.add('reading'); $('loadline').hidden = true;
  try { const t = frameEl.contentDocument?.title; if (t && view === 'reader') $('reader-title').textContent = t; } catch {}
  setTimeout(() => { if (view === 'reader' && root.classList.contains('reading')) { readerRendering = false; stop(); } }, 900);
});
function blankFrame() { currentURL = null; root.classList.remove('reading'); navFrame('about:blank'); }
async function closeReader() {
  const onPlanet = !!(sky && sky.approach > 0.5);
  readerRendering = true; start(); root.classList.remove('reading');
  if (field && field.pushing) readerRendering = true;
  await sleep(reduceMotion ? 0 : 450);
  blankFrame(); readerRendering = false;
  setView(works ? 'sky' : 'gate');
  if (field && field.pushing) await field.pullBack(tween, reduceMotion);   // 从航道打开的：镜头拉回航道原来的位置
  else if (onPlanet && !reduceMotion) await sky.rise(); else if (sky && onPlanet) { sky.setApproach(0); }
  root.classList.remove('diving');
  if (fromIndex !== null && works && view === 'sky') { const scroll = fromIndex; fromIndex = null; showIndex(true, { scroll }); }
  else if (fromCluster && works && view === 'sky' && !field) { const c = fromCluster; fromCluster = null; showCluster(c.g, c.w, c.scroll); }
}
$('back').onclick = closeReader;

/* ============ 底栏：看星空时几秒不操作就淡出，动一下就回来 ============ */
let dockTimer = 0, dockHover = false;
function wakeDock() {
  root.classList.remove('dock-idle'); clearTimeout(dockTimer);
  dockTimer = setTimeout(() => { if (view === 'sky' && $('index').hidden && !dockHover) root.classList.add('dock-idle'); }, 3500);
}
for (const t of ['pointermove', 'pointerdown', 'wheel', 'keydown']) addEventListener(t, wakeDock, { passive: true });
$('dock').addEventListener('pointerenter', () => { dockHover = true; wakeDock(); }); $('dock').addEventListener('pointerleave', () => { dockHover = false; wakeDock(); });

/* ============ 启动 ============ */
if (location.hostname === 'localhost') window.__zone = { get sky() { return sky; }, get dpr() { return dpr; }, get field() { return field; }, get fieldBusy() { return fieldBusy; } };
resize(); addEventListener('resize', resize); start();
holdAdapt(5000); bootSky(); setTimeout(() => { if (view === 'gate') $('title').classList.add('on'); }, 300);
swReady = setup();
swReady.then(async () => {
  const st = await rpc('STATUS').catch(() => null);
  if (st?.ok && st.unlocked) { $('title').classList.remove('on'); await loadCatalog().catch(() => {}); await enterSky(nextTarget(), false); return; }
  setStatus('status', nextTarget() ? (OPEN ? 'Enter to continue' : 'Unlock to continue') : '');
  warmUp()?.catch(() => {});   // 公开版：人还在看门口，后台先把书库准备好
  if (window.__enter && OPEN && view === 'gate') { window.__enter = 0; openLibrary(''); }   // 主程序到之前就按过 Enter：接着进门（以前会整页刷新，看起来没反应）
  if (matchMedia('(hover:hover)').matches) (OPEN ? $('submit') : $('password')).focus({ preventScroll: true });
}).catch(e => setStatus('status', e.message, true));
