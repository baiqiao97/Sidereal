# 给一件作品嵌入「划线笔记」（2026-10-16）：样式插在 </head> 前，配置和代码插在 </body> 前；每件作品各带一份，不引用外部文件。
# 用法：python3 add-notes.py <原文件.html> <输出.html> <配置模板.js> <本机存储的键> <标题>
import sys, os
src, out, cfg, key, title = sys.argv[1:6]
here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'notes')
h = open(src, encoding='utf-8').read()
if 'window.__NOTES_CONFIG' in h: raise SystemExit('✗ 这件作品已经嵌过划线笔记')
css = open(os.path.join(here, 'notes-kit.css'), encoding='utf-8').read()
js = open(os.path.join(here, 'notes-kit.js'), encoding='utf-8').read()
conf = open(cfg, encoding='utf-8').read().replace('__KEY__', key).replace('__TITLE__', title)
for bad in ('</script', '</style'):
    if bad in js or bad in conf or (bad == '</style' and bad in css): raise SystemExit('✗ 代码里不能出现 ' + bad)
i = h.find('</head>'); j = h.rfind('</body>')
if i < 0 or j < 0 or j < i: raise SystemExit('✗ 找不到 </head> 或 </body>')
h = h[:j] + f'<script>{conf}</script><script>{js}</script>' + h[j:]
h = h[:i] + f'<style id="sdn-style">{css}</style>' + h[i:]
open(out, 'w', encoding='utf-8').write(h)
print(f'✓ {os.path.basename(out)}：已嵌入划线笔记（键 {key}）')
