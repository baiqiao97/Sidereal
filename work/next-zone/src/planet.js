// 真实行星：Solar System Scope 贴图（CC BY 4.0，基于 NASA 数据）+ 晨昏线光照 + 大气辉光 + 地球云层 + 土星环。
import * as THREE from 'three';

export const PLANETS = {
  jupiter: { tiers: ['2k', '4k'], glow: [0.91, 0.8, 0.66], glowAmt: 0.55 },
  saturn: { tiers: ['2k', '4k'], glow: [0.93, 0.86, 0.7], glowAmt: 0.5, ring: true },
  mars: { tiers: ['2k', '4k', '8k'], glow: [1.0, 0.68, 0.55], glowAmt: 0.35 },
  earth: { tiers: ['2k', '4k', '8k'], glow: [0.45, 0.66, 1.0], glowAmt: 1.0, clouds: true },
  moon: { tiers: ['2k', '4k', '8k'], glow: null },
  mercury: { tiers: ['2k', '4k', '8k'], glow: null },
  venus: { tiers: ['2k', '4k'], glow: [1.0, 0.86, 0.62], glowAmt: 0.9 },
  uranus: { tiers: ['2k'], glow: [0.66, 0.9, 0.94], glowAmt: 0.7 },
  neptune: { tiers: ['2k'], glow: [0.46, 0.6, 1.0], glowAmt: 0.75 },
};
export const PLANET_NAMES = Object.keys(PLANETS);
export const planetOf = h => PLANET_NAMES[h % PLANET_NAMES.length];

const V = /* glsl */`varying vec2 vUv; varying vec3 vN, vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const F = /* glsl */`uniform sampler2D uMap, uClouds; uniform float uHasClouds, uCloudShift, uAlpha, uGlowAmt; uniform vec3 uGlow, uL;
varying vec2 vUv; varying vec3 vN, vV;
void main(){
  float nl = dot(vN, uL), day = smoothstep(-0.1, 0.32, nl);
  vec3 col = texture2D(uMap, vUv).rgb;
  if (uHasClouds > 0.5) { float c = texture2D(uClouds, vec2(vUv.x + uCloudShift, vUv.y)).r; col = mix(col, vec3(0.97), smoothstep(0.08, 0.9, c) * 0.9); }
  float fres = 1.0 - max(dot(vN, vV), 0.0);
  col *= 0.025 + 0.975 * day;
  col += uGlow * pow(fres, 3.2) * uGlowAmt * (0.12 + 0.88 * day);
  gl_FragColor = vec4(col, uAlpha);
}`;
const HALO_F = /* glsl */`uniform vec3 uGlow, uL; uniform float uGlowAmt, uAlpha; varying vec3 vN, vV; varying vec2 vUv;
void main(){ float f = 1.0 - abs(dot(vN, vV)); float day = smoothstep(-0.35, 0.4, dot(vN, uL));
  gl_FragColor = vec4(uGlow * pow(f, 5.0) * uGlowAmt * 1.4 * (0.08 + 0.92 * day) * uAlpha, 1.0); }`;
const RING_V = /* glsl */`varying vec3 vLocal, vWorld; void main(){ vLocal = position; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const RING_F = /* glsl */`uniform sampler2D uRing; uniform vec3 uLW, uCenter; uniform float uAlpha; varying vec3 vLocal, vWorld;
void main(){
  float r = length(vLocal.xy), u = (r - 1.24) / (2.27 - 1.24); if (u < 0.0 || u > 1.0) discard;
  vec4 t = texture2D(uRing, vec2(u, 0.5));
  vec3 p = vWorld - uCenter; float b = dot(p, uLW), c = dot(p, p) - 1.0;   // 星球挡住阳光的地方是影子
  float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.12 : 1.0;
  gl_FragColor = vec4(t.rgb * shadow * 0.95, t.a * uAlpha);
}`;

export class Planet {
  constructor(renderer, maxTier) {
    this.renderer = renderer; this.maxTier = maxTier; this.cache = new Map(); this.kind = null; this.time = 0;
    this.group = new THREE.Group(); this.group.visible = false; this.group.renderOrder = 5;
    this.uni = { uMap: { value: null }, uClouds: { value: null }, uHasClouds: { value: 0 }, uCloudShift: { value: 0 }, uAlpha: { value: 1 }, uGlow: { value: new THREE.Vector3(1, 1, 1) }, uGlowAmt: { value: 0 }, uL: { value: new THREE.Vector3(-0.6, 0.35, 0.72).normalize() } };
    this.body = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 96), new THREE.ShaderMaterial({ vertexShader: V, fragmentShader: F, uniforms: this.uni, transparent: true, depthWrite: true, depthTest: true }));
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1.045, 96, 48), new THREE.ShaderMaterial({ vertexShader: V, fragmentShader: HALO_F, uniforms: this.uni, transparent: true, depthWrite: false, depthTest: true, side: THREE.BackSide, blending: THREE.AdditiveBlending }));
    this.ringUni = { uRing: { value: null }, uLW: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector3() }, uAlpha: this.uni.uAlpha };
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.24, 2.27, 384, 1), new THREE.ShaderMaterial({ vertexShader: RING_V, fragmentShader: RING_F, uniforms: this.ringUni, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide }));
    this.ring.rotation.x = Math.PI / 2 - 0.47; this.ring.rotation.y = 0.18;
    this.spin = new THREE.Group(); this.spin.add(this.body); this.spin.rotation.z = 0.12;
    this.group.add(this.spin, this.halo, this.ring);
    [this.body, this.halo, this.ring].forEach(m => { m.renderOrder = 5; m.frustumCulled = false; });
  }
  tex(url, color = true) {
    if (!this.cache.has(url)) this.cache.set(url, new Promise((res, rej) => new THREE.TextureLoader().load(url, t => {
      t.colorSpace = THREE.NoColorSpace; t.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy()); t.wrapS = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; res(t);
    }, undefined, rej)));
    return this.cache.get(url);
  }
  best(kind) { const tiers = PLANETS[kind].tiers, order = ['2k', '4k', '8k'], max = order.indexOf(this.maxTier); return tiers.filter(t => order.indexOf(t) <= max).pop(); }
  preload(kind) { this.tex(`/assets/planet-${kind}-2k.jpg`).catch(() => {}); }
  // 先用 2K 马上开始飞，高清图到了再换上
  async show(kind) {
    const P = PLANETS[kind]; this.kind = kind;
    const low = await this.tex(`/assets/planet-${kind}-2k.jpg`);
    if (this.kind !== kind) return;
    this.uni.uMap.value = low; this.uni.uHasClouds.value = 0; this.ring.visible = !!P.ring; this.halo.visible = !!P.glow;
    if (P.glow) { this.uni.uGlow.value.set(...P.glow); this.uni.uGlowAmt.value = P.glowAmt; } else this.uni.uGlowAmt.value = 0;
    if (P.ring) this.tex('/assets/ring-saturn.png').then(t => { if (this.kind === kind) this.ringUni.uRing.value = t; });
    if (P.clouds) this.tex(`/assets/earth-clouds-${this.maxTier === '2k' ? '2k' : '4k'}.jpg`).then(t => { if (this.kind === kind) { this.uni.uClouds.value = t; this.uni.uHasClouds.value = 1; } });
    const hd = this.best(kind); if (hd !== '2k') this.tex(`/assets/planet-${kind}-${hd}.jpg`).then(t => { if (this.kind === kind) this.uni.uMap.value = t; }).catch(() => {});
    this.spin.rotation.y = (kind.length * 1.7) % 6.28;
  }
  update(dt, camera) {
    this.time += dt; this.spin.rotation.y += dt * 0.025; this.uni.uCloudShift.value = this.time * 0.0015;
    if (this.ring.visible) { this.ringUni.uLW.value.copy(this.uni.uL.value).applyQuaternion(camera.quaternion); this.ringUni.uCenter.value.copy(this.group.position); }
  }
}
