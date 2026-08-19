const CACHE="it-asset-v2";const CORE=["./","./index.html","./styles.css","./app.js","./manifest.webmanifest"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE))));
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{if(r.ok){let cp=r.clone();caches.open(CACHE).then(x=>x.put(e.request,cp))}return r}).catch(()=>caches.match("./index.html"))) )});
