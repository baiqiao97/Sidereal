# Solar System Scope 行星贴图（CC BY 4.0）→ 网页用的分级贴图和列表缩略图。
# 产出 assets-src/planets/：planet-<名>-2k/4k/8k.jpg、earth-clouds-2k/4k.jpg、ring-saturn.png、thumb-<名>.png
import numpy as np, os
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
SRC, OUT = 'assets-src/planets-src', 'assets-src/planets'; os.makedirs(OUT, exist_ok=True)
PLANETS = {  # 名字: (源文件, 大气辉光颜色或 None)
    'jupiter': ('8k_jupiter.jpg', (232, 205, 170)), 'saturn': ('8k_saturn.jpg', (238, 220, 180)), 'mars': ('8k_mars.jpg', (255, 175, 140)),
    'earth': ('8k_earth_daymap.jpg', (120, 170, 255)), 'moon': ('8k_moon.jpg', None), 'mercury': ('8k_mercury.jpg', None),
    'venus': ('4k_venus_atmosphere.jpg', (255, 220, 160)), 'uranus': ('2k_uranus.jpg', (170, 230, 240)), 'neptune': ('2k_neptune.jpg', (120, 150, 255)),
}
def save(im, name, q=85):
    im.save(f'{OUT}/{name}', 'JPEG', quality=q, optimize=True, progressive=True, subsampling=2)
    print(name, im.size, round(os.path.getsize(f'{OUT}/{name}') / 1e6, 2), 'MB')
tiers = {}
for name, (f, glow) in PLANETS.items():
    im = Image.open(f'{SRC}/{f}').convert('RGB'); w = im.width; tiers[name] = []
    for tw, tag in ((2048, '2k'), (4096, '4k'), (8192, '8k')):
        if w >= tw: save(im.resize((tw, tw // 2), Image.LANCZOS) if w != tw else im, f'planet-{name}-{tag}.jpg'); tiers[name].append(tag)
clouds = Image.open(f'{SRC}/8k_earth_clouds.jpg').convert('L')
for tw, tag in ((2048, '2k'), (4096, '4k')): save(clouds.resize((tw, tw // 2), Image.LANCZOS), f'earth-clouds-{tag}.jpg', 80)
ring = Image.open(f'{SRC}/8k_saturn_ring_alpha.png').convert('RGBA').resize((2048, 16), Image.LANCZOS); ring.save(f'{OUT}/ring-saturn.png', optimize=True)

# 列表里的小星球：正交投影 + 左上来光 + 大气边缘光，2 倍超采样
S = 192
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); x = (xx + 0.5) / S * 2 - 1; y = 1 - (yy + 0.5) / S * 2
r2 = x * x + y * y; inside = r2 <= 1; z = np.sqrt(np.clip(1 - r2, 0, 1))
L = np.array([-0.55, 0.45, 0.7]); L = L / np.linalg.norm(L)
for name, (f, glow) in PLANETS.items():
    tex = np.asarray(Image.open(f'{OUT}/planet-{name}-2k.jpg').convert('RGB'), np.float32) / 255
    lon = np.arctan2(x, z) + 0.9; lat = np.arcsin(np.clip(y, -1, 1))
    u = ((lon / (2 * np.pi) + 0.5) % 1) * (tex.shape[1] - 1); v = (0.5 - lat / np.pi) * (tex.shape[0] - 1)
    col = tex[v.astype(int), u.astype(int)]
    diff = np.clip(x * L[0] + y * L[1] + z * L[2], 0, 1); shade = 0.06 + 0.94 * np.power(diff, 0.8)
    out = col * shade[..., None]
    if glow is not None:
        rim = np.power(1 - z, 3.0) * 0.8; out = out + np.array(glow) / 255 * rim[..., None] * (0.3 + 0.7 * diff[..., None])
    a = inside.astype(np.float32)
    rgba = np.concatenate([np.clip(out, 0, 1) * a[..., None], a[..., None]], -1)
    Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA').resize((96, 96), Image.LANCZOS).save(f'{OUT}/thumb-{name}.png', optimize=True)
print('tiers', tiers)
