# NASA Deep Star Maps 2020（16K，银道坐标，HDR）+ 耶鲁亮星星表 → 网页用的天空素材（第 2 版）。
# 肉眼可见的星（V ≤ 6.5，约 9100 颗）从贴图里抠掉，改成实时星点：位置、星等、颜色都取自星表，
# 这样它们能按大气物理闪烁、在地平线附近变暗变红、倒映在海里。更暗的星留在贴图里当银河的光。
# 产出（assets-src/sky/，文件名带版本号，因为 /assets/* 是一年不可变缓存）：
#   band3-16k.jpg / band3-8k.jpg   银河带 |b| ≤ 21.97°，已抠掉亮星，暗星颗粒只留 GRAIN 倍（内容一变就升版本号）
#   base2-4k.jpg / base2-2k.jpg    全天底图，去掉星点只留光晕
#   stars2.bin                     u32 n, u32 亮星数 nb；int16 方向 xyz × n；uint8 rgb + 星等 × n
#                                  前 nb 颗是星表亮星（按星等升序，不受银河带渐隐影响），其后是贴图里找到的带外暗星（按亮度降序）
#                                  星等字节 = (V + 2) × 20
# 第 1 版产出备份在 assets-src/sky-v1/。
import OpenEXR, numpy as np, time, os, struct, gzip
from scipy.ndimage import maximum_filter, grey_opening, uniform_filter, gaussian_filter
from scipy.spatial import cKDTree
from PIL import Image
T = time.time(); log = lambda *a: print(f'[{time.time()-T:5.1f}s]', *a, flush=True)
OUT = 'assets-src/sky'; os.makedirs(OUT, exist_ok=True)
K, SAT, BLACK = 15.0, 1.35, 0.010   # 曝光、饱和度、黑位（线性）
with OpenEXR.File('assets-src/starmap_2020_16k_gal.exr') as f: px = f.channels()['RGB'].pixels
H, W = px.shape[:2]; log('loaded', W, H)
LUM = np.array([0.2126, 0.7152, 0.0722], np.float32)

def tone(rgb):  # 线性 HDR → sRGB 0..1（按亮度压缩，保色相）
    rgb = rgb.astype(np.float32)
    L = rgb @ LUM
    Lt = 1 - np.exp(-L * K)
    out = rgb * (Lt / np.maximum(L, 1e-7))[..., None]
    out = Lt[..., None] + (out - Lt[..., None]) * SAT
    out = np.clip((out - BLACK) / (1 - BLACK), 0, 1)
    return np.where(out <= 0.0031308, out * 12.92, 1.055 * np.power(out, 1 / 2.4) - 0.055)

def save(arr, name, q):
    Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)).save(f'{OUT}/{name}', 'JPEG', quality=q, optimize=True, progressive=True, subsampling=0 if q >= 90 else 2)
    log(name, arr.shape[1], 'x', arr.shape[0], round(os.path.getsize(f'{OUT}/{name}') / 1e6, 2), 'MB')

# 0. 耶鲁亮星星表（Hoffleit & Warren 1991，CDS V/50）：J2000 赤经赤纬 → 银道坐标
cat = []
for line in gzip.open('assets-src/bsc5_catalog.gz').read().decode('latin-1').splitlines():
    line = line.ljust(200)
    if not line[75:77].strip() or not line[102:107].strip(): continue
    ra = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
    dec = (-1 if line[83] == '-' else 1) * (int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600)
    bv = float(line[109:114]) if line[109:114].strip() else np.nan
    cat.append((ra, dec, float(line[102:107]), bv, float(line[90:96]), float(line[96:102])))
cat = np.array(cat); cat = cat[np.argsort(cat[:, 2])]
a, d = np.radians(cat[:, 0]), np.radians(cat[:, 1])
EQ2GAL = np.array([[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]])
gdir = (EQ2GAL @ np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)])).T
V = cat[:, 2]; BV = cat[:, 3]
gl, gb = np.arctan2(gdir[:, 1], gdir[:, 0]), np.arcsin(np.clip(gdir[:, 2], -1, 1))
dl = (np.degrees(gl) - cat[:, 4] + 180) % 360 - 180; log('catalog stars', len(V), 'V range', V.min(), V.max(), '| check vs catalogue GLON/GLAT (deg):', round(np.abs(dl * np.cos(gb)).max(), 3), round(np.abs(np.degrees(gb) - cat[:, 5]).max(), 3))
cx = ((0.5 - gl / (2 * np.pi)) * W) % W; cy = (0.5 - gb / np.pi) * H     # 连续像素坐标，像素 i 的中心在 i + 0.5
rad = np.clip(2.6 + 1.25 * np.maximum(0, 6.5 - V) + 0.9 * np.maximum(0, 2 - V) ** 1.5, 2.6, 20.0)   # 抠除半径：最亮的几颗带宽光晕，天狼星约 18 像素

# 1. 用没饱和的亮星标定贴图的星等零点（3×3 通量，与暗星的取法一致）
def peak_at(y, x):
    yi, xi = int(y), int(x); win = px[yi - 3:yi + 4, np.arange(xi - 3, xi + 4) % W].astype(np.float32)
    L = win @ LUM; iy, ix = np.unravel_index(L.argmax(), L.shape); return L[iy - 1:iy + 2, ix - 1:ix + 2].sum(), L.max(), win[iy, ix]
sel = np.nonzero((V > 4.8) & (V < 6.6) & (cy > 8) & (cy < H - 8))[0][::3]
pk = [peak_at(cy[i], cx[i]) for i in sel]
fl = np.array([p[:2] for p in pk]); ok = fl[:, 1] < 0.85
ZP = np.median(V[sel][ok] + 2.5 * np.log10(fl[ok, 0]))
log('zero point', round(ZP, 3), 'scatter (mag)', round(np.std(V[sel][ok] + 2.5 * np.log10(fl[ok, 0]) - ZP), 3), 'n', ok.sum())

# 2. 颜色：B−V → 色温（Ballesteros 2012）→ 黑体 → sRGB；再按贴图里同一批星的颜色定饱和度，两种星色调一致
lam = np.arange(380, 781, 5) * 1e-9; ln = lam * 1e9
g = lambda x, m, s1, s2: np.exp(-0.5 * ((x - m) / np.where(x < m, s1, s2)) ** 2)
xb = 1.056 * g(ln, 599.8, 37.9, 31.0) + 0.362 * g(ln, 442.0, 16.0, 26.7) - 0.065 * g(ln, 501.1, 20.4, 26.2)
yb = 0.821 * g(ln, 568.8, 46.9, 40.5) + 0.286 * g(ln, 530.9, 16.3, 31.1)
zb = 1.217 * g(ln, 437.0, 11.8, 36.0) + 0.681 * g(ln, 459.0, 26.0, 13.8)
XYZ2RGB = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
def bv_rgb(bv, sat):
    bv = np.clip(np.nan_to_num(bv, nan=0.6), -0.33, 2.0)
    Tk = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
    P = 1 / (lam[None] ** 5 * (np.exp(6.62607e-34 * 2.99792e8 / (lam[None] * 1.380649e-23 * Tk[:, None])) - 1))
    rgb = (XYZ2RGB @ np.stack([P @ xb, P @ yb, P @ zb])).T; rgb = np.maximum(rgb, 0)
    rgb = rgb / (rgb @ LUM)[:, None]; rgb = np.maximum(1 + (rgb - 1) * sat, 0)   # 以白为中心调饱和度
    rgb /= rgb.max(axis=1, keepdims=True)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
ref = np.array([tone(p[2][None])[0] for i, p in zip(sel, pk)])[ok]; ref /= np.maximum(ref.max(axis=1, keepdims=True), 1e-6)
best = min(np.arange(0.3, 2.01, 0.05), key=lambda s: np.mean((bv_rgb(BV[sel][ok], s) - ref) ** 2))
COL = bv_rgb(BV, best); log('colour saturation fitted', round(best, 2), '| B-V 1.85 →', bv_rgb(np.array([1.85]), best).round(2), '−0.03 →', bv_rgb(np.array([-0.03]), best).round(2), '0.65 →', bv_rgb(np.array([0.65]), best).round(2))

# 3. 抠星：圆盘内用周围的平滑光填，再借旁边一块的细节纹理，放大看也不会出现糊斑
def inpaint(img, xs, ys, rs, texture):
    h, w = img.shape[:2]; M = np.zeros((h, w), np.float32)
    boxes = []
    for x, y, r in zip(xs, ys, rs):
        R = int(np.ceil(r + 2)); yy = np.arange(int(y) - R, int(y) + R + 1); yy = yy[(yy >= 0) & (yy < h)]
        if not len(yy): continue
        xx = np.arange(int(x) - R, int(x) + R + 1) % w
        dist = np.hypot(yy[:, None] + 0.5 - y, ((xx[None] + 0.5 - x + w / 2) % w) - w / 2)
        M[yy[:, None], xx[None]] = np.maximum(M[yy[:, None], xx[None]], np.clip((r + 0.8 - dist) / 1.5, 0, 1)); boxes.append((yy, xx, R))
    keep = (M == 0).astype(np.float32); fill = cover = None
    for s in (2.5, 6.0, 16.0):   # 由小到大的归一化卷积：小洞用近处的光，大洞退到更远
        wgt = gaussian_filter(keep, s, mode=['nearest', 'wrap'])
        f = np.stack([gaussian_filter(img[..., c] * keep, s, mode=['nearest', 'wrap']) for c in range(3)], -1) / np.maximum(wgt, 1e-6)[..., None]
        if fill is None: fill, cover = f, wgt
        else: use = cover < 0.08; fill = np.where(use[..., None], f, fill); cover = np.where(use, wgt, cover)
    if texture:   # 从旁边没有亮星的一块借高频细节
        hp = img - np.stack([gaussian_filter(img[..., c], 2.0, mode=['nearest', 'wrap']) for c in range(3)], -1)
        for yy, xx, R in boxes:
            patch = fill[yy[:, None], xx[None]]; hole = M[yy[:, None], xx[None]] > 0
            if not hole.any(): continue
            want = patch[hole] @ LUM
            for k in (1, 2):
                for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                    sy = yy + dy * k * (2 * R + 3)
                    if sy.min() < 0 or sy.max() >= h: continue
                    sx = (xx + dx * k * (2 * R + 3)) % w
                    if M[sy[:, None], sx[None]].max() > 0: continue
                    nb = img[sy[:, None], sx[None]]; ratio = want.mean() / max((nb[hole] @ LUM).mean(), 1e-6)
                    if not 0.65 < ratio < 1.55: continue    # 只借亮度相近的一块，暗带里不借亮区的颗粒
                    fill[yy[:, None], xx[None]] = patch + np.maximum(hp[sy[:, None], sx[None]] * ratio, -0.6 * patch); break
                else: continue
                break
    a = M[..., None]
    return img * (1 - a) + np.maximum(fill, 0) * a

# 4. 银河带：抠掉带内的星表亮星
r0, r1 = H // 2 - 1000, H // 2 + 1000
inb = (cy > r0 - 16) & (cy < r1 + 16)
bandLin = inpaint(px[r0:r1].astype(np.float32), cx[inb], cy[inb] - r0, rad[inb], True); log('band inpainted', inb.sum(), 'stars')
# 银河带里满是肉眼分辨不出的暗星颗粒：开运算取出去掉颗粒的光，颗粒只留 GRAIN 倍（暗带和光晕的结构都比 3 像素大，不受影响）
GRAIN = 0.42
bandLin = np.stack([(lambda ch: grey_opening(ch, size=(3, 3), mode='wrap'))(bandLin[..., c]) for c in range(3)], -1) * (1 - GRAIN) + bandLin * GRAIN; log('band grain x', GRAIN)
band = np.concatenate([tone(bandLin[r:r + 250]) for r in range(0, 2000, 250)]); del bandLin
save(band, 'band3-16k.jpg', 86)
b8 = band.reshape(1000, 2, 8192, 2, 3).mean(axis=(1, 3)); save(b8, 'band3-8k.jpg', 88); del band, b8

# 5. 全天底图（先 4×4 平均到 4K，抠亮星，再开运算去暗星）
small = np.concatenate([px[r:r + 512].astype(np.float32).reshape(128, 4, 4096, 4, 3).mean(axis=(1, 3)) for r in range(0, H, 512)])
small = inpaint(small, cx / 4, cy / 4, np.maximum(rad / 4 + 0.6, 1.4), False)
base_lin = np.stack([grey_opening(small[..., c], size=(3, 3)) for c in range(3)], -1)
base_lin = base_lin + (small - base_lin) * 0.05   # 暗星已经实时画成点，底图只留极少残影，放大时不会出现糊斑
base = tone(base_lin); save(base, 'base2-4k.jpg', 90)
save(base.reshape(1024, 2, 2048, 2, 3).mean(axis=(1, 3)), 'base2-2k.jpg', 90); del small, base_lin, base

# 6. 带外暗星：在 16K 原图上找局部极大值，去掉落在星表亮星圆盘里的
stars = []
bmargin = int(H * (18.0 / 180))   # |b| > 18° 开始取星（与银河带 19°–22° 交叠渐变）
for (a0, bnd) in ((0, H // 2 - bmargin), (H // 2 + bmargin, H)):
    for r in range(a0, bnd, 1024):
        rr = slice(max(a0, r - 2), min(bnd, r + 1024 + 2))
        rgb = px[rr].astype(np.float32); L = rgb @ LUM
        flux = uniform_filter(L, 3) * 9
        peak = (L == maximum_filter(L, size=5)) & (L > 0.012)
        ys, xs = np.nonzero(peak)
        keep = (ys + rr.start >= r) & (ys + rr.start < min(bnd, r + 1024)); ys, xs = ys[keep], xs[keep]
        c = tone(rgb[ys, xs]); stars.append(np.column_stack([ys + rr.start, xs, flux[ys, xs], c]))
S = np.concatenate(stars); S = S[np.argsort(-S[:, 2])]
y, x = S[:, 0] + 0.5, S[:, 1] + 0.5
l = (0.5 - x / W) * 2 * np.pi; b = (0.5 - y / H) * np.pi
dF = np.column_stack([np.cos(b) * np.cos(l), np.cos(b) * np.sin(l), np.sin(b)])
tree = cKDTree(dF); drop = np.zeros(len(S), bool)
for i in range(len(V)):
    for j in tree.query_ball_point(gdir[i], (rad[i] + 1.5) * 2 * np.pi / W): drop[j] = True
S, dF = S[~drop][:120000 - len(V)], dF[~drop][:120000 - len(V)]
vF = ZP - 2.5 * np.log10(np.maximum(S[:, 2], 1e-6))
colF = S[:, 3:6] / np.maximum(S[:, 3:6].max(axis=1, keepdims=True), 1e-6)
log('faint field stars', len(S), '| dropped inside catalog discs', drop.sum(), '| V p1/p50/p99', np.percentile(vF, [1, 50, 99]).round(2))

# 7. 写出
dAll = np.concatenate([gdir, dF]); cAll = np.concatenate([COL, colF]); vAll = np.concatenate([V, vF]); n = len(dAll)
with open(f'{OUT}/stars2.bin', 'wb') as fo:
    fo.write(struct.pack('<II', n, len(V)))
    fo.write((dAll * 32767).round().astype('<i2').tobytes())
    fo.write(np.column_stack([cAll * 255, (vAll + 2) * 20]).round().clip(0, 255).astype(np.uint8).tobytes())
log('stars2.bin', n, 'of which catalog', len(V), round(os.path.getsize(f'{OUT}/stars2.bin') / 1e6, 2), 'MB')
