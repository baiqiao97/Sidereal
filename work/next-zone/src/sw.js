// Sidereal 网页库的 Service Worker：用钥匙解开加密目录；/library/… 的请求现取密文分块，在浏览器里解密后返回。
'use strict';
let session=null;
const encoder=new TextEncoder();
let usageDB;
let usageStorageFailed=false;
const monthKey=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};
function openUsageDB(){
 if(!usageDB)usageDB=new Promise((resolve,reject)=>{
  const request=indexedDB.open('lunette-usage',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('months',{keyPath:'month'});
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();usageDB=null;};resolve(db);};
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(Error('Usage storage unavailable'));
 }).catch(error=>{usageDB=null;throw error;});
 return usageDB;
}
async function recordUsage(kind,bytes){
 try{
  const db=await openUsageDB();
  await new Promise((resolve,reject)=>{
   const tx=db.transaction('months','readwrite'),store=tx.objectStore('months'),month=monthKey();
   const request=store.get(month);
   request.onsuccess=()=>{const row=request.result||{month,download:0,cached:0,startedAt:new Date().toISOString()};row[kind]+=bytes;row.updatedAt=new Date().toISOString();store.put(row);};
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
 }catch{usageStorageFailed=true;}
}
async function readUsage(){
 try{
  const db=await openUsageDB();
  const row=await new Promise((resolve,reject)=>{const request=db.transaction('months','readonly').objectStore('months').get(monthKey());request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  return {ok:true,partial:usageStorageFailed,...(row||{month:monthKey(),download:0,cached:0,startedAt:null})};
 }catch{return {ok:false,error:'Usage unavailable'};}
}
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
const CACHE='encrypted-library-v2';
const bytes64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function decrypt(bytes,key,aad){return crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:encoder.encode(aad),tagLength:128},key,bytes.slice(12));}
async function manifestFetch(url){let cache,old;try{cache=await caches.open('vault-manifest-v1');old=await cache.match(url);}catch{}const h={},tag=old&&old.headers.get('etag');if(tag)h['If-None-Match']=tag;const r=await fetch(url,{cache:'no-store',headers:h});if(r.status===304&&old)return old.arrayBuffer();if(!r.ok)throw Error('Cannot read the encrypted catalog');const b=await r.arrayBuffer(),et=r.headers.get('etag');if(cache&&et){try{await cache.put(url,new Response(b,{headers:{etag:et}}));}catch{}}return b;}
async function unlock(password,rawKey){
 const cfg=await (await fetch('/vault-config.json',{cache:'no-store'})).json();
 const material=rawKey?null:await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
 const key=rawKey?await crypto.subtle.importKey('raw',bytes64(rawKey),'AES-GCM',false,['decrypt']):await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:bytes64(cfg.salt),iterations:cfg.iterations},material,{name:'AES-GCM',length:256},false,['decrypt']);
 const manifestBytes=await manifestFetch(cfg.manifest);
 await recordUsage('download',manifestBytes.byteLength);
 let mb=new Uint8Array(await decrypt(manifestBytes,key,'manifest:v1'));if(mb[0]===0x1f&&mb[1]===0x8b)mb=new Uint8Array(await new Response(new Blob([mb]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());const manifest=JSON.parse(new TextDecoder().decode(mb));for(const it of Object.values(manifest.files||{}))if(!it.chunks){it.id=it.i;it.type=it.t;it.gzip=!!it.g;it.chunks=Array.from({length:it.n},(_,k)=>it.i+'-'+k+'.bin');}
 if(manifest.version!==1||!manifest.files)throw Error('Catalog version mismatch');
 session={key,files:manifest.files,demo:cfg.demo};
 migrateCache(manifest.files).catch(()=>{});
}
// 旧缓存里可能留着改层之前、只用站点密码加密的分块：只搬走仍被主目录引用的，其余随旧缓存删除
async function migrateCache(files){
 if(!(await caches.has('encrypted-library-v1')))return;
 const keep=new Set(Object.values(files).flatMap(i=>i.chunks));
 const from=await caches.open('encrypted-library-v1'),to=await caches.open(CACHE);
 for(const req of await from.keys()){const name=new URL(req.url).pathname.replace(/^\/vault\//,'');if(keep.has(name)){const r=await from.match(req);if(r)await to.put(req,r);}}
 await caches.delete('encrypted-library-v1');
}
self.addEventListener('message',e=>{
 if(!e.source?.url||new URL(e.source.url).origin!==self.location.origin)return;
 e.waitUntil((async()=>{
  const reply=v=>e.ports[0]?.postMessage(v);
  try {
   if(e.data.type==='UNLOCK'){await unlock(e.data.password,e.data.key);reply({ok:true});}
   else if(e.data.type==='STATUS'){reply({ok:true,unlocked:!!session});}
   else if(e.data.type==='USAGE'){reply(await readUsage());}
   else if(e.data.type==='LOCK'){
    const testing=e.data.testOnly&&['127.0.0.1','localhost'].includes(self.location.hostname);
    session=null;reply({ok:true});
    if(!testing){for(const c of await self.clients.matchAll({type:'window'})){if(c.frameType==='top-level')await c.navigate('/');}}
   }
  }catch{reply({ok:false,error:'Wrong password, or the encrypted files could not be read.'});}
 })());
});
const safeHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
async function encryptedChunk(file){
 const url='/vault/'+file;
 let cache,savedBytes;try{cache=await caches.open(CACHE);const saved=await cache.match(url);if(saved)savedBytes=await saved.arrayBuffer();}catch{}
 if(savedBytes){await recordUsage('cached',savedBytes.byteLength);return savedBytes;}
 const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('Encrypted file unavailable');
 const bytes=await r.arrayBuffer();
 await recordUsage('download',bytes.byteLength);
 if(cache){try{await cache.put(url,new Response(bytes,{headers:r.headers}));}catch{}}
 return bytes;
}
async function resource(request,url){
 const active=session;
 if(!active){if(request.mode==='navigate')return Response.redirect(new URL('/?next='+encodeURIComponent(url.pathname),url.origin).href,302);return new Response('Locked',{status:401,headers:safeHeaders});}
 let p;try{p=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
 p=p.startsWith('/library/')?p.slice(9):p.replace(/^\//,'');
 if(!p||p.endsWith('/'))p+='index.html';
 const item=active.files[p],key=active.key;
 if(!item)return new Response('Not in this library.',{status:404,headers:safeHeaders});
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
 const headers={...safeHeaders,'Content-Type':item.type};
 if(request.method==='HEAD')return new Response(null,{headers});
 let index=0;const ahead=new Map();
 let stream=new ReadableStream({async pull(controller){try{
  const alive=()=>session===active;
  if(!alive())throw Error('Locked');
  if(index>=item.chunks.length){controller.close();return;}
  const n=index++;for(let k=n+1;k<Math.min(n+4,item.chunks.length);k++)if(!ahead.has(k)){const q=encryptedChunk(item.chunks[k]);q.catch(()=>{});ahead.set(k,q);}const cipher=await(ahead.get(n)||encryptedChunk(item.chunks[n]));ahead.delete(n);
  const plain=await decrypt(cipher,key,`${item.id}:${n}`);
  if(!alive())throw Error('Locked');
  controller.enqueue(new Uint8Array(plain));
 }catch(err){controller.error(err);}}});
 if(item.gzip)stream=stream.pipeThrough(new DecompressionStream('gzip'));
 return new Response(stream,{headers});
}
self.addEventListener('fetch',e=>{
 const url=new URL(e.request.url);if(url.origin!==self.location.origin)return;
 if(['/','/index.html','/gate.css','/gate.js','/sw.js','/vault-config.json','/selftest.js','/test-cases.json','/favicon.ico'].includes(url.pathname)||url.pathname.startsWith('/vault/')||url.pathname.startsWith('/assets/'))return;
 e.respondWith(resource(e.request,url));
});
