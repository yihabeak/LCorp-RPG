/* L사 본사 근무일지 — 오프라인 · 설치용 서비스 워커 (빌드할 때 버전이 들어간다) */
const V='lcw-5.4.1-3212521';
const CORE=['/','/manifest.webmanifest','/icon-192.png','/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(CORE.map(u=>fetch(u,{cache:'no-store'}).then(res=>{if(res.ok&&(u==='/'||!/text\/html/.test(res.headers.get('content-type')||'')))return c.put(u,res)}).catch(()=>{}))))).then(()=>self.skipWaiting&&0)});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('lcw-')&&k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('message',e=>{if(e.data==='skip')self.skipWaiting()});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
 if(u.origin!==location.origin||u.pathname.startsWith('/api/')||/admin|stats/.test(u.pathname))return;
 /* 게임 화면: 인터넷이 되면 최신, 안 되면 저장해 둔 것 */
 if(r.mode==='navigate'||u.pathname==='/'){e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(V).then(c=>c.put('/',cp));return res}).catch(()=>caches.match('/').then(x=>x||caches.match(r))));return}
 /* 그림 · 아이콘: 저장해 둔 것을 먼저, 뒤에서 새로 받아 둔다 (파일이 없어 HTML이 오면 저장하지 않는다) */
 const okRes=res=>res.ok&&!/text\/html/.test(res.headers.get('content-type')||'');
 e.respondWith(caches.open(V).then(c=>c.match(r).then(hit=>{const net=fetch(r).then(res=>{if(okRes(res))c.put(r,res.clone());return res}).catch(()=>hit);return hit||net})))});
