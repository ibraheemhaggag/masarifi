const CACHE="masarifi-v5";
const CORE=["./","index.html","config.js","manifest.json","icon-192.png","icon-512.png","apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET") return;
  const same=u.origin===location.origin, cdn=/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname);
  if(!same&&!cdn) return; // never cache Supabase or other APIs
  if(same){ // network first so updates arrive, cache when offline
    e.respondWith(fetch(e.request).then(res=>{ const cp=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); return res; }).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))));
  } else {
    e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(res=>{ const cp=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)); return res; })));
  }
});
