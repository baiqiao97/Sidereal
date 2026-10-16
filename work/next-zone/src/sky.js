// 书库：水天相接。NASA 16K 银河带 + 全天底图 + 实时星点（任何分辨率都锐利），海面实时倒映。
// 远景（天空、星点）在无限远；作品星是悬在海面上空、远近不同的星团（世界单位是米，海面 y = 0），相机能真的平移。
// 肉眼可见的星来自耶鲁亮星星表：真实位置、星等、颜色，按大气物理消光和闪烁。
import * as THREE from 'three';
import { rng } from './forms.js';
import { Planet } from './planet.js';

const BAND_LAT = 21.97 * Math.PI / 180;
const SKY_FN = /* glsl */`
uniform sampler2D uBand, uBase; uniform mat3 uGal; uniform float uExposure, uNavy, uBandLat, uBandOn, uIn;
vec3 skyCol(vec3 d){
  vec3 g = uGal * d;
  float l = atan(g.y, g.x), b = asin(clamp(g.z, -1.0, 1.0));
  vec2 uv = vec2(0.5 - l / 6.2831853, 0.5 + b / 3.14159265);
  vec2 dx = dFdx(uv), dy = dFdy(uv); dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
  vec3 c = textureGrad(uBase, uv, dx, dy).rgb;
  float ab = abs(b);
  if (ab < uBandLat && uBandOn > 0.0) {   // 银河带到了以后 1 秒多淡入，不跳
    float k = 3.14159265 / (2.0 * uBandLat);
    vec3 band = textureGrad(uBand, vec2(uv.x, 0.5 + b / (2.0 * uBandLat)), vec2(dx.x, dx.y * k), vec2(dy.x, dy.y * k)).rgb;
    c = mix(c, mix(band, c, smoothstep(uBandLat - 0.05, uBandLat - 0.004, ab)), uBandOn);
  }
  float h = clamp(d.y, 0.0, 1.0), hd = degrees(asin(h));
  // 大气（2026-10-15）：越贴近海平线，光要穿过的空气越厚（Kasten–Young 气团，封顶 12，免得地平线上全黑），银河越暗、越偏红——
  // 海平线附近的银心因此是一团暖色的雾光，不再是贴上去的照片。海平线上方再叠一层薄雾：低处最亮、往上很快淡掉，
  // 水天之间是一段有厚度的渐变，而不是一条线
  float X = min(1.0 / (h + 0.50572 * pow(hd + 6.07995, -1.6364)), 10.0);
  vec3 ext = exp(-0.921 * vec3(0.075, 0.105, 0.145) * (X - 1.0));
  vec3 haze = vec3(0.022, 0.029, 0.040) * exp(-hd / 1.6) + vec3(0.008, 0.012, 0.020) * exp(-hd / 6.0);
  return c * ext * uExposure * uIn + (vec3(0.010, 0.019, 0.05) * (1.0 - h * 0.5) + vec3(0.03, 0.05, 0.085) * exp(-h * 14.0) * 0.7 + haze) * uNavy;
}`;
const SKY_VS = /* glsl */`varying vec3 vDir; void main(){ vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */`${SKY_FN} varying vec3 vDir; void main(){ gl_FragColor = vec4(skyCol(normalize(vDir)), 1.0); }`;
const SEA_VS = /* glsl */`varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SEA_FS = /* glsl */`${SKY_FN}
uniform vec3 uCam; uniform float uTime, uCalm; varying vec3 vWorld;
// 12 组深水波：波长从 11 米到 0.3 米按几何级数递减，方向围绕风向散开，按 ω = √(gk) 传播；
// 某组波在一个像素里超过约半个周期就淡掉，远处和海天交界处不会闪
vec2 waveGrad(vec2 p){
  vec2 g = vec2(0.0);
  for (int i = 0; i < 12; i++) {
    float fi = float(i), ang = 0.35 + (fract(sin(fi * 12.9898) * 43758.5453) - 0.5) * 2.1;
    vec2 dir = vec2(cos(ang), sin(ang));
    float lambda = 11.0 * pow(0.72, fi), k = 6.2831853 / lambda, w = sqrt(9.8 * k);
    float x = dot(dir, p) * k, aa = 1.0 - smoothstep(1.2, 3.0, fwidth(x));
    g += dir * (0.13 * pow(0.86, fi)) * cos(x - w * uTime * 0.55 + fi * 1.7) * aa;   // 2026-10-15：海面是基地，浪放慢、放平
  }
  return g * uCalm;
}
void main(){
  float dist = length(vWorld - uCam);
  vec2 grad = waveGrad(vWorld.xz);
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y)), v = normalize(vWorld - uCam);
  vec3 r = reflect(v, n); r.y = abs(r.y) + 0.0005; vec3 rr = normalize(r);
  vec3 tg = normalize(vec3(-v.z, 0.0, v.x)); float sm = 0.001 + 0.012 * exp(-abs(v.y) * 30.0);
  vec3 refl = (skyCol(rr) * 2.0 + skyCol(normalize(rr + tg * sm)) + skyCol(normalize(rr - tg * sm))) * 0.25;
  float fres = 0.28 + 0.72 * pow(1.0 - max(dot(-v, n), 0.0), 4.0);
  vec3 col = mix(vec3(0.003, 0.006, 0.014), refl * 0.93, fres);
  col *= 1.0 - 0.25 * exp(-abs(v.y) * 260.0);
  // 远处的海面隐进海平线上那层雾里：越远越接近雾的颜色（比天低一点），水天之间是渐变，不是一条线
  float fog = 1.0 - exp(-dist / 1600.0);
  col = mix(col, skyCol(normalize(vec3(v.x, 0.004, v.z))) * 0.82, fog * fog);
  gl_FragColor = vec4(col, 1.0);
}`;
// 星点：方向存在银道坐标里，着色器里转到地平坐标。前 uNB 颗是耶鲁亮星星表里肉眼可见的星（贴图里已抠掉），
// 其后是贴图里找到的带外暗星（带内的暗星留在 16K 贴图上，所以它们在银河带边缘渐隐）。
// 我们站在海边，星光要穿过大气：气团越厚（越贴近地平线）消光越强、越偏红，闪烁也越厉害。
const FIELD_VS = /* glsl */`
attribute vec3 aDir; attribute vec4 aCol; uniform mat3 uGal; uniform float uDpr, uTime, uBandLat, uFade, uNB, uIn;
varying vec3 vC; varying float vGlow, vK;
// 四个不可公约的频率叠出不重复的起伏，方差归一到 1。主周期 20 秒（用户定的），其余三个只让起伏不那么规整；
// 宇宙是寂寥的，不要高频乱闪
float wobble(float t, float p){ return sin(t * 0.314 + p) * 1.2 + sin(t * 0.53 + p * 2.3) * 0.6 + sin(t * 0.87 + p * 3.7) * 0.36 + sin(t * 1.37 + p * 5.1) * 0.24; }
void main(){
  vec3 w = aDir * uGal; float s = w.y;
  float m = aCol.a * 12.75 - 2.0;                                    // 视星等
  float cat = float(gl_VertexID) < uNB ? 1.0 : 0.0;
  float ab = abs(asin(clamp(aDir.z, -1.0, 1.0)));
  float h = degrees(asin(clamp(s, 0.0, 1.0))), X = 1.0 / (max(s, 0.0) + 0.50572 * pow(h + 6.07995, -1.6364));   // Kasten–Young 气团
  vec3 ext = exp(-0.921 * vec3(0.08, 0.12, 0.18) * (X - 1.0));      // 消光（星等/气团，红绿蓝），以天顶为基准；2026-10-15 放轻，近海平线的星不再那么橙
  float sig = min(0.045 * pow(X, 1.25), 0.4);                        // 闪烁幅度：天顶约 5%，高度 10° 约 40%
  float ph = fract(sin(dot(aDir, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
  float chroma = smoothstep(2.2, -0.5, m) * smoothstep(0.6, 0.12, s) * 0.5;   // 亮星贴近地平线时闪出颜色（大气色散）
#ifdef MIRROR
  float t = uTime * 0.6;                                             // 倒影随浪起伏，比直接看的星慢
#else
  float t = uTime;
#endif
  vec3 nc = vec3(wobble(t * 1.07, ph + 1.3), wobble(t * 0.93, ph + 2.9), wobble(t * 1.13, ph + 4.1));
  vec3 tw = exp(sig * mix(vec3(wobble(t, ph)), nc, chroma) - 0.5 * sig * sig);   // 对数正态起伏，平均亮度不变
  float f = exp(-0.921 * (m - 6.5));                                 // 相对 6.5 等星的亮度
  // 星像（2026-10-15）：核心大小和以前一样按星等（暗星是针尖）；亮星另外加一圈 Moffat 光晕和极淡的斜十字芒，
  // 越亮越大——亮星有了体积和层次，暗星不变，不再都是一样的光点
  vGlow = smoothstep(3.6, -1.4, m);
  float sc = 0.1508 * (1.05 + 0.55 * pow(max(0.0, 7.0 - m), 1.2));   // 核心高斯的半径（CSS 像素），和改版前的核心一样
  float halfw = max(3.2 * sc, vGlow * 12.0);                        // 精灵半宽：暗星只包住核心，亮星留出光晕和芒的地方
  vK = halfw / sc;                                                  // 精灵半宽 = 几个核心半径
  float size = 2.0 * halfw;
  vec3 dir = w;
  // 亮星核心过曝成白色，颜色留在光晕里
  float a = min(0.22 + 0.68 * pow(f, 0.55), 2.2) * (1.0 + vGlow * 0.8) * mix(smoothstep(uBandLat - 0.05, uBandLat - 0.004, ab), 1.0, cat) * uFade * uIn * step(0.0, s)
          * smoothstep(6.16, 4.96, m);                               // 极限星等约 5.56 等：在原来 5.75 等的基础上再少 20%（2026-10-15 用户要求），天空要寂寥
#ifdef MIRROR
  // 海面倒影：方向关于海平面翻转，被浪拉成一小段竖线、上下晃动、忽明忽暗；反射率和海面着色器用同一条菲涅尔曲线
  float sp = max(s, 0.0);                                           // 地平线以下的星 a 已经是 0，这里防 exp 溢出成 NaN
  a *= (0.28 + 0.72 * pow(1.0 - sp, 4.0)) * 0.93 * (1.0 - 0.25 * exp(-sp * 260.0)) * exp(0.25 * wobble(uTime * 0.7, ph * 1.7) - 0.03);
  dir.y = min(-sp + (sin(uTime * 0.25 + ph * 3.1) * 0.6 + sin(uTime * 0.42 + ph * 1.3) * 0.4) * 0.0025 * (0.3 + sp), -0.0015);   // 2026-10-15：倒影只轻轻起伏，不晃
  size *= 3.0;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(normalize(dir) * 9000.0, 1.0);
  gl_PointSize = size * uDpr;
  vC = aCol.rgb * ext * tw * a;
}`;
const FIELD_FS = /* glsl */`varying vec3 vC; varying float vGlow, vK;
void main(){
  vec2 p = (gl_PointCoord - 0.5) * 2.0;
#ifdef MIRROR
  p.x *= 3.0;
#endif
  float r2 = dot(p, p); if (r2 > 1.0) discard;
  float edge = 1.0 - r2;                                             // 精灵边缘归零，不留方框
  vec2 q = p * vK; float rc2 = dot(q, q);                            // 以核心半径为单位
  float core = exp(-0.5 * rc2);
  float halo = vGlow * 0.085 * pow(1.0 + rc2 / 5.0, -1.6);           // Moffat 光晕：大气和眼睛把亮星的光散开一圈
  float spike = 0.0;
#ifndef MIRROR
  vec2 s = abs(vec2(q.x + q.y, q.x - q.y)) * 0.7071;                 // 斜 45° 的两道细芒，只有最亮的几颗星看得出
  float L = 2.0 + 16.0 * vGlow;
  spike = vGlow * vGlow * 0.16 * (exp(-s.x * s.x * 1.2 - s.y / L) + exp(-s.y * s.y * 1.2 - s.x / L));
#endif
  gl_FragColor = vec4(vC * (core + (halo + spike) * edge), 1.0);
}`;
const STAR_VS = /* glsl */`
attribute float aSize, aSeed, aHot, aMirror, aOrder, aGrp; attribute vec3 aCol;
uniform float uTime, uPx, uMinPx, uFade, uFocus, uFocusIdx, uReveal, uHideGrp, uHideK; varying vec3 vCol; varying float vA;
void main(){
  vec3 p = position; float L = length(p.xz);
  if (aMirror > 0.5) { p.x += sin(uTime * 0.35 + p.z * 0.3) * 0.0015 * L; p.y += sin(uTime * 0.25 + p.x * 0.4) * 0.0008 * L; }   // 倒影只随浪微微动（2026-10-15 调小，不晃）
  vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.1);
  float tw = 0.9 + 0.1 * sin(uTime * (0.25 + fract(aSeed * 7.1) * 0.2) + aSeed * 40.0);   // 约 20 秒一轮，和天上的星一致
  float focus = (abs(floor(aSeed) - uFocusIdx) < 0.5 && aMirror < 0.5) ? uFocus : 0.0;
  float on = smoothstep(aOrder * 0.8, aOrder * 0.8 + 0.2, uReveal);   // 解锁后由近到远依次亮起
  gl_PointSize = min(max(aSize * uPx / z, uMinPx) * (1.0 + aHot * 0.6) * (0.4 + 0.6 * on), 160.0 * uMinPx / 3.0);
  float air = exp(-z / 1100.0);                                      // 空气透视：远的星团略暗、略偏冷，远近一眼看得出
  vCol = mix(vec3(dot(aCol, vec3(0.3, 0.45, 0.25))) * vec3(0.8, 0.88, 1.0), aCol, 0.5 + 0.5 * air) * (1.0 + aHot * 0.8);
  vA = tw * uFade * (aMirror > 0.5 ? 0.38 : 1.0) * (1.0 - focus) * on * smoothstep(1.5, 6.0, z) * (0.6 + 0.4 * air);   // 镜头擦身而过时不糊成一大团
  if (abs(aGrp - uHideGrp) < 0.5) vA *= 1.0 - uHideK;   // 飞进这个星团后，它的星已经展开成卡片
}`;
const STAR_FS = /* glsl */`varying vec3 vCol; varying float vA;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  gl_FragColor = vec4(vCol * (exp(-r * r * 18.0) * 1.6 + exp(-r * r * 3.0) * 0.55) * vA, 1.0); }`;

const EN = { '法学': 'Jurisprudence', '数理': 'Mathematics & Physics', '英语': 'English', '钢琴': 'Piano', '小工具与游戏': 'Toys & Tools' };
export const enName = t => EN[t] || t;
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const dirOf = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const D = Math.PI / 180, EYE = 2.0;   // 眼高 2 米
// 星团位置：方位角（度，0 = 正前方 −z，正数偏右）、水平距离、中心高度、散开半径，单位米。
// 法学最近，按科目扎堆；其他几类远近不同。竖屏起始视野里能看到法学、数理、小工具，英语和钢琴要拖一下
const CLUSTERS = { '法学': { az: -22, d: 90, y: 17, r: 14 }, '数理': { az: -4, d: 170, y: 22, r: 4.5 }, '小工具与游戏': { az: 7, d: 140, y: 12, r: 4 }, '英语': { az: 26, d: 230, y: 26, r: 3 }, '钢琴': { az: 40, d: 300, y: 18, r: 3 } };
const spot = (az, d, y) => new THREE.Vector3(Math.sin(az * D) * d, y, -Math.cos(az * D) * d);
const PAN_X = 3, PAN_Y = 0.6;   // 拖动时相机最多横移 3 米、上下 0.6 米

export class SkyScene {
  constructor(renderer, { base, band = null, stars = null }, small) {
    this.small = small; this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 30000); this.camera.rotation.order = 'YXZ';
    this.view = { yaw: 0.28, pitch: 0.16, fov: 60, vYaw: 0, vPitch: 0, x: 0, y: EYE, z: 0, px: 0, py: 0, vPx: 0, vPy: 0 };
    this.tilt = { x: 0, y: 0, yaw: 0 };   // 陀螺仪：横移、上下（米）和一点点转头（弧度），main.js 填
    this.time = 0; this.idle = 0; this.anim = null;
    // 银河的朝向：银心在正前方、贴着海平线，银道面斜着升起来
    const gW = new THREE.Vector3(0, Math.sin(3 * D), -Math.cos(3 * D)).normalize();
    const pW = new THREE.Vector3(Math.cos(58 * D), Math.sin(58 * D), 0).normalize();
    const nW = new THREE.Vector3().crossVectors(pW, gW).normalize(), yW = new THREE.Vector3().crossVectors(nW, gW).normalize();
    this.gal0 = [gW, yW, nW];
    this.uSky = { uBand: { value: band }, uBase: { value: base }, uGal: { value: new THREE.Matrix3() }, uExposure: { value: 1.0 }, uNavy: { value: 1 }, uBandLat: { value: BAND_LAT }, uBandOn: { value: band ? 1 : 0 }, uIn: { value: 1 } };
    this.want = { sky: 1, band: band ? 1 : 0, stars: 0 };   // 素材到了以后各自 1.2 秒淡入（update 里走），画面不跳
    this.setGal(0);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 64, 32), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.uSky, side: THREE.BackSide, depthWrite: false }));
    this.sky.renderOrder = -3; this.scene.add(this.sky);
    this.seaUni = { ...this.uSky, uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uCalm: { value: 0.11 } };   // 2026-10-15：0.16 → 0.11，海面更平
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000, 1, 1), new THREE.ShaderMaterial({ vertexShader: SEA_VS, fragmentShader: SEA_FS, uniforms: this.seaUni, depthWrite: false }));
    sea.rotation.x = -Math.PI / 2; sea.renderOrder = -2; this.scene.add(sea);
    // 实时星点（stars2.bin 可以晚到，到了再调 setStars）
    this.fieldUni = { uGal: this.uSky.uGal, uDpr: { value: 1 }, uTime: { value: 0 }, uBandLat: this.uSky.uBandLat, uFade: { value: 1 }, uNB: { value: 0 }, uIn: { value: 0 } };
    if (stars) this.setStars(stars);
    this.starUni = { uTime: this.fieldUni.uTime, uPx: { value: 1 }, uMinPx: { value: 3 }, uFade: { value: 1 }, uFocus: { value: 0 }, uFocusIdx: { value: -1 }, uReveal: this.fieldUni.uReveal = { value: 0 }, uHideGrp: { value: -1 }, uHideK: { value: 0 } };
    this.stars = []; this.groups = []; this.hot = null; this.hotGroup = null;
    this.layer = new THREE.Group(); this.scene.add(this.layer);
    this.planet = new Planet(renderer, small ? '4k' : '8k'); this.scene.add(this.planet.group); this.approach = 0;
  }
  setBand(tex) { const old = this.uSky.uBand.value; this.uSky.uBand.value = tex; this.want.band = 1; if (old && old !== tex) old.dispose(); }
  setBase(tex) { const old = this.uSky.uBase.value; this.uSky.uBase.value = tex; this.want.sky = 1; if (old && old !== tex) old.dispose(); }
  waitBase() { this.uSky.uIn.value = 0; this.want.sky = 0; }   // 先用占位底图起步：海和雾立刻在动，底图到了再淡入
  setStars(stars) {
    if (this.field || !stars) return;
    const n = this.small ? Math.min(stars.n, 60000) : stars.n; this.fieldUni.uNB.value = stars.nb;
    const dirA = new THREE.BufferAttribute(stars.dir.subarray(0, n * 3), 3, true), colA = new THREE.BufferAttribute(stars.col.subarray(0, n * 4), 4, true);
    const geo = count => { const g = new THREE.BufferGeometry(); g.setAttribute('aDir', dirA); g.setAttribute('position', dirA); g.setAttribute('aCol', colA); g.setDrawRange(0, count); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); return g; };
    const mat = defines => new THREE.ShaderMaterial({ vertexShader: FIELD_VS, fragmentShader: FIELD_FS, uniforms: this.fieldUni, defines, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    this.field = new THREE.Points(geo(n), mat({}));
    // 倒影只画亮于 5.5 等的星表星（星表按星等升序，取前缀即可）
    let nm = 0; while (nm < stars.nb && stars.col[nm * 4 + 3] <= (5.5 + 2) * 20) nm++;
    this.mirror = new THREE.Points(geo(nm), mat({ MIRROR: 1 }));
    for (const p of [this.field, this.mirror]) { p.renderOrder = -1; p.frustumCulled = false; }
    this.adopt([this.field, this.mirror], this.scene).then(() => { this.want.stars = 1; });
  }
  // 新物体先在一个临时场景里把着色器编译好（能并行就并行，不卡主线程），编好了再挂进画面——不然第一次画它时会整帧卡住
  async adopt(objs, parent) {
    const tmp = new THREE.Scene(); for (const o of objs) tmp.add(o);
    try { if (this.renderer.compileAsync) await this.renderer.compileAsync(tmp, this.camera, this.scene); } catch {}
    for (const o of objs) parent.add(o);
  }
  // 隐掉一个星团（k = 0 显示，1 隐藏）：它的星和连线
  hideGroup(gs, k) {
    const i = this.groups.indexOf(gs); this.starUni.uHideGrp.value = k > 0 ? i : -1; this.starUni.uHideK.value = k;
    if (this.lineGeo && gs.lineRange) { const c = this.lineGeo.attributes.color, [a, n] = gs.lineRange; for (let q = a * 2; q < (a + n) * 2; q++) c.array.set([0.62, 0.7, 0.85].map(v => v * (1 - k)), q * 3); c.needsUpdate = true; }
  }
  // 作品星点亮的进度：0 = 解锁页（只有海天），1 = 全亮
  setReveal(k) { this.starUni.uReveal.value = k; if (this.lineMat) this.lineMat.opacity = 0.2 * Math.max(0, (k - 0.5) * 2); }
  setGal(t) {
    const axis = new THREE.Vector3(0, Math.sin(38 * D), -Math.cos(38 * D)).normalize(), q = new THREE.Quaternion().setFromAxisAngle(axis, t * 0.0052);   // 约 20 分钟转一圈（2026-10-15 从 6.7 分钟放慢：整体要平静）
    const [g, y, n] = this.gal0.map(v => v.clone().applyQuaternion(q));
    this.uSky.uGal.value.set(g.x, g.y, g.z, y.x, y.y, y.z, n.x, n.y, n.z);
  }
  // groups: [{key,label,works:[{w}],tone:[r,g,b]}]；每个大类按 CLUSTERS 放在海面上空，法学里同一科目靠在一起
  setGroups(groups) {
    this.layer.clear(); this.stars = []; this.groups = [];
    const pos = [], col = [], size = [], seed = [], hot = [], mir = [], ord = [], grp = [], lp = [], mlp = [], lc = []; let idx = 0, extra = 0;
    const home = this.homePos();
    for (const g of groups) {
      const sp = CLUSTERS[g.key] || { az: 52 + 14 * extra++, d: 260, y: 20, r: 4 }, R = rng(hash(g.key)), n = g.works.length;
      const C = spot(sp.az, sp.d, sp.y), fw = spot(sp.az, 1, 0).setY(0).normalize(), rt = new THREE.Vector3(-fw.z, 0, fw.x), up = new THREE.Vector3(0, 1, 0);
      const local = (a, b, c) => C.clone().addScaledVector(rt, a).addScaledVector(up, b).addScaledVector(fw, c);
      const subs = [...new Set(g.works.map(x => x.w.sub))], pts = [];
      const place = (center, rad, list) => { const mine = [];   // 在一个小圆盘里撒点，彼此保持间距
        for (const it of list) { let best = null;
          for (let t = 0; t < 60; t++) { const a = R() * Math.PI * 2, q = Math.sqrt(R()) * rad, c = center.clone().addScaledVector(rt, Math.cos(a) * q).addScaledVector(up, Math.sin(a) * q * 0.8).addScaledVector(fw, (R() - 0.5) * rad * 0.8);
            const dmin = Math.min(...mine.map(m => m.distanceTo(c)), 1e9); if (!best || dmin > best[1]) best = [c, dmin]; if (dmin > rad * 0.75 / Math.sqrt(list.length)) break; }
          best[0].y = Math.max(best[0].y, 3); mine.push(best[0]); pts.push({ p: best[0], w: it.w }); } };
      if (subs.length > 1) { const cs = [];   // 科目中心在椭圆里随机撒、彼此留出空隙（不排成圆环，像自然的星团）
        for (const sb of subs) { let best = null;
          for (let t = 0; t < 400; t++) { const a = R() * Math.PI * 2, q = Math.sqrt(R()), c = [Math.cos(a) * q * sp.r * 0.78, Math.sin(a) * q * sp.r * 0.5];
            const dmin = Math.min(...cs.map(o => Math.hypot(o[0] - c[0], o[1] - c[1])), 1e9); if (!best || dmin > best[1]) best = [c, dmin]; if (dmin > sp.r * 0.46) break; }
          cs.push(best[0]); place(local(best[0][0], best[0][1], (R() - 0.5) * sp.r * 1.0), sp.r * 0.2, g.works.filter(x => x.w.sub === sb)); } }
      else place(C, sp.r, g.works);
      const gs = { ...g, stars: [], center: C, anchor: C.clone().add(new THREE.Vector3(0, sp.r * 0.72 + 2.5, 0)), spec: sp };
      pts.forEach(({ p, w }) => {
        const bytes = Math.log10(Math.max(w.bytes || 1, 1)), sz = 0.9 + Math.max(0, bytes - 4) * 0.3;   // 世界尺寸（米），按作品体积小幅缩放
        const s = { pos: p, dir: p.clone().sub(home).normalize(), work: w, group: gs, idx };
        const o = Math.min(1, (p.distanceTo(home) - 70) / 260) * 0.85 + R() * 0.15;   // 由近到远亮起
        for (const m of [0, 1]) { pos.push(p.x, m ? -p.y : p.y, p.z); col.push(...g.tone); size.push(sz); seed.push(idx + R() * 0.99); hot.push(0); mir.push(m); ord.push(o); grp.push(this.groups.length); }
        this.stars.push(s); gs.stars.push(s); idx++;
      });
      if (pts.length > 1) { // 最小生成树连线，在三维里连
        const inT = [0], edges = [];
        while (inT.length < pts.length) { let best = null; for (const a of inT) for (let b = 0; b < pts.length; b++) { if (inT.includes(b)) continue; const dd = gs.stars[a].pos.distanceTo(gs.stars[b].pos); if (!best || dd < best[2]) best = [a, b, dd]; } edges.push(best); inT.push(best[1]); }
        for (const [a, b] of edges) { const A = gs.stars[a].pos, B = gs.stars[b].pos; lp.push(A.x, A.y, A.z, B.x, B.y, B.z); mlp.push(A.x, -A.y, A.z, B.x, -B.y, B.z); lc.push(1, 1, 1, 1, 1, 1); }
        gs.lineRange = [lp.length / 6 - edges.length, edges.length];
      }
      this.groups.push(gs);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1)); geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    geo.setAttribute('aHot', new THREE.Float32BufferAttribute(hot, 1)); geo.setAttribute('aMirror', new THREE.Float32BufferAttribute(mir, 1)); geo.setAttribute('aOrder', new THREE.Float32BufferAttribute(ord, 1)); geo.setAttribute('aGrp', new THREE.Float32BufferAttribute(grp, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); this.starGeo = geo;
    const pts = new THREE.Points(geo, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: this.starUni, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    pts.renderOrder = 2; const parts = [pts];
    if (lp.length) {
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3)); this.lineGeo = lg;
      this.lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.2, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      const lines = new THREE.LineSegments(lg, this.lineMat); lines.renderOrder = 1; parts.push(lines);
      const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.Float32BufferAttribute(mlp, 3));
      const ml = new THREE.LineSegments(mg, new THREE.LineBasicMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.05, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })); ml.renderOrder = 1; parts.push(ml);
    } else { this.lineGeo = null; this.lineMat = null; }
    const gen = this.layerGen = (this.layerGen || 0) + 1;   // 编译期间又来一次 setGroups，就只挂最新那一批
    this.adopt(parts, new THREE.Group()).then(() => { if (gen === this.layerGen) for (const o of parts) this.layer.add(o); });
    this.setHot(null); this.setReveal(this.starUni.uReveal.value);
  }
  setHot(star) {
    this.hot = star; const g = star ? star.group : this.hoverGroup || null; this.hotGroup = g;
    if (!this.starGeo) return;
    const hotA = this.starGeo.attributes.aHot, colA = this.starGeo.attributes.aCol;
    this.stars.forEach((s, i) => { const on = s === star ? 1 : s.group === g ? 0.45 : 0; hotA.array[i * 2] = on; hotA.array[i * 2 + 1] = on * 0.6;
      const c = s.group === g ? [0.55, 0.9, 1.0] : s.group.tone; colA.array.set(c, i * 6); colA.array.set(c, i * 6 + 3); });
    hotA.needsUpdate = colA.needsUpdate = true;
    if (this.lineGeo) { const c = this.lineGeo.attributes.color;
      for (const gs of this.groups) { if (!gs.lineRange) continue; const [a, n] = gs.lineRange, on = gs === g; for (let k = a * 2; k < (a + n) * 2; k++) c.array.set(on ? [0.45, 0.85, 1.0] : [0.62, 0.7, 0.85], k * 3); }
      c.needsUpdate = true; }
  }
  resize(w, h, dpr) { this.W = w; this.H = h; this.dpr = dpr; this.portrait = h > w * 1.1; const was = this.baseFov; this.baseFov = this.portrait ? 78 : 60; if (!was) this.view.fov = this.baseFov; else if (was !== this.baseFov) this.view.fov *= this.baseFov / was;   // 自适应分辨率也会走这里，不能把放大重置掉
    this.camera.aspect = w / h; this.fieldUni.uDpr.value = dpr; this.applyCamera(); }
  applyCamera() { const c = this.camera, v = this.view, t = this.tilt, yaw = v.yaw + t.yaw, ox = v.px + t.x, oy = v.py + t.y; c.fov = v.fov; c.updateProjectionMatrix(); c.rotation.set(v.pitch, yaw, 0);
    c.position.set(v.x + Math.cos(yaw) * ox, Math.max(0.5, v.y + oy), v.z - Math.sin(yaw) * ox); this.starUni.uMinPx.value = 2.4 * (this.dpr || 1); this.starUni.uPx.value = (this.H * this.dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(v.fov) / 2)); }
  drag(dx, dy) { const v = this.view, k = THREE.MathUtils.degToRad(v.fov) / this.H; v.vYaw = dx * k; v.vPitch = dy * k; v.yaw += dx * k; v.pitch = THREE.MathUtils.clamp(v.pitch + dy * k, -0.06, 1.25);
    v.vPx = -dx * 0.005; v.vPy = dy * 0.0015; v.px = THREE.MathUtils.clamp(v.px + v.vPx, -PAN_X, PAN_X); v.py = THREE.MathUtils.clamp(v.py + v.vPy, -PAN_Y, PAN_Y); this.idle = 0; }   // 转头的同时相机横移，远近不同的星团就会错开
  zoom(d) { if (this.anim || this.approach) return; this.view.fov = THREE.MathUtils.clamp(this.view.fov * (1 + d), 18, this.portrait ? 90 : 75); this.idle = 0; }
  project(v) { const p = v.clone().project(this.camera); if (p.z > 1 || p.z < -1) return null; return [(p.x * 0.5 + 0.5) * this.W, (1 - (p.y * 0.5 + 0.5)) * this.H]; }
  pick(x, y, rad) { let best = null, bd = rad; for (const s of this.stars) { const p = this.project(s.pos); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = s; } } return best; }
  lookAt(p, dur, low = 0) { return this.lookAtDir(p.clone().sub(this.camera.position).normalize(), dur, low); }
  // low：让目标落在画面中线以上（手机上清单从底部升起时，星团要留在清单上方）
  lookAtDir(dir, dur = 1.2, low = 0) { const h = THREE.MathUtils.degToRad(this.view.fov) / 2, off = low ? Math.atan(low * Math.tan(h)) : 0; return this.tween({ yaw: this.unwrap(Math.atan2(-dir.x, -dir.z)), pitch: THREE.MathUtils.clamp(Math.asin(dir.y) - 0.05 - off, -0.06, 1.25) }, dur); }
  unwrap(a) { const y = this.view.yaw; while (a - y > Math.PI) a -= Math.PI * 2; while (a - y < -Math.PI) a += Math.PI * 2; return a; }
  tween(to, dur, ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) { return new Promise(res => { this.anim = { from: { ...this.view }, to, t: 0, dur, ease, res }; this.view.vYaw = this.view.vPitch = 0; }); }
  // 星球迎面飞来：0 = 还是一颗远星，1 = 星球略大于画面，之后作品从星球表面浮现
  setApproach(t) {
    this.approach = t; const P = this.planet.group; P.visible = t > 0.002 && !!this.planetDir; if (!P.visible) return;
    const fill = Math.min(0.97, Math.sin(THREE.MathUtils.degToRad(this.view.fov) * 0.5) * 1.18);   // 星球半径在屏幕上略大于半个画面高
    const dist = 900 * Math.pow((1 / fill) / 900, t);
    P.position.copy(this.camera.position).addScaledVector(this.planetDir, dist);
    this.planet.uni.uAlpha.value = Math.min(1, t * 8);
    this.uSky.uExposure.value = 1 - 0.5 * t; this.uSky.uNavy.value = 1 - 0.6 * t; this.fieldUni.uFade.value = 1 - 0.6 * t;
  }
  async dive(star, kind) {
    star.dir = star.pos.clone().sub(this.camera.position).normalize();   // 作品星有真实位置了，方向要从当前相机算
    this.setHot(star); this.starUni.uFocusIdx.value = star.idx; this.planetDir = star.dir.clone();
    const shown = this.planet.show(kind);
    await Promise.all([this.lookAtDir(star.dir, 0.9), shown]);
    this.preDive = { fov: this.view.fov }; const t0 = this.time, dur = 1.7;
    this.focusTick = () => { const k = Math.min(1, (this.time - t0) / dur); this.starUni.uFocus.value = Math.min(1, k * 4); this.setApproach(Math.pow(k, 2.2)); };
    await this.tween({ pitch: Math.asin(this.planetDir.y) }, dur, t => t * t);
    this.focusTick = null; this.setApproach(1);
  }
  // 作品加载时镜头继续缓慢贴近
  settle(on) { this.settling = on; }
  async rise() {
    const fov = this.preDive?.fov || this.baseFov, t0 = this.time, dur = 1.5, from = this.approach || 1;
    this.settling = false;
    this.focusTick = () => { const k = Math.min(1, (this.time - t0) / dur), e = 1 - Math.pow(1 - k, 2.2); this.setApproach(from * (1 - e)); this.starUni.uFocus.value = k > 0.8 ? (1 - k) * 5 : 1; };
    await this.tween({ fov, pitch: Math.asin(this.planetDir ? this.planetDir.y : 0.2) - 0.05 }, dur, t => 1 - Math.pow(1 - t, 3));
    this.focusTick = null; this.setApproach(0); this.starUni.uFocus.value = 0; this.starUni.uFocusIdx.value = -1; this.planetDir = null;
  }
  async glide(dur = 2) { const v = this.view, f = 6; await this.tween({ x: v.x - Math.sin(v.yaw) * f, z: v.z - Math.cos(v.yaw) * f, pitch: Math.min(1.25, v.pitch + 0.035) }, dur); }
  homeView() { return { yaw: this.portrait ? 0.2 : 0.28, pitch: 0.16 }; }
  homePos() { const y = this.homeView().yaw; return new THREE.Vector3(-Math.sin(y) * 6, EYE, -Math.cos(y) * 6); }   // 解锁滑行之后停的位置
  home(after) { const v = this.view, h = this.homeView(); Object.assign(v, { x: 0, y: EYE, z: 0, yaw: h.yaw, pitch: h.pitch, px: 0, py: 0, vPx: 0, vPy: 0, fov: this.baseFov || 60 }); if (after) { const p = this.homePos(); v.x = p.x; v.z = p.z; v.pitch += 0.035; } this.applyCamera(); }
  update(dt, reduce) {
    this.time += dt; this.fieldUni.uTime.value = this.time; this.seaUni.uTime.value = this.time; this.setGal(this.time);
    const v = this.view;
    if (this.anim) { const a = this.anim; a.t += dt / a.dur; const k = a.ease(Math.min(1, a.t)); for (const key in a.to) v[key] = a.from[key] + (a.to[key] - a.from[key]) * k; if (a.t >= 1) { this.anim = null; a.res(); } }
    else if (!this.approach) { if (!this.dragging) { v.yaw += v.vYaw; v.pitch = THREE.MathUtils.clamp(v.pitch + v.vPitch, -0.06, 1.25); v.px = THREE.MathUtils.clamp(v.px + v.vPx, -PAN_X, PAN_X); v.py = THREE.MathUtils.clamp(v.py + v.vPy, -PAN_Y, PAN_Y); }
      const damp = Math.pow(0.9, dt * 60); v.vYaw *= damp; v.vPitch *= damp; v.vPx *= damp; v.vPy *= damp; this.idle += dt; }   // 不再闲置自转（2026-10-15：镜头不自己动，免得晕）
    const r = dt / 1.2, mv = (u, t) => { u.value = u.value < t ? Math.min(t, u.value + r) : Math.max(t, u.value - r); };
    mv(this.uSky.uIn, this.want.sky); mv(this.uSky.uBandOn, this.want.band); mv(this.fieldUni.uIn, this.want.stars);
    if (this.focusTick) this.focusTick();
    if (this.settling && this.approach >= 1) { this.approach = Math.min(1.04, this.approach + dt * 0.012); }
    this.applyCamera();
    if (this.approach > 0) { this.setApproach(this.approach); this.planet.update(dt, this.camera); }
    this.sky.position.copy(this.camera.position); this.seaUni.uCam.value.copy(this.camera.position);
    if (this.field) { this.field.position.copy(this.camera.position); this.mirror.position.copy(this.camera.position); }   // 星在无限远：跟着相机走，不产生视差
  }
}
