const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=__dirname, pub=path.join(root,'public');
const expected=JSON.parse(fs.readFileSync(path.join(root,'发布文件校验.json')));
const cfg=JSON.parse(fs.readFileSync(path.join(pub,'vault-config.json')));
if(cfg.demo!==false||cfg.iterations!==600000||cfg.manifest!=='/vault/manifest.bin')throw Error('Unexpected encryption configuration');
const wrangler=fs.readFileSync(path.join(root,'wrangler.jsonc'),'utf8');
if(/"main"\s*:/.test(wrangler))throw Error('Worker script forbidden: this site must stay static-assets-only');
let count=0;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,e.name),rel=path.relative(pub,file).split(path.sep).join('/');
 if(e.isSymbolicLink())throw Error('Symlink forbidden');
 if(e.isDirectory()){if(rel!=='vault'&&rel!=='assets')throw Error('Unexpected directory: '+rel);walk(file);continue;}
 if(!['index.html','gate.css','sw.js','vault-config.json','_headers'].includes(rel)&&!/^vault\/(?:manifest|[a-f0-9]{32}-[0-9]+)\.bin$/.test(rel)&&!/^assets\/(?:app-[a-f0-9]{10}\.js|[a-z0-9-]+\.(?:jpg|png|bin))$/.test(rel))throw Error('Unexpected public file: '+rel);
 if(fs.statSync(file).size>25*1024*1024)throw Error('Over Cloudflare 25 MiB file limit: '+rel);
 const data=fs.readFileSync(file),hash=crypto.createHash('sha256').update(data).digest('hex');
 if(expected[rel]!==hash)throw Error('File changed since review: '+rel);count++;
}}
walk(pub);if(count!==Object.keys(expected).length)throw Error('Missing files');
if(count>20000)throw Error('Over Cloudflare free-plan 20,000 file limit');
console.log('Verified '+count+' approved encrypted files and unlock-page assets.');
