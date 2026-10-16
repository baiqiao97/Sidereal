// 粒子形态：每个函数返回 N 个点的位置和颜色（Float32Array，长度 N*3）。
// 顺序照 Nocturne：星云 → 侧看的星系 → 洛伦兹 → 带环行星 → 莫比乌斯环 → Aizawa → 三体 8 字形（着色器里实时算）。

export const rng = seed => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const gauss = R => { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * R()); };

// 蓝白星光：大多数偏冷，少数纯白、少数暖
function starColor(R, warm = 0) {
  const t = R(), b = 0.55 + 0.45 * Math.pow(R(), 0.6);
  let c = t < 0.55 ? [0.62, 0.70, 1.0] : t < 0.9 ? [0.86, 0.9, 1.0] : [1, 1, 1];
  if (R() < warm) c = [1.0, 0.8, 0.52];
  return [c[0] * b, c[1] * b, c[2] * b];
}
function pack(N, fn) {
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const [p, c] = fn(i); pos.set(p, i * 3); col.set(c, i * 3); }
  return { pos, col };
}
const rotX = ([x, y, z], a) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rotZ = ([x, y, z], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];

export function nebula(N) {
  const R = rng(11);
  const clumps = Array.from({ length: 7 }, () => [gauss(R) * 1.1, gauss(R) * 0.6, gauss(R) * 0.8, 0.35 + R() * 0.6]);
  return pack(N, () => {
    if (R() < 0.55) { const c = clumps[(R() * clumps.length) | 0]; return [[c[0] + gauss(R) * c[3], c[1] + gauss(R) * c[3] * 0.7, c[2] + gauss(R) * c[3]], starColor(R)]; }
    return [[gauss(R) * 1.9, gauss(R) * 1.1, gauss(R) * 1.5], starColor(R)];
  });
}

export function galaxy(N) {
  const R = rng(23), tilt = 0.28;
  return pack(N, i => {
    const q = R();
    let p, c;
    if (q < 0.035) { // 喷流：从核心向上
      const h = Math.pow(R(), 0.7) * 3.2 * (R() < 0.8 ? 1 : -0.4);
      p = [gauss(R) * 0.03 * (1 + h), h, gauss(R) * 0.03 * (1 + h)]; c = [0.85, 0.9, 1];
    } else if (q < 0.1) { // 核球
      const r = Math.pow(R(), 1.6) * 0.55, th = R() * 6.2832, ph = Math.acos(2 * R() - 1);
      p = [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.45, r * Math.sin(ph) * Math.sin(th)]; c = [1, 0.97, 0.92];
      if (Math.hypot(p[0], p[2]) < 0.1) p[0] += 0.14;
    } else { // 盘：指数分布、薄
      const r = 0.25 + -Math.log(1 - R() * 0.985) * 0.9, a = R() * 6.2832;
      const arm = Math.sin(2 * a - r * 1.3) > 0.2 || R() < 0.45;
      if (!arm) return [[Math.cos(a) * r * 1.02, gauss(R) * 0.03, Math.sin(a) * r * 1.02], starColor(R)];
      p = [Math.cos(a) * r, gauss(R) * 0.05 * Math.exp(-r * 0.4), Math.sin(a) * r]; c = starColor(R);
    }
    return [rotX(p, tilt), c];
  });
}

export function lorenz(N) {
  const R = rng(37), s = 10, rho = 28, b = 8 / 3, dt = 0.004;
  let x = 0.1, y = 0, z = 0;
  for (let i = 0; i < 3000; i++) { const dx = s * (y - x), dy = x * (rho - z) - y, dz = x * y - b * z; x += dx * dt; y += dy * dt; z += dz * dt; }
  return pack(N, () => {
    for (let k = 0; k < 3; k++) { const dx = s * (y - x), dy = x * (rho - z) - y, dz = x * y - b * z; x += dx * dt; y += dy * dt; z += dz * dt; }
    const p = [x * 0.1 + gauss(R) * 0.012, (z - 25) * 0.1 + gauss(R) * 0.012, y * 0.1 + gauss(R) * 0.012];
    const gold = x > 0 ? 0.6 : 0.04;
    return [rotZ(p, 0.35), starColor(R, gold)];
  });
}

export function ringedWorld(N) {
  const R = rng(41), tilt = 0.42;
  const rings = [[1.62, 1.78, 0.34], [1.9, 2.05, 0.28], [2.25, 2.55, 0.38]];
  return pack(N, () => {
    if (R() < 0.46) { // 球面
      const th = R() * 6.2832, ph = Math.acos(2 * R() - 1), r = 1.12 + gauss(R) * 0.012;
      return [[r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], starColor(R)];
    }
    let u = R(), k = 0; while (k < rings.length - 1 && u > rings[k][2]) { u -= rings[k][2]; k++; }
    const [a, bnd] = rings[k], r = a + R() * (bnd - a), th = R() * 6.2832;
    const p = [Math.cos(th) * r, gauss(R) * 0.012, Math.sin(th) * r];
    const c = starColor(R); const dim = 0.55 + 0.45 * R();
    return [rotZ(rotX(p, tilt), -0.18), [c[0] * dim, c[1] * dim, c[2] * dim]];
  });
}

export function mobius(N) {
  const R = rng(53), Rm = 1.75, w = 0.34;
  return pack(N, () => {
    const u = R() * 6.2832, v = (R() * 2 - 1) * w;
    const p = [(Rm + v * Math.cos(u / 2)) * Math.cos(u), (Rm + v * Math.cos(u / 2)) * Math.sin(u), v * Math.sin(u / 2)];
    const q = [p[0] + gauss(R) * 0.015, p[1] + gauss(R) * 0.015, p[2] + gauss(R) * 0.015];
    const lit = 0.7 + 0.3 * Math.cos(u - 0.6); const c = starColor(R);
    return [rotX([q[0] * 0.62, q[1], q[2]], 1.05), [c[0] * lit, c[1] * lit, c[2] * lit]];
  });
}

export function aizawa(N) {
  const R = rng(67), a = 0.95, b = 0.7, c = 0.6, d = 3.5, e = 0.25, f = 0.1, dt = 0.008;
  let x = 0.1, y = 0, z = 0;
  const step = () => { const dx = (z - b) * x - d * y, dy = d * x + (z - b) * y, dz = c + a * z - z * z * z / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x; x += dx * dt; y += dy * dt; z += dz * dt; };
  for (let i = 0; i < 4000; i++) step();
  return pack(N, () => {
    step(); step();
    const p = [x * 1.5, (z - 0.5) * 1.5, y * 1.5];
    const core = Math.hypot(p[0], p[2]) < 0.25 ? 1.35 : 1; const col = starColor(R);
    return [[p[0] + gauss(R) * 0.01, p[1] + gauss(R) * 0.01, p[2] + gauss(R) * 0.01], [col[0] * core, col[1] * core, col[2] * core]];
  });
}

// ---- 三体 8 字形：积分一整个周期，再展开成傅里叶系数给着色器 ----
export const PERIOD = 6.32591398;
export function figure8Coefficients(K = 16) {
  const ic = [[0.97000436, -0.24308753, 0.466203685, 0.43236573], [-0.97000436, 0.24308753, 0.466203685, 0.43236573], [0, 0, -0.93240737, -0.86473146]];
  let st = ic.flat();
  const deriv = s => {
    const o = new Array(12).fill(0);
    for (let i = 0; i < 3; i++) { o[i * 4] = s[i * 4 + 2]; o[i * 4 + 1] = s[i * 4 + 3]; }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { if (i === j) continue;
      const dx = s[j * 4] - s[i * 4], dy = s[j * 4 + 1] - s[i * 4 + 1], r3 = Math.pow(dx * dx + dy * dy, 1.5);
      o[i * 4 + 2] += dx / r3; o[i * 4 + 3] += dy / r3; }
    return o;
  };
  const M = 1024, sub = 24, h = PERIOD / (M * sub), xs = new Float64Array(M), ys = new Float64Array(M);
  for (let m = 0; m < M; m++) {
    xs[m] = st[0]; ys[m] = st[1];
    for (let k = 0; k < sub; k++) {
      const k1 = deriv(st), k2 = deriv(st.map((v, i) => v + k1[i] * h / 2)), k3 = deriv(st.map((v, i) => v + k2[i] * h / 2)), k4 = deriv(st.map((v, i) => v + k3[i] * h));
      st = st.map((v, i) => v + (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) * h / 6);
    }
  }
  const coef = new Float32Array((K + 1) * 4);
  for (let k = 0; k <= K; k++) {
    let ax = 0, bx = 0, ay = 0, by = 0;
    for (let m = 0; m < M; m++) { const th = 2 * Math.PI * k * m / M, c = Math.cos(th), s = Math.sin(th); ax += xs[m] * c; bx += xs[m] * s; ay += ys[m] * c; by += ys[m] * s; }
    const n = k === 0 ? M : M / 2;
    coef.set([ax / n, bx / n, ay / n, by / n], k * 4);
  }
  return coef;
}
