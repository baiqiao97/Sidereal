// 增量更新加密库里的单个文件：不换盐、不换密钥，只替换这一个文件的分块和加密目录。
// 密码只从 stdin 读：echo '{"password":"…"}' | node vault-file.mjs <命令> …
//   list  --pkg <正式包> [--grep 关键词]            列出目录里的路径
//   get   --pkg <正式包> --key <路径> --out <文件>   解密取出一个文件
//   put   --pkg <正式包> --key <路径> --in <文件>    用新文件替换（旧分块删除、发布校验清单同步更新）
//   add   --pkg <正式包> --key <路径> --in <文件> [--type <MIME>]
//         新增一个不在目录里的文件，比如主题文件 AI 网页成品/_theme/…。
//         不登记成作品（网页库目录不变）；类型按扩展名推断，sw.js 会按这个类型返回。
import fs from 'node:fs'; import path from 'node:path';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
const [cmd,...rest]=process.argv.slice(2);const arg=n=>{const i=rest.indexOf(n);return i<0?null:rest[i+1];};
const pkg=path.resolve(arg('--pkg')),pub=path.join(pkg,'public'),vault=path.join(pub,'vault');
let input='';for await(const b of process.stdin)input+=b;let password=JSON.parse(input).password;input='';
const cfg=JSON.parse(fs.readFileSync(path.join(pub,'vault-config.json')));
const key=pbkdf2Sync(password,Buffer.from(cfg.salt,'base64'),cfg.iterations,32,'sha256');password='';
const enc=(b,aad)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));return Buffer.concat([iv,c.update(b),c.final(),c.getAuthTag()]);};
const dec=(b,aad)=>{const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(dec(fs.readFileSync(path.join(vault,'manifest.bin')),'manifest:v1'));
const read=k=>{const it=manifest.files[k];if(!it)throw Error('目录里没有：'+k);let d=Buffer.concat(it.chunks.map((f,n)=>dec(fs.readFileSync(path.join(vault,f)),`${it.id}:${n}`)));if(it.gzip)d=gunzipSync(d);if(sha(d)!==it.sha256)throw Error('哈希不符：'+k);return d;};
if(cmd==='list'){const g=arg('--grep');for(const [k,v] of Object.entries(manifest.files))if(!g||k.includes(g))console.log(v.size,k);process.exit(0);}
if(cmd==='get'){const d=read(arg('--key'));fs.writeFileSync(arg('--out'),d);console.log('取出',arg('--key'),d.length,'bytes');process.exit(0);}
const MIME={'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};
if(cmd==='put'||cmd==='add'){
 const k=arg('--key'),old=manifest.files[k];
 if(cmd==='put'&&!old)throw Error('目录里没有：'+k+'（新文件用 add）');
 if(cmd==='add'&&old)throw Error('目录里已经有：'+k+'（替换用 put）');
 const type=cmd==='add'?(arg('--type')||MIME[path.extname(k).toLowerCase()]):old.type;if(!type)throw Error('推断不出类型，请加 --type');
 const raw=fs.readFileSync(arg('--in')),packed=gzipSync(raw,{level:6}),gz=packed.length<raw.length,data=gz?packed:raw;
 const id=randomBytes(16).toString('hex'),chunks=[];let off=0;
 do{const n=chunks.length,b=enc(data.subarray(off,off+1048576),`${id}:${n}`),f=`${id}-${n}.bin`;fs.writeFileSync(path.join(vault,f),b);chunks.push(f);off+=1048576;}while(off<data.length);
 manifest.files[k]=old?{...old,id,chunks,gzip:gz,size:raw.length,sha256:sha(raw)}:{id,chunks,gzip:gz,type,size:raw.length,sha256:sha(raw)};
 if(sha(read(k))!==sha(raw))throw Error('往返校验失败');
 fs.writeFileSync(path.join(vault,'manifest.bin'),enc(Buffer.from(JSON.stringify(manifest)),'manifest:v1'));
 const still=new Set(Object.values(manifest.files).flatMap(i=>i.chunks));
 for(const f of old?old.chunks:[])if(!still.has(f))fs.rmSync(path.join(vault,f));
 const clp=path.join(pkg,'发布文件校验.json'),cl=JSON.parse(fs.readFileSync(clp));
 for(const f of old?old.chunks:[])delete cl['vault/'+f];
 for(const f of [...chunks,'manifest.bin'])cl['vault/'+f]=sha(fs.readFileSync(path.join(vault,f)));
 fs.writeFileSync(clp,JSON.stringify(cl,null,1));
 console.log(old?'已替换':'已新增',k,old?`${old.size} → ${raw.length} bytes`:`${raw.length} bytes · ${type}`,`分块 ${old?old.chunks.length+' → ':''}${chunks.length}`);
 process.exit(0);
}
throw Error('未知命令');
