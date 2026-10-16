// 点击处的水波：只在有涟漪的那一秒把画面先画到离屏缓冲，再做一小圈折射；平时直接画到屏幕，零开销。
import * as THREE from 'three';

const N = 4;
const FS = /* glsl */`
uniform sampler2D tScene; uniform vec4 uR[${N}]; uniform float uAspect; varying vec2 vUv;
void main(){
  vec2 off = vec2(0.0); float shine = 0.0;
  for (int i = 0; i < ${N}; i++) {
    vec4 r = uR[i]; if (r.w <= 0.0) continue;
    vec2 d = vUv - r.xy; d.x *= uAspect; float dist = length(d);
    float front = 0.02 + r.z * 0.16;                     // 波前向外走，最远约 0.2 个屏高
    float ring = exp(-pow((dist - front) / 0.04, 2.0));
    float env = r.w * exp(-r.z * 2.6) * (1.0 - smoothstep(0.12, 0.22, dist));
    float w = sin((dist - front) * 78.0) * ring * env;
    vec2 dir = dist > 1e-4 ? d / dist : vec2(0.0); dir.x /= uAspect;
    off += dir * w * 0.004; shine += w * 0.1;   // 2026-10-15：水波更轻，不让画面晃
  }
  vec3 c = texture2D(tScene, vUv + off).rgb;
  gl_FragColor = vec4(c * (1.0 + shine) + vec3(max(shine, 0.0) * 0.1), 1.0);
}`;

export class Ripples {
  constructor(renderer) {
    this.renderer = renderer; this.list = [];
    this.rt = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true, colorSpace: THREE.NoColorSpace });
    this.uni = { tScene: { value: this.rt.texture }, uR: { value: Array.from({ length: N }, () => new THREE.Vector4(0, 0, 0, 0)) }, uAspect: { value: 1 } };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: FS, uniforms: this.uni, depthTest: false, depthWrite: false }));
    this.scene = new THREE.Scene(); this.scene.add(this.quad); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  resize(w, h, dpr) { this.rt.setSize(Math.round(w * dpr), Math.round(h * dpr)); this.uni.uAspect.value = w / h; }
  add(x, y, strength = 1) { this.list.push({ x, y, t: 0, s: strength }); if (this.list.length > N) this.list.shift(); }
  // 返回 true 表示这一帧已经画完
  render(scene, camera, dt) {
    this.list.forEach(r => r.t += dt); this.list = this.list.filter(r => r.t < 1.3);
    if (!this.list.length) return false;
    this.uni.uR.value.forEach((v, i) => { const r = this.list[i]; if (r) v.set(r.x, r.y, r.t, r.s); else v.set(0, 0, 0, 0); });
    this.renderer.setRenderTarget(this.rt); this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null); this.renderer.render(this.scene, this.cam);
    return true;
  }
}
