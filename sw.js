var V='mit-werkbon-v111';
var FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','firebase-config.js','fb.js','rooster.js','handleiding.pdf'];
var CDN=['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(V).then(function(c){
 return c.addAll(FILES).then(function(){return Promise.all(CDN.map(function(u){return fetch(u,{mode:'no-cors'}).then(function(r){return c.put(u,r)}).catch(function(){})}))})}).then(function(){return self.skipWaiting()}))});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(n){return n!==V&&n!=='mit-share'}).map(function(n){return caches.delete(n)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener('fetch',function(e){
 var u=new URL(e.request.url);
 if(u.pathname.indexOf('/api/')>=0)return; // mail-koppeling: altijd live, nooit uit cache
 if(/googleapis\.com$|firebaseapp\.com$|firebaseio\.com$/.test(u.hostname))return; // inloggen en online back-up: altijd live
 if(u.hostname==='www.gstatic.com'||u.pathname.slice(-18)==='firebase-config.js'||u.pathname.slice(-6)==='/fb.js'){e.respondWith(fetch(e.request).then(function(res){var cp=res.clone();caches.open(V).then(function(c){c.put(e.request,cp)});return res}).catch(function(){return caches.match(e.request,{ignoreSearch:true})}));return}
 if(e.request.method==='POST'&&u.pathname.slice(-13)==='/share-target'){e.respondWith((async function(){try{var fd=await e.request.formData(),f=fd.get('file');if(f&&f.size!==undefined){var c=await caches.open('mit-share');await c.put('shared-file',new Response(f,{headers:{'Content-Type':f.type||'application/pdf','X-Name':encodeURIComponent(f.name||'bon.pdf')}}))}}catch(err){}return Response.redirect(new URL('index.html?import=1',self.registration.scope).href,303)})());return}
 if(e.request.method!=='GET')return;
 e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(function(r){return r||fetch(e.request).then(function(res){if(res&&(res.ok||res.type==='opaque')){var cp=res.clone();caches.open(V).then(function(c){c.put(e.request,cp)})}return res})}))});
