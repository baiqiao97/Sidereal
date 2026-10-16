// 一次往加密库里放很多文件（2026-10-15，高数拆包用）：一个文件夹整个加进去，再替换若干个已有文件；只算一次钥匙、只写一次目录。
// 用法：echo '{"password":"…"}' | node vault-batch.mjs --pkg <正式包> [--add-dir <本地文件夹>=<库里的路径前缀>] … [--put <库里的路径>=<本地文件>] … [--dry]
// 规则和 vault-file.mjs 一样：每个文件独立分块（1 MiB）、能压缩就 gzip、AAD 是「id:序号」；发布校验清单同步更新；放完逐个解开核对。
import fs from 'node:fs'; import path from 'node:path';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
const argv = process.argv.slice(2), many = n => argv.flatMap((a, i) => a === n ? [argv[i + 1]] : []), DRY = argv.includes('--dry');
const pkg = path.resolve(many('--pkg')[0]), pub = path.join(pkg, 'public'), vault = path.join(pub, 'vault');
let input = ''; for await (const b of process.stdin) input += b; let { password } = JSON.parse(input); input = '';
const cfg = JSON.parse(fs.readFileSync(path.join(pub, 'vault-config.json')));
const key = pbkdf2Sync(password, Buffer.from(cfg.salt, 'base64'), cfg.iterations, 32, 'sha256'); password = '';
const sha = b => createHash('sha256').update(b).digest('hex');
const enc = (b, aad) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad)); return Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]); };
const dec = (b, aad) => { const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]); };
const manifest = JSON.parse(dec(fs.readFileSync(path.join(vault, 'manifest.bin')), 'manifest:v1'));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const jobs = [];   // [库里的路径, 本地文件, 是替换吗]
for (const spec of many('--add-dir')) { const [dir, prefix] = spec.split('=');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!e.name.startsWith('.')) jobs.push([prefix.replace(/\/$/, '') + '/' + path.relative(dir, f).split(path.sep).join('/'), f, false]); });
  walk(dir); }
for (const spec of many('--put')) { const i = spec.lastIndexOf('='); jobs.push([spec.slice(0, i), spec.slice(i + 1), true]); }
for (const [k, , put] of jobs) { if (put && !manifest.files[k]) throw Error('目录里没有：' + k); if (!put && manifest.files[k]) throw Error('目录里已经有：' + k); if (!put && !MIME[path.extname(k).toLowerCase()]) throw Error('推断不出类型：' + k); }
const written = [], removed = [];
for (const [k, f, put] of jobs) {
  const raw = fs.readFileSync(f), packed = gzipSync(raw, { level: 6 }), gzip = packed.length < raw.length, data = gzip ? packed : raw;
  const id = randomBytes(16).toString('hex'), chunks = []; let off = 0;
  do { const n = chunks.length, name = `${id}-${n}.bin`; if (!DRY) fs.writeFileSync(path.join(vault, name), enc(data.subarray(off, off + 1048576), `${id}:${n}`)); chunks.push(name); off += 1048576; } while (off < data.length);
  written.push(...chunks); const old = manifest.files[k]; if (old) removed.push(...old.chunks);
  manifest.files[k] = old ? { ...old, id, chunks, gzip, size: raw.length, sha256: sha(raw) } : { id, chunks, gzip, type: MIME[path.extname(k).toLowerCase()], size: raw.length, sha256: sha(raw) };
}
if (!DRY) {
  fs.writeFileSync(path.join(vault, 'manifest.bin'), enc(Buffer.from(JSON.stringify(manifest)), 'manifest:v1'));
  const still = new Set(Object.values(manifest.files).flatMap(i => i.chunks)); for (const f of removed) if (!still.has(f)) fs.rmSync(path.join(vault, f));
  const clp = path.join(pkg, '发布文件校验.json'), cl = JSON.parse(fs.readFileSync(clp));
  for (const f of removed) delete cl['vault/' + f];
  for (const f of [...written, 'manifest.bin']) cl['vault/' + f] = sha(fs.readFileSync(path.join(vault, f)));
  fs.writeFileSync(clp, JSON.stringify(cl, null, 1));
  for (const [k, f] of jobs) { const it = manifest.files[k]; let b = Buffer.concat(it.chunks.map((c, n) => dec(fs.readFileSync(path.join(vault, c)), `${it.id}:${n}`))); if (it.gzip) b = gunzipSync(b); if (sha(b) !== sha(fs.readFileSync(f))) throw Error('往返校验失败：' + k); }
}
console.log(`${DRY ? '[空跑] ' : ''}新增 ${jobs.filter(j => !j[2]).length} 个、替换 ${jobs.filter(j => j[2]).length} 个文件；新分块 ${written.length} 个，删掉 ${removed.length} 个${DRY ? '' : '；逐个解开核对通过'}`);
