// 内层：点一个星团飞进去，星团里的星展开成卡片。
// 作品 ≥ 4 件 → 航道：贴着海面、缓缓弯曲的一条路，卡片左右交替，每个科目开头一道细圆环；往上滑＝往前走，停下吸附到最近一张卡片。
// 作品 2–3 件 → 小弧：卡片在面前排成一道浅弧（竖屏放不下就竖着排），不用滚动。
// 寂寥版：不撒星尘，只有贴着海面的一串很暗的引导灯，卡片和圆环在海里有淡倒影。
// 世界单位是米，海面 y = 0；相机姿态写进 sky.view（x/y/z/yaw/pitch），陀螺仪偏移照样叠加。
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const CARD_W = 2.6, CARD_H = 1.6, GAP_CARD = 6, GAP_GATE = 10;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // 先慢后快再慢
const clamp01 = t => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;

// 卡片和文字都用 sRGB 原样输出（和整个网站的着色器一致），不走 three 的色彩空间转换
const PLANE_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PLANE_FS = /* glsl */`uniform sampler2D map; uniform float uOpacity; varying vec2 vUv; void main(){ vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb, c.a * uOpacity); }`;
const GLOW_FS = /* glsl */`uniform sampler2D map; uniform float uOpacity; varying vec2 vUv; void main(){ vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb * c.a * uOpacity, 1.0); }`;   // 倒影：加法叠在海面上
const RING_FS = /* glsl */`uniform vec3 uCol; uniform float uOpacity; void main(){ gl_FragColor = vec4(uCol * uOpacity, 1.0); }`;
const DOT_VS = /* glsl */`
attribute float aA; uniform float uPx, uMin, uSize, uOpacity; varying float vA;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; float z = max(-mv.z, 0.1);
  gl_PointSize = max(uSize * uPx / z, uMin); vA = aA * uOpacity * (1.0 - smoothstep(60.0, 140.0, z)); }`;
const DOT_FS = /* glsl */`uniform vec3 uCol; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(uCol * exp(-r * r * 5.0) * vA, 1.0); }`;

const MONO = '"SF Mono", ui-monospace, Menlo, monospace', CJK = '"PingFang SC", "Noto Sans CJK SC", -apple-system, sans-serif';
const rgba = (tone, a, k = 1) => `rgba(${tone.map(v => Math.round(Math.min(1, v * k) * 255)).join(',')},${a})`;
function spaced(x, text, px, py, sp) { let cx = px; for (const ch of text) { x.fillText(ch, cx, py); cx += x.measureText(ch).width + sp; } return cx - px; }
function texOf(canvas) { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 16; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; }

// 卡片贴图：和网站四角的展签同一套语言——极暗的底、直角细线框、四角刻度、等宽小字、细字标题；左上角那颗星就是它展开前的样子
function spacedW(x, text, sp) { let w = 0; for (const ch of text) w += x.measureText(ch).width + sp; return w - sp; }
function cardCanvas(W, tone, card) {
  const H = Math.round(W * CARD_H / CARD_W), c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'), u = W / 1000, m = 3 * u, iw = W - 2 * m, ih = H - 2 * m;
  x.fillStyle = 'rgba(5,7,15,0.68)'; x.fillRect(m, m, iw, ih);
  const g = x.createRadialGradient(W * 0.06, H * 0.08, 0, W * 0.06, H * 0.08, W * 0.8); g.addColorStop(0, rgba(tone, 0.11)); g.addColorStop(1, rgba(tone, 0)); x.fillStyle = g; x.fillRect(m, m, iw, ih);
  x.lineWidth = 1.5 * u; x.strokeStyle = rgba(tone, 0.2); x.strokeRect(m, m, iw, ih);
  const L = 28 * u; x.lineWidth = 2.4 * u; x.strokeStyle = rgba(tone, 0.85, 1.05); x.beginPath();   // 四角刻度
  for (const [cx, cy, dx, dy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) { x.moveTo(cx + dx * L, cy); x.lineTo(cx, cy); x.lineTo(cx, cy + dy * L); }
  x.stroke();
  if (card) {
    const sx = 66 * u, sy = 86 * u, gl = x.createRadialGradient(sx, sy, 0, sx, sy, 20 * u);   // 星
    gl.addColorStop(0, rgba(tone, 0.95, 1.1)); gl.addColorStop(0.25, rgba(tone, 0.35, 1.1)); gl.addColorStop(1, rgba(tone, 0)); x.fillStyle = gl; x.fillRect(sx - 20 * u, sy - 20 * u, 40 * u, 40 * u);
    x.fillStyle = 'rgba(255,255,255,0.95)'; x.beginPath(); x.arc(sx, sy, 3 * u, 0, Math.PI * 2); x.fill();
    x.strokeStyle = rgba(tone, 0.45, 1.1); x.lineWidth = 1.2 * u; x.beginPath(); x.moveTo(sx - 17 * u, sy); x.lineTo(sx + 17 * u, sy); x.moveTo(sx, sy - 17 * u); x.lineTo(sx, sy + 17 * u); x.stroke();
    x.textBaseline = 'middle'; x.font = `400 ${21 * u}px ${MONO}`; x.fillStyle = 'rgba(205,216,240,0.86)'; spaced(x, card.kicker.toUpperCase(), 100 * u, sy + 1 * u, 7 * u);
    if (card.foot) { x.font = `400 ${17 * u}px ${MONO}`; x.fillStyle = 'rgba(160,174,206,0.6)'; const t = card.foot.toUpperCase(); spaced(x, t, W - 66 * u - spacedW(x, t, 5 * u), sy + 1 * u, 5 * u); }
    x.fillStyle = 'rgba(233,237,248,0.1)'; x.fillRect(66 * u, 140 * u, W - 132 * u, Math.max(1, 1.2 * u));   // 一道细线
    let size = 68 * u, lines; const maxW = W - 132 * u;
    for (;;) { x.font = `300 ${size}px ${CJK}`; lines = []; let cur = '';   // 标题最多两行，放不下就缩小字号
      for (const ch of card.title) { if (x.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; } else cur += ch; } if (cur) lines.push(cur);
      const orphan = lines.length === 2 && (lines[1].length < 3 || /^[）)》」』、，。：；·]/.test(lines[1]));   // 第二行只剩一两个字或以标点开头就再缩小
      if ((lines.length === 1 || (lines.length === 2 && !orphan)) || size < 36 * u) break; size *= 0.94; }
    if (lines.length > 2) { lines = lines.slice(0, 2); lines[1] = lines[1].slice(0, -1) + '…'; }
    x.fillStyle = 'rgba(240,243,252,0.95)'; const lh = size * 1.34, y0 = (140 * u + H - 40 * u) / 2 - (lines.length - 1) * lh / 2;
    lines.forEach((ln, i) => x.fillText(ln, 64 * u, y0 + i * lh));
  }
  return c;
}
function labelCanvas(text, tone) {
  const c = document.createElement('canvas'), x = c.getContext('2d'), S = 4; x.font = `400 ${26 * S}px ${MONO}`;
  let w = 0; for (const ch of text) w += x.measureText(ch).width + 9 * S; c.width = Math.ceil(w + 40 * S); c.height = 64 * S;
  x.font = `400 ${26 * S}px ${MONO}`; x.textBaseline = 'middle'; x.fillStyle = rgba(tone, 0.85, 1.05); spaced(x, text.toUpperCase(), 20 * S, 32 * S, 9 * S); return c;
}

export class Field {
  // list：这一类的作品，已经按 Index 的顺序排好（先科目，科目里按类型）；每件带 card: { kicker, title, foot }
  constructor(sky, group, list, { small, subs }) {
    this.sky = sky; this.g = group; this.list = list; this.small = small;
    this.mode = list.length >= 4 ? 'corridor' : 'arc'; this.portrait = sky.portrait;
    this.root = new THREE.Group(); this.mirror = new THREE.Group(); this.mirror.scale.y = -1; this.root.add(this.mirror);
    this.texW = small ? 1024 : 1536; this.texFar = small ? 384 : 512; this.blank = texOf(cardCanvas(this.texW, group.tone, null)); this.live = new Map();   // 近处卡片的贴图 / 远处卡片的小贴图；推近时再按屏幕实际像素画一张更清晰的
    const C = group.center; this.fw = new THREE.Vector3(C.x, 0, C.z).normalize(); this.rt = new THREE.Vector3(-this.fw.z, 0, this.fw.x);
    this.cards = []; this.gates = []; this.u = 0; this.vel = 0; this.morph = 0; this.fade = 0;
    this.look = { yaw: 0, pitch: 0, vy: 0, vp: 0, center: false };   // 自由转头的偏移：拖动可以上下左右看，往下一张走时慢慢回正
    if (this.mode === 'corridor') this.buildCorridor(subs); else this.buildArc();
    // 卡片展开前的光点
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.cards.length * 3), 3)); dg.setAttribute('aA', new THREE.Float32BufferAttribute(new Float32Array(this.cards.length), 1));
    this.dotUni = { uPx: sky.starUni.uPx, uMin: { value: 3 }, uSize: { value: 0.5 }, uOpacity: { value: 1 }, uCol: { value: new THREE.Color(...group.tone).multiplyScalar(1.4) } };
    this.dots = new THREE.Points(dg, new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, uniforms: this.dotUni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.dots.frustumCulled = false; this.root.add(this.dots);
    sky.scene.add(this.root); this.apply();
  }

  // ---------- 航道 ----------
  lat(s) { const a = this.portrait ? 3.5 : 6; return a * Math.sin(s / 48) + 2.5 * Math.sin(s / 21 + 1) - 2.5 * Math.sin(1); }
  at(s) { return this.E.clone().addScaledVector(this.fw, s).addScaledVector(this.rt, this.lat(s)).setY(3 + 0.4 * Math.sin(s / 33)); }
  tan(s) { return this.at(s + 0.5).sub(this.at(s - 0.5)).normalize(); }
  side(s) { return new THREE.Vector3().crossVectors(this.tan(s), UP).normalize(); }
  buildCorridor(subs) {
    const C = this.g.center; this.E = new THREE.Vector3(C.x, 0, C.z).addScaledVector(this.fw, 6);   // 航道从星团正下方稍往前开始，伸向远方
    let s = 12, k = 0; this.stops = []; const tone = this.g.tone;
    for (const sub of subs) {
      const items = this.list.filter(w => w.sub === sub.key); if (!items.length) continue;
      const gp = this.at(s).setY(3.35), gt = this.tan(s);
      const ring = this.ring(gp, gt, 3.0, 0.02, 0.5), halo = this.ring(gp, gt, 3.28, 0.008, 0.22);
      const lab = this.plane(texOf(labelCanvas(`${sub.label} · ${items.length}`, tone)), 0.72, null);
      lab.mesh.position.copy(gp).add(new THREE.Vector3(0, 3.75, 0)); lab.mesh.lookAt(lab.mesh.position.clone().sub(gt));
      this.gates.push({ s, ring, halo, lab, sub, from: k }); s += GAP_GATE;
      for (const w of items) {
        const sd = k % 2 ? 1 : -1, sv = this.side(s), off = (this.portrait ? 2.1 : 2.8) + (k % 3) * (this.portrait ? 0.15 : 0.3), dh = [-0.35, 0.75, 0.2, 0.95, -0.1, 0.5][k % 6];
        const pos = this.at(s).addScaledVector(sv, sd * off).add(new THREE.Vector3(0, dh, 0));
        const n = this.tan(s).multiplyScalar(-Math.cos(0.52)).addScaledVector(sv, -sd * Math.sin(0.52));   // 朝中心线内转约 30°，正对迎面而来的镜头
        this.addCard(w, pos, n, k, s); this.stops.push(Math.max(0, s - (this.portrait ? 5.2 : 6.5))); s += GAP_CARD; k++;
      }
    }
    this.uMin = this.stops[0]; this.uMax = this.stops[this.stops.length - 1]; this.len = s + 10; this.u = this.uMin;
    const pts = [], aa = [];   // 引导灯：中心线两侧贴着海面，每 2.2 米一颗，很暗
    for (let q = -4; q < this.len + 30; q += 2.2) { const p = this.at(q), sv = this.side(q); for (const sd of [-1, 1]) { const pp = p.clone().addScaledVector(sv, sd * (this.portrait ? 3.4 : 4.3)); pp.y = 0.12; pts.push(pp.x, pp.y, pp.z); aa.push(0.6 + 0.4 * ((q * 7.31) % 1)); } }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); lg.setAttribute('aA', new THREE.Float32BufferAttribute(aa, 1));
    this.lightUni = { uPx: this.sky.starUni.uPx, uMin: { value: 1.3 }, uSize: { value: 0.05 }, uOpacity: { value: 0 }, uCol: { value: new THREE.Color(0.55, 0.72, 1.0).multiplyScalar(0.9) } };
    const lights = new THREE.Points(lg, new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, uniforms: this.lightUni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    lights.frustumCulled = false; this.root.add(lights);
  }
  // ---------- 小弧 ----------
  buildArc() {
    const C = this.g.center, n = this.list.length; this.V = C.clone().addScaledVector(this.fw, -12); this.V.y = Math.max(this.V.y, 4);
    this.stops = [0]; this.uMin = this.uMax = 0;
    this.list.forEach((w, i) => {
      const o = i - (n - 1) / 2; let pos;
      if (this.portrait) pos = this.V.clone().addScaledVector(this.fw, 5.4 - Math.abs(o) * 0.35).add(new THREE.Vector3(0, -o * 2.05, 0));   // 竖屏：竖着排
      else { const a = o * 0.47, dir = this.fw.clone().applyAxisAngle(UP, -a); pos = this.V.clone().addScaledVector(dir, 6.2).add(new THREE.Vector3(0, Math.abs(o) * -0.15, 0)); }
      this.addCard(w, pos, this.V.clone().sub(pos).normalize(), i, 0);
    });
  }

  // ---------- 零件 ----------
  plane(map, h, reflOpacity) {
    const w = h * (map.image.width / map.image.height), geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: PLANE_VS, fragmentShader: PLANE_FS, uniforms: { map: { value: map }, uOpacity: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.root.add(mesh); let refl = null;
    if (reflOpacity) { refl = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: PLANE_VS, fragmentShader: GLOW_FS, uniforms: { map: mesh.material.uniforms.map, uOpacity: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); this.mirror.add(refl); }
    return { mesh, refl, geo };
  }
  ring(pos, dir, r, tube, op) {   // 细圆环：整个在水面以上
    const geo = new THREE.TorusGeometry(r, tube, 8, 160), uni = { uCol: { value: new THREE.Color(...this.g.tone).multiplyScalar(1.15) }, uOpacity: { value: 0 } };
    const mk = (o) => { const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: PLANE_VS, fragmentShader: RING_FS, uniforms: { uCol: uni.uCol, uOpacity: o }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); m.position.copy(pos); m.lookAt(pos.clone().add(dir)); return m; };
    const mesh = mk(uni.uOpacity), refl = mk({ value: 0 }); this.root.add(mesh); this.mirror.add(refl);
    return { mesh, refl, op, uni };
  }
  addCard(w, pos, normal, k, s) {
    const p = this.plane(this.blank, CARD_H, 0.2); p.mesh.scale.setScalar(0.001);
    const star = this.g.stars.find(st => st.work === w), from = star ? star.pos.clone() : pos.clone();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), normal.clone().negate(), UP));   // 平面的正面朝 normal
    this.cards.push({ w, k, s, pos, q, from, ...p, tex: null });
  }
  // 每张卡片都有字：远处用小贴图（屏幕上本来就小），附近 7 张换成清晰的；推近的那张另外按屏幕像素画
  textures(all) {
    const cur = this.nearest(), near = c => Math.abs(c.k - cur) <= 3 || (this.mode === 'arc');
    for (const c of this.cards) if (!c.low) { c.low = texOf(cardCanvas(this.texFar, this.g.tone, c.w.card)); if (!c.tex && !c.hi) c.mesh.material.uniforms.map.value = c.low; if (all) this.sky.renderer.initTexture(c.low); else return; }   // 平时一帧只画一张，避免卡顿
    for (const c of this.cards) if (!near(c) && c.tex && !c.hi) { c.mesh.material.uniforms.map.value = c.low; c.tex.dispose(); c.tex = null; }
    for (const c of this.cards) if (near(c) && !c.tex) { c.tex = texOf(cardCanvas(this.texW, this.g.tone, c.w.card)); if (!c.hi) c.mesh.material.uniforms.map.value = c.tex; if (all) this.sky.renderer.initTexture(c.tex); else break; }
  }
  nearest() { if (this.mode === 'arc') return 0; let best = 0; this.stops.forEach((u, i) => { if (Math.abs(u - this.u) < Math.abs(this.stops[best] - this.u)) best = i; }); return best; }

  // ---------- 每帧：展开进度 → 卡片位置；滚动 → 相机 ----------
  apply() {
    const m = this.morph, n = this.cards.length, dpos = this.dots.geometry.attributes.position, da = this.dots.geometry.attributes.aA;
    this.cards.forEach((c, i) => {
      const t = clamp01(m * 1.35 - (i / Math.max(1, n - 1)) * 0.35), e = ease(t), grow = ease(clamp01((t - 0.35) / 0.65));
      c.mesh.position.lerpVectors(c.from, c.pos, e); c.mesh.quaternion.copy(c.q); c.mesh.scale.setScalar(Math.max(0.001, grow));
      c.mesh.material.uniforms.uOpacity.value = grow * this.fadeK(c);
      if (c.refl) { c.refl.position.copy(c.mesh.position); c.refl.quaternion.copy(c.q); c.refl.scale.copy(c.mesh.scale); c.refl.material.uniforms.uOpacity.value = grow * 0.2 * this.fadeK(c); }
      dpos.setXYZ(i, c.mesh.position.x, c.mesh.position.y, c.mesh.position.z); da.setX(i, (t > 0 ? 1 : 0) * (1 - grow));   // 先是一个光点，再变成一块薄片
    });
    dpos.needsUpdate = da.needsUpdate = true;
    const late = ease(clamp01((m - 0.55) / 0.45));
    for (const gt of this.gates) { gt.ring.uni.uOpacity.value = gt.ring.op * late; gt.ring.refl.material.uniforms.uOpacity.value = gt.ring.op * 0.25 * late; gt.halo.uni.uOpacity.value = gt.halo.op * late; gt.halo.refl.material.uniforms.uOpacity.value = gt.halo.op * 0.25 * late; gt.lab.mesh.material.uniforms.uOpacity.value = late; }
    if (this.lightUni) this.lightUni.uOpacity.value = late;
  }
  fadeK(c) { if (this.mode === 'arc' || !this.pushing) return 1; return c === this.pushing ? 1 : 1 - this.pushK * 0.85; }
  // 航道：u 位置 → 相机。镜头沿中心线前进，朝前方 11 米看，靠近某张卡片时转向它，保证它端正地出现在画面里
  pose(u) {
    if (this.mode === 'arc') return { pos: this.V.clone(), look: this.V.clone().addScaledVector(this.fw, 10) };
    const pos = this.at(u), look = this.at(u + 11).add(new THREE.Vector3(0, -0.7, 0));
    let bi = 0, bd = 1e9; for (let i = 0; i < this.stops.length; i++) { const d = Math.abs(this.stops[i] - u); if (d < bd) { bd = d; bi = i; } }
    const c = this.cards[bi], f = clamp01(1 - bd / 4) * (this.portrait ? 0.85 : 0.5);
    if (c) look.lerp(c.pos, f);
    return { pos, look };
  }
  setCamera(pos, look) {
    const v = this.sky.view, d = look.clone().sub(pos).normalize();
    v.x = pos.x; v.y = pos.y; v.z = pos.z; v.yaw = Math.atan2(-d.x, -d.z); v.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)); v.px = v.py = v.vPx = v.vPy = v.vYaw = v.vPitch = 0;
  }
  update(dt) {
    if (this.drive && this.mode === 'corridor' && !this.dragging) {   // 松手后滑到目标卡片（没有目标就吸附到最近的一张）
      const target = this.target ?? this.stops.reduce((a, b) => Math.abs(b - this.u) < Math.abs(a - this.u) ? b : a, this.stops[0]);
      this.u += (target - this.u) * (1 - Math.exp(-dt * 6)); if (Math.abs(target - this.u) < 0.02) { this.u = target; this.target = null; }
    }
    const L = this.look;
    if (!this.lookDrag) { L.yaw += L.vy; L.pitch += L.vp; const d = Math.pow(0.9, dt * 60); L.vy *= d; L.vp *= d; }
    if (L.center) { const k = 1 - Math.exp(-dt * 3.5); L.yaw -= L.yaw * k; L.pitch -= L.pitch * k; L.vy = L.vp = 0; if (Math.abs(L.yaw) + Math.abs(L.pitch) < 0.002) L.center = false; }
    if (this.drive) { const p = this.pose(this.u); this.setCamera(p.pos, p.look); const v = this.sky.view; v.yaw += L.yaw; v.pitch = THREE.MathUtils.clamp(v.pitch + L.pitch, -0.6, 1.25); L.pitch = v.pitch - Math.asin(THREE.MathUtils.clamp(p.look.clone().sub(p.pos).normalize().y, -1, 1)); }
    this.dotUni.uMin.value = 3 * (this.sky.dpr || 1); if (this.lightUni) this.lightUni.uMin.value = 1.3 * (this.sky.dpr || 1);
    this.apply(); this.textures();
  }
  // 输入：dy 像素（往上滑为负）
  lookBy(dx, dy) { const k = THREE.MathUtils.degToRad(this.sky.view.fov) / this.sky.H, L = this.look; L.center = false; L.vy = dx * k; L.vp = dy * k; L.yaw += L.vy; L.pitch += L.vp; }
  recenter() { this.look.center = true; }
  stopIndex(u) { let bi = 0; this.stops.forEach((v, i) => { if (Math.abs(v - u) < Math.abs(this.stops[bi] - u)) bi = i; }); return bi; }
  dragStart() { this.target = null; this.from = this.stopIndex(this.u); this.t0 = performance.now(); this.u0 = this.u; }
  dragBy(dy) { if (this.mode !== 'corridor') return; const du = -dy * GAP_CARD / this.sky.H; this.u = THREE.MathUtils.clamp(this.u + du, this.uMin - 2, this.uMax + 2); }   // 手指跟着走：滑满一屏＝一张卡片
  dragEnd() {   // 翻页：滑动超过一点点就去下一张（或上一张），甩得很快最多走两张
    if (this.mode !== 'corridor' || this.from == null) return; const d = this.u - this.u0, speed = Math.abs(d) / Math.max(0.05, (performance.now() - this.t0) / 1000);
    const n = Math.abs(d) < 0.6 ? 0 : (speed > 30 ? 2 : 1); this.target = this.stops[THREE.MathUtils.clamp(this.from + Math.sign(d) * n, 0, this.stops.length - 1)]; this.from = null; if (n) this.recenter();
  }
  // 滚轮 / 触控板：攒够一下就走一张卡片，走完冷却一会儿，触控板的连续小幅滚动不会一下冲过好几张
  wheel(d) { if (this.mode !== 'corridor') return; const now = performance.now(); if (now < (this.wheelLock || 0)) return; if (now - (this.wheelT || 0) > 250) this.wheelAcc = 0; this.wheelT = now;
    this.wheelAcc = (this.wheelAcc || 0) + d; if (Math.abs(this.wheelAcc) >= 30) { this.step(Math.sign(this.wheelAcc)); this.wheelAcc = 0; this.wheelLock = now + 380; } }
  step(dir) { if (this.mode !== 'corridor') return; const i = this.stopIndex(this.target ?? this.u); this.target = this.stops[THREE.MathUtils.clamp(i + dir, 0, this.stops.length - 1)]; this.recenter(); }
  atStart() { return this.mode === 'arc' || this.u <= this.uMin + 0.3; }
  subjectAt() { if (!this.gates.length) return ''; let g = this.gates[0]; for (const gt of this.gates) if (gt.s - 4 <= this.u) g = gt; return g.sub.label; }
  position() { const i = this.nearest(); return `${Math.min(this.cards.length, i + 1)} / ${this.cards.length}`; }
  pick(x, y) {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(x / this.sky.W * 2 - 1, -(y / this.sky.H) * 2 + 1); ray.setFromCamera(ndc, this.sky.camera);
    const cur = this.nearest(), ok = this.cards.filter(c => c.mesh.scale.x > 0.5 && (this.mode === 'arc' || Math.abs(c.k - cur) <= 1));   // 只有眼前这张和左右相邻的能点，不会点到远处看不清的卡片
    const hit = ray.intersectObjects(ok.map(c => c.mesh), false)[0];
    return hit ? this.cards.find(c => c.mesh === hit.object) : null;
  }
  focus(w) { const c = this.cards.find(c => c.w === w); if (c && this.mode === 'corridor') this.u = this.target = this.stops[c.k]; }

  // ---------- 过渡 ----------
  // 飞进去：沿曲线擦着星团边缘穿过，后段星展开成卡片
  async enter(tween, reduce, focusW) {
    if (focusW) this.focus(focusW);
    this.textures(true); this.sky.renderer.initTexture(this.blank);   // 起飞前把要用的贴图一次画好、传上 GPU，飞行途中不再掉帧
    const end = this.pose(this.u), v = this.sky.view, p0 = this.sky.camera.position.clone(), look0 = this.g.center.clone();
    if (reduce) { this.morph = 1; this.drive = true; this.update(0); return; }
    const C = this.g.center, r = this.g.spec.r, p1 = C.clone().addScaledVector(this.rt, r * 0.95).addScaledVector(this.fw, -r * 0.5); p1.y = Math.max(3.5, C.y * 0.45);
    const pts = [p0, p1];
    if (this.mode === 'corridor') { pts.push(this.at(-14), this.at(0)); for (let q = 25; q < this.u - 8; q += 25) pts.push(this.at(q)); }   // 沿着航道进来，镜头从第一道圆环中间穿过
    pts.push(end.pos); const uniq = pts.filter((q, i) => i === 0 || q.distanceTo(pts[i - 1]) > 0.5); const path = new THREE.CatmullRomCurve3(uniq.length > 1 ? uniq : [p0, end.pos], false, 'centripetal');
    const dur = this.mode === 'arc' ? 1800 : 2400;
    await tween(dur, k => { const e = ease(k); this.setCamera(path.getPointAt(Math.min(0.9999, Math.max(0, e))), look0.clone().lerp(end.look, ease(clamp01((k - 0.15) / 0.75)))); this.morph = clamp01((k - 0.62) / 0.38 * 0.45); this.sky.hideGroup(this.g, clamp01((k - 0.6) / 0.25)); });
    await tween(800, k => { this.morph = 0.45 + 0.55 * k; });   // 星在 0.8 秒内移到卡片位置并展开
    this.drive = true;
  }
  // 退出：卡片收回成星，镜头飞回外层原来的位置
  async exit(tween, reduce, back) {
    this.drive = false; const p0 = this.sky.camera.position.clone(), d0 = new THREE.Vector3(); this.sky.camera.getWorldDirection(d0);
    if (reduce) { this.morph = 0; this.sky.hideGroup(this.g, 0); return; }
    const look0 = p0.clone().add(d0.multiplyScalar(20)), pb = new THREE.Vector3(back.x, back.y, back.z), lookB = pb.clone().add(new THREE.Vector3(-Math.sin(back.yaw) * Math.cos(back.pitch), Math.sin(back.pitch), -Math.cos(back.yaw) * Math.cos(back.pitch)).multiplyScalar(50));
    await tween(1900, k => { const e = ease(k); this.morph = 1 - clamp01(k / 0.4); this.sky.hideGroup(this.g, 1 - clamp01((k - 0.3) / 0.3)); this.setCamera(p0.clone().lerp(pb, e), look0.clone().lerp(lookB, e)); });
  }
  // 点卡片：镜头推近，直到卡片占满视野
  async pushIn(card, tween, reduce) {
    this.drive = false; this.pushing = card; this.pushK = 0;
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(card.q), fov = THREE.MathUtils.degToRad(this.sky.view.fov), aspect = this.sky.W / this.sky.H;
    const d = Math.max((CARD_H / 2) / Math.tan(fov / 2), (CARD_W / 2) / (Math.tan(fov / 2) * aspect)) * 1.02;
    const p0 = this.sky.camera.position.clone(), d0 = new THREE.Vector3(); this.sky.camera.getWorldDirection(d0); const look0 = p0.clone().add(d0.multiplyScalar(10));
    const p1 = card.pos.clone().addScaledVector(n, d); this.back = { p0, look0 };
    const px = Math.min(4096, Math.max(this.texW, Math.ceil(Math.min(this.sky.W, this.sky.H * CARD_W / CARD_H) * (this.sky.dpr || 1) * 1.05 / 256) * 256));   // 卡片占满画面时的实际像素宽
    if (px > this.texW) { card.hi = texOf(cardCanvas(px, this.g.tone, card.w.card)); this.sky.renderer.initTexture(card.hi); card.mesh.material.uniforms.map.value = card.hi; }
    if (reduce) { this.setCamera(p1, card.pos); this.pushK = 1; return; }
    await tween(900, k => { const e = ease(k); this.pushK = e; this.setCamera(p0.clone().lerp(p1, e), look0.clone().lerp(card.pos, ease(clamp01(k * 1.4)))); });
  }
  async pullBack(tween, reduce) {
    const b = this.back; if (!b) { this.drive = true; return; }
    const p1 = this.sky.camera.position.clone(), d1 = new THREE.Vector3(); this.sky.camera.getWorldDirection(d1); const look1 = p1.clone().add(d1);
    if (!reduce) await tween(900, k => { const e = ease(k); this.pushK = 1 - e; this.setCamera(p1.clone().lerp(b.p0, e), look1.clone().lerp(b.look0, e)); });
    const c = this.pushing; if (c && c.hi) { c.mesh.material.uniforms.map.value = c.tex || c.low || this.blank; c.hi.dispose(); c.hi = null; }
    this.pushing = null; this.pushK = 0; this.back = null; this.drive = true;
  }
  dispose() {
    this.sky.scene.remove(this.root); const seen = new Set();
    this.root.traverse(o => { if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); } if (o.material) { const t = o.material.uniforms?.map?.value; if (t && !seen.has(t)) { seen.add(t); t.dispose(); } o.material.dispose(); } });
    this.blank.dispose(); for (const c of this.cards) { if (c.tex) c.tex.dispose(); if (c.hi) c.hi.dispose(); if (c.low) c.low.dispose(); }
  }
}
