// 解锁页：Nocturne 式的粒子变形序列，最后一幕是三体 8 字形。
import * as THREE from 'three';
import { nebula, galaxy, lorenz, ringedWorld, mobius, aizawa, figure8Coefficients, rng } from './forms.js';

export const FORMS = [
  { key: 'nebula', label: 'NEBULA', make: nebula },
  { key: 'galaxy', label: 'SPIRAL GALAXY, EDGE-ON', make: galaxy },
  { key: 'lorenz', label: 'LORENZ ATTRACTOR', make: lorenz },
  { key: 'ringed', label: 'RINGED WORLD', make: ringedWorld },
  { key: 'mobius', label: 'MÖBIUS STRIP', make: mobius },
  { key: 'aizawa', label: 'AIZAWA ATTRACTOR', make: aizawa },
  { key: 'three', label: 'THREE BODIES, FIGURE EIGHT', make: null },
];
const K = 16;

const VS = /* glsl */`
uniform float uMix, uTime, uSrcFig, uDstFig, uPx, uBurst, uScatter, uFigScale, uCollapse;
uniform vec4 uCoef[${K + 1}];
attribute vec3 aPosA, aPosB, aColA, aColB;
attribute float aSeed, aSize;
attribute vec2 aOrb;
varying vec3 vCol; varying float vA;
vec3 fig8(out float bright){
  float th = 6.2831853 * fract(uTime / 14.0 + aOrb.x / 3.0 - aOrb.y * 0.36);
  vec2 p = vec2(0.0);
  for (int k = 0; k <= ${K}; k++) { float fk = float(k); float c = cos(fk * th), s = sin(fk * th);
    p.x += uCoef[k].x * c + uCoef[k].y * s; p.y += uCoef[k].z * c + uCoef[k].w * s; }
  float spread = 0.012 + aOrb.y * aOrb.y * 0.5;
  vec3 j = (vec3(fract(aSeed * 91.7), fract(aSeed * 47.3), fract(aSeed * 13.1)) - 0.5) * spread;
  bright = pow(1.0 - aOrb.y, 2.2) * 1.5 + (aOrb.y < 0.004 ? 5.0 : 0.0);
  return vec3(p * uFigScale, 0.0) + j;
}
void main(){
  float d = aSeed * 0.35;
  float t = clamp((uMix - d) / 0.65, 0.0, 1.0);
  float e = t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
  float bf = 1.0;
  vec3 src = aPosA, dst = aPosB;
  float bs = 1.0, bd = 1.0;
  if (uSrcFig > 0.5) src = fig8(bs);
  if (uDstFig > 0.5) dst = fig8(bd);
  bf = mix(uSrcFig > 0.5 ? bs : 1.0, uDstFig > 0.5 ? bd : 1.0, e);
  float mid = sin(3.14159265 * e);
  vec3 swirl = vec3(sin(aSeed * 41.0 + uTime * 0.7), cos(aSeed * 29.0 + uTime * 0.6), sin(aSeed * 17.0 - uTime * 0.5)) * 0.9 * mid;
  vec3 pos = mix(src, dst, e) + swirl;
  // 输错密码：短暂炸散
  pos += normalize(vec3(fract(aSeed * 13.7) - 0.5, fract(aSeed * 71.3) - 0.5, fract(aSeed * 37.1) - 0.5) + 1e-4) * uScatter * (0.6 + fract(aSeed * 5.3) * 1.6);
  // 解锁：先向中心收缩，再冲向镜头
  pos = mix(pos, pos * 0.02, uCollapse);
  pos += normalize(pos + vec3(0.0001)) * uBurst * (4.0 + fract(aSeed * 9.1) * 22.0);
  pos.z += uBurst * (6.0 + fract(aSeed * 3.3) * 14.0);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  gl_PointSize = clamp(aSize * uPx / depth * (1.0 + uCollapse * 1.5), 0.6, 64.0);
  vCol = mix(aColA, aColB, e) * bf;
  vA = (1.0 - smoothstep(0.35, 1.0, uBurst)) * (0.55 + 0.45 * fract(aSeed * 7.7));
}`;
const FS = /* glsl */`
varying vec3 vCol; varying float vA;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0) discard;
  float a = exp(-r * r * 5.0) * (1.0 - r * r);
  gl_FragColor = vec4(vCol * a * vA, 1.0);
}`;

const BOKEH_VS = /* glsl */`
attribute float aSize, aSeed; uniform float uTime, uPx; varying float vA;
void main(){ vec3 p = position; p.x += sin(uTime * 0.05 + aSeed * 20.0) * 0.6; p.y += cos(uTime * 0.04 + aSeed * 13.0) * 0.4;
  vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uPx / max(-mv.z, 0.1);
  vA = 0.018 + fract(aSeed * 9.7) * 0.035; }`;
const BOKEH_FS = /* glsl */`varying float vA; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  float a = smoothstep(1.0, 0.55, r); gl_FragColor = vec4(vec3(0.62, 0.7, 1.0) * a * vA, 1.0); }`;
const STAR_VS = /* glsl */`
attribute float aSize, aSeed; uniform float uTime, uPx; varying float vA;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, aSize * uPx * 0.012); vA = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 60.0)) * fract(aSeed * 3.1); }`;
const STAR_FS = /* glsl */`varying float vA; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
  gl_FragColor = vec4(vec3(0.8, 0.86, 1.0) * exp(-r * r * 4.0) * vA, 1.0); }`;

export class GateScene {
  constructor(small) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
    this.camera.position.set(0, 0.3, 9);
    this.N = small ? 9000 : 22000;
    this.forms = FORMS.map(f => f.make ? f.make(this.N) : null);
    this.idx = 0; this.next = 0; this.mix = 1; this.morphing = false; this.holdUntil = 0;
    this.burst = 0; this.collapse = 0; this.scatter = 0; this.time = 0;
    this.onForm = () => {};
    const R = rng(97), N = this.N;
    const g = new THREE.BufferGeometry();
    const posA = new Float32Array(N * 3), posB = new Float32Array(N * 3), colA = new Float32Array(N * 3), colB = new Float32Array(N * 3);
    const seed = new Float32Array(N), size = new Float32Array(N), orb = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      seed[i] = R(); size[i] = 0.018 + Math.pow(R(), 6) * 0.07;
      orb[i * 2] = i % 3; orb[i * 2 + 1] = Math.pow(R(), 1.35);
    }
    posA.set(this.forms[0].pos); posB.set(this.forms[0].pos); colA.set(this.forms[0].col); colB.set(this.forms[0].col);
    g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
    g.setAttribute('aPosA', new THREE.BufferAttribute(posA, 3));
    g.setAttribute('aPosB', new THREE.BufferAttribute(posB, 3));
    g.setAttribute('aColA', new THREE.BufferAttribute(colA, 3));
    g.setAttribute('aColB', new THREE.BufferAttribute(colB, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aOrb', new THREE.BufferAttribute(orb, 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    this.uni = { uMix: { value: 1 }, uTime: { value: 0 }, uSrcFig: { value: 0 }, uDstFig: { value: 0 }, uPx: { value: 800 },
      uBurst: { value: 0 }, uScatter: { value: 0 }, uCollapse: { value: 0 }, uFigScale: { value: 2.05 }, uCoef: { value: [] } };
    const coef = figure8Coefficients(K);
    this.uni.uCoef.value = Array.from({ length: K + 1 }, (_, k) => new THREE.Vector4(coef[k * 4], coef[k * 4 + 1], coef[k * 4 + 2], coef[k * 4 + 3]));
    this.mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.uni, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(g, this.mat); this.geo = g;
    this.group = new THREE.Group(); this.group.add(this.points); this.scene.add(this.group);

    // 远处的星和失焦光斑（景深感）
    const sg = new THREE.BufferGeometry(), sn = small ? 1500 : 3500, sp = new Float32Array(sn * 3), ss = new Float32Array(sn), sseed = new Float32Array(sn);
    for (let i = 0; i < sn; i++) { const th = R() * 6.2832, ph = Math.acos(2 * R() - 1), r = 60 + R() * 60;
      sp.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3); ss[i] = 0.5 + Math.pow(R(), 4) * 2.5; sseed[i] = R(); }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aSize', new THREE.BufferAttribute(ss, 1)); sg.setAttribute('aSeed', new THREE.BufferAttribute(sseed, 1));
    this.starUni = { uTime: this.uni.uTime, uPx: this.uni.uPx };
    this.scene.add(new THREE.Points(sg, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: this.starUni, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })));
    const bg = new THREE.BufferGeometry(), bn = 46, bp = new Float32Array(bn * 3), bs = new Float32Array(bn), bseed = new Float32Array(bn);
    for (let i = 0; i < bn; i++) { bp.set([(R() - 0.5) * 34, (R() - 0.5) * 20, -4 - R() * 26], i * 3); bs[i] = 1.2 + R() * 3.4; bseed[i] = R(); }
    bg.setAttribute('position', new THREE.BufferAttribute(bp, 3)); bg.setAttribute('aSize', new THREE.BufferAttribute(bs, 1)); bg.setAttribute('aSeed', new THREE.BufferAttribute(bseed, 1));
    this.scene.add(new THREE.Points(bg, new THREE.ShaderMaterial({ vertexShader: BOKEH_VS, fragmentShader: BOKEH_FS, uniforms: this.starUni, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })));
    this.ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  }
  resize(w, h, dpr) { this.camera.aspect = w / h; const portrait = h > w * 1.1; this.camera.fov = portrait ? 62 : 42; this.camera.updateProjectionMatrix();
    this.uni.uPx.value = h * dpr / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)); this.portrait = portrait; }
  goTo(i) {
    if (this.morphing) return;
    const A = this.geo.attributes, from = this.idx, f0 = this.forms[from], f1 = this.forms[i];
    if (f0) { A.aPosA.array.set(f0.pos); A.aColA.array.set(f0.col); } else A.aColA.array.set(this.forms[0].col);
    if (f1) { A.aPosB.array.set(f1.pos); A.aColB.array.set(f1.col); } else A.aColB.array.set(this.forms[0].col);
    A.aPosA.needsUpdate = A.aPosB.needsUpdate = A.aColA.needsUpdate = A.aColB.needsUpdate = true;
    this.uni.uSrcFig.value = FORMS[from].key === 'three' ? 1 : 0;
    this.uni.uDstFig.value = FORMS[i].key === 'three' ? 1 : 0;
    this.next = i; this.mix = 0; this.morphing = true;
    this.onForm(i);
  }
  update(dt, now, reduce) {
    this.time += dt; this.uni.uTime.value = this.time;
    if (this.morphing) { this.mix = Math.min(1, this.mix + dt / 3.2); if (this.mix >= 1) { this.morphing = false; this.idx = this.next; this.holdUntil = this.time + (FORMS[this.idx].key === 'three' ? 11 : 6.5); } }
    else if (!reduce && !this.frozen && this.time > this.holdUntil) this.goTo((this.idx + 1) % FORMS.length);
    this.uni.uMix.value = this.mix;
    this.scatter *= Math.exp(-dt / 0.35); this.uni.uScatter.value = this.scatter;
    this.uni.uBurst.value = this.burst; this.uni.uCollapse.value = this.collapse;
    const isThree = (this.morphing ? this.next : this.idx) === FORMS.length - 1;
    if (isThree) { // 8 字形要正面看：把转角拉回到一个轻轻摆动的角度
      let ry = this.group.rotation.y % (Math.PI * 2); if (ry > Math.PI) ry -= Math.PI * 2; if (ry < -Math.PI) ry += Math.PI * 2;
      const target = reduce ? 0 : Math.sin(this.time * 0.09) * 0.32;
      this.group.rotation.y = ry + (target - ry) * (1 - Math.exp(-dt / 1.4));
    } else if (!reduce) this.group.rotation.y += dt * 0.07;
    this.group.rotation.x += ((isThree ? -0.5 : 0.08) - this.group.rotation.x) * (1 - Math.exp(-dt / 1.2));
    this.ptr.x += (this.ptr.tx - this.ptr.x) * 0.04; this.ptr.y += (this.ptr.ty - this.ptr.y) * 0.04;
    const c = this.camera, z = this.portrait ? 11.5 : 9;
    c.position.set(this.ptr.x * 1.2 + Math.sin(this.time * 0.07) * 0.25, 0.3 - this.ptr.y * 0.8, z);
    c.lookAt(0, 0, 0);
  }
}
