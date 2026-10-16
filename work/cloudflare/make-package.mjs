// 生成 Cloudflare 发布包：加密内容（vault）照旧取自 Firebase 正式包，外壳用 work/next-zone（2026-09-29 起的正式外壳）。
// 改外壳 → 改 work/next-zone/src；改作品 → 按原流程更新正式包的 vault。两种情况都再跑一次本脚本，然后 ./发布.sh。
// 用法：node make-package.mjs [源包目录] [目标目录]
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname), base = path.resolve(here, '../..');
const src = path.resolve(process.argv[2] || path.join(base, 'outputs/加密网页新密码本机版'));
const dest = path.resolve(process.argv[3] || path.join(base, 'outputs/加密网页Cloudflare版'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

execFileSync('node', [path.join(src, 'deployment-guard.cjs')], { stdio: 'inherit' }); // 加密内容先过正式包自己的校验
const srcExpected = JSON.parse(fs.readFileSync(path.join(src, '发布文件校验.json')));
execFileSync('node', [path.join(base, 'work/next-zone/build.mjs')], { stdio: 'inherit' }); // 打包外壳
const dist = path.join(base, 'work/next-zone/dist');

fs.mkdirSync(dest, { recursive: true });
const pub = path.join(dest, 'public');
fs.rmSync(pub, { recursive: true, force: true }); fs.mkdirSync(pub);
execFileSync('cp', ['-cR', path.join(src, 'public/vault'), path.join(pub, 'vault')]);
fs.copyFileSync(path.join(src, 'public/vault-config.json'), path.join(pub, 'vault-config.json'));
for (const f of ['index.html', 'gate.css', 'sw.js']) fs.copyFileSync(path.join(dist, f), path.join(pub, f));
execFileSync('cp', ['-R', path.join(dist, 'assets'), path.join(pub, 'assets')]);
fs.copyFileSync(path.join(here, 'template/_headers'), path.join(pub, '_headers'));
for (const f of ['wrangler.jsonc', 'deployment-guard.cjs', '发布.sh', '使用说明.md']) fs.copyFileSync(path.join(here, 'template', f), path.join(dest, f));
fs.chmodSync(path.join(dest, '发布.sh'), 0o755);

// 2026-10-15 精简目录：网页每次进门都要先下这份加密目录，它在高数拆包后涨到 4 MB，慢网下进门要等很久甚至超时。
// 发布包里的 manifest.bin 换成精简版：只留 sw.js 用得到的字段（编号、分块数、类型、是否压缩），分块名由「编号-序号.bin」推出，再 gzip，约 0.4 MB。
// 正式包和所有管理工具（vault-file、vault-batch……）仍用完整目录，不受影响。需要公开层钥匙 OPEN_KEY；没有就保持完整目录。
const mp = path.join(pub, 'vault/manifest.bin');
if (process.env.OPEN_KEY) {
  const { gzipSync } = await import('node:zlib'), K = Buffer.from(process.env.OPEN_KEY, 'base64'), b = fs.readFileSync(mp);
  const d = crypto.createDecipheriv('aes-256-gcm', K, b.subarray(0, 12)); d.setAAD(Buffer.from('manifest:v1')); d.setAuthTag(b.subarray(-16));
  const m = JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()])), files = {};
  for (const [p, it] of Object.entries(m.files)) {
    if (!it.chunks.every((f, i) => f === `${it.id}-${i}.bin`)) throw Error('分块名不符合「编号-序号.bin」规律，不能精简：' + p);
    files[p] = { i: it.id, n: it.chunks.length, t: it.type, ...(it.gzip ? { g: 1 } : {}) };
  }
  const lean = gzipSync(Buffer.from(JSON.stringify({ version: m.version, files })), { level: 9 });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', K, iv); c.setAAD(Buffer.from('manifest:v1'));
  fs.rmSync(mp); fs.writeFileSync(mp, Buffer.concat([iv, c.update(lean), c.final(), c.getAuthTag()]));
  console.log(`网页用精简目录：${(b.length / 1e6).toFixed(2)} MB → ${(fs.statSync(mp).size / 1e6).toFixed(2)} MB（${Object.keys(files).length} 个文件）`);
} else console.log('没有 OPEN_KEY：网页仍用完整目录');

const expected = {};
for (const [k, v] of Object.entries(srcExpected)) if (k.startsWith('vault/') || k === 'vault-config.json') expected[k] = v;
expected['vault/manifest.bin'] = sha(mp);
for (const f of ['index.html', 'gate.css', 'sw.js', '_headers']) expected[f] = sha(path.join(pub, f));
for (const f of fs.readdirSync(path.join(pub, 'assets'))) expected['assets/' + f] = sha(path.join(pub, 'assets', f));
fs.writeFileSync(path.join(dest, '发布文件校验.json'), JSON.stringify(expected, null, 1));
execFileSync('node', [path.join(dest, 'deployment-guard.cjs')], { stdio: 'inherit' });
console.log('Cloudflare package ready: ' + dest);
