/* L사 본사 근무일지 — 오프라인 · 설치용 서비스 워커 (빌드할 때 버전이 들어간다) */
const V='lcw-5.4.3-1431969';
const CORE=['/manifest.webmanifest','/icon-192.png','/icon-512.png'];   /* 게임 화면('/')은 여기서 따로 받지 않는다 — 처음 열 때 받은 것을 그대로 저장 (두 번 받던 문제) */
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(CORE.map(u=>fetch(u,{cache:'no-store'}).then(res=>{if(res.ok&&(u==='/'||!/text\/html/.test(res.headers.get('content-type')||'')))return c.put(u,res)}).catch(()=>{}))))).then(()=>self.skipWaiting&&0)});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(async ks=>{const cur=await caches.open(V);for(const k of ks){if(!k.startsWith('lcw-')||k===V)continue;const old=await caches.open(k);for(const q of await old.keys()){if(new URL(q.url).pathname.startsWith('/img/')||new URL(q.url).pathname.startsWith('/ab/')){const m=await old.match(q);if(m)await cur.put(q,m)}}await caches.delete(k)}}).then(()=>self.clients.claim()))});   /* 새 버전으로 바뀌어도 받아 둔 그림은 옮겨 담는다 */
self.addEventListener('message',e=>{if(e.data==='skip')self.skipWaiting()});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
 if(u.origin!==location.origin||u.pathname.startsWith('/api/')||/admin|stats/.test(u.pathname))return;
 /* 게임 화면: 인터넷이 되면 최신, 안 되면 저장해 둔 것 */
 if(r.mode==='navigate'||u.pathname==='/'){e.respondWith(fetch(r).then(res=>{
   if(res.ok){const cp=res.clone();e.waitUntil(caches.open(V).then(c=>c.put('/',cp)));return res}
   /* 서버가 멈췄을 때(5xx · 한도 초과로 일시정지 등): 저장해 둔 게임을 띄운다 → 기기 저장으로 계속 하고, 진행 코드를 백업할 수 있다 */
   if(res.status>=500||res.status===402)return caches.match('/').then(x=>x||res);return res})
  .catch(()=>caches.match('/').then(x=>x||caches.match(r))));return}
 /* 그 밖의 그림 · 아이콘: 저장해 둔 것을 먼저, 뒤에서 새로 받아 둔다 (파일이 없어 HTML이 오면 저장하지 않는다) */
 const okRes=res=>res.ok&&!/text\/html/.test(res.headers.get('content-type')||'');
 if(u.pathname.startsWith('/img/')||u.pathname.startsWith('/ab/')){e.respondWith(caches.open(V).then(c=>c.match(r).then(hit=>hit||fetch(r).then(res=>{if(okRes(res))c.put(r,res.clone());return res}))));return}   /* 그림: 한 번 받으면 다시 묻지 않는다 (/img는 이름에 해시, /ab는 ?v= 로 바꾼다) */
 e.respondWith(caches.open(V).then(c=>c.match(r).then(hit=>{const net=fetch(r).then(res=>{if(okRes(res))c.put(r,res.clone());return res}).catch(()=>hit);return hit||net})))});
