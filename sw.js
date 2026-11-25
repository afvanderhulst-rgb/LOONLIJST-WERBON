var V='mit-werkbon-v224';
var FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','firebase-config.js','fb.js','rooster.js','libs.js','handleiding.pdf','lmra.png'];
var CDN=['lib/jspdf.umd.min.js','lib/pdf.min.js','lib/pdf.worker.min.js','lib/pdf-lib.min.js','lib/jszip.min.js','lib/firebase/firebase-app.js','lib/firebase/firebase-auth.js','lib/firebase/firebase-firestore.js']; // eigen adres; ontbrekende worden overgeslagen
self.addEventListener('install',function(e){e.waitUntil(caches.open(V).then(function(c){
 return c.addAll(FILES.map(function(f){return new Request(f,{cache:'reload'})})).then(function(){return Promise.all(CDN.map(function(u){return fetch(u).then(function(r){if(r.ok)return c.put(u,r)}).catch(function(){})}))})}).then(function(){return self.skipWaiting()}))});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(n){return n!==V&&n!=='mit-share'}).map(function(n){return caches.delete(n)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener('fetch',function(e){
 var u=new URL(e.request.url);
 if(u.pathname.indexOf('/api/')>=0)return; // mail-koppeling: altijd live, nooit uit cache
 if(/googleapis\.com$|firebaseapp\.com$|firebaseio\.com$|cloudfunctions\.net$|run\.app$/.test(u.hostname))return; // inloggen, online back-up en mailen: altijd live
 if(u.hostname==='www.gstatic.com'||u.pathname.slice(-18)==='firebase-config.js'||u.pathname.slice(-6)==='/fb.js'){e.respondWith(fetch(e.request).then(function(res){var cp=res.clone();caches.open(V).then(function(c){c.put(e.request,cp)});return res}).catch(function(){return caches.match(e.request,{ignoreSearch:true})}));return}
 if(e.request.method==='POST'&&u.pathname.slice(-13)==='/share-target'){e.respondWith((async function(){try{var fd=await e.request.formData(),L=fd.getAll('file').filter(function(f){return f&&f.size!==undefined}).slice(0,20),c=await caches.open('mit-share');
  // v216: ook foto's (meerdere tegelijk); de app vraagt bij welke bon ze horen
  for(var i=0;i<L.length;i++)await c.put('shared-file-'+i,new Response(L[i],{headers:{'Content-Type':L[i].type||'application/octet-stream','X-Name':encodeURIComponent(L[i].name||('bestand-'+(i+1)))}}));
  await c.put('shared-n',new Response(String(L.length)))}catch(err){}return Response.redirect(new URL('index.html?import=1',self.registration.scope).href,303)})());return}
 if(e.request.method!=='GET')return;
 // v214: beheer en kantoor altijd eerst live ophalen (anders bleef een oude beheerpagina staan); zonder internet de laatste versie
 if(/\/(beheer|kantoor)\.html$/.test(u.pathname)){e.respondWith(fetch(e.request,{cache:'no-store'}).then(function(res){if(res&&res.ok){var cp=res.clone();caches.open(V).then(function(c){c.put(e.request,cp)})}return res}).catch(function(){return caches.match(e.request,{ignoreSearch:true})}));return}
 e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(function(r){return r||fetch(e.request).then(function(res){if(res&&(res.ok||res.type==='opaque')){var cp=res.clone();caches.open(V).then(function(c){c.put(e.request,cp)})}return res})}))});

/* pushmeldingen (verstuurd door de Cloud Function) */
self.addEventListener('push',function(e){var d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data?e.data.text():''}}
 var blijf=!!d.ok||/^(klaar-|agenda-|rooster)/.test(d.tag||'');
 e.waitUntil(self.registration.showNotification(d.title||'MIT Werkbon',{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',tag:d.tag||undefined,renotify:!!d.tag,vibrate:blijf?[300,120,300,120,500]:[200,100,200],requireInteraction:blijf,actions:blijf?[{action:'ok',title:'OK'}]:[],data:{url:d.url||'./'}}))});
self.addEventListener('notificationclick',function(e){e.notification.close();if(e.action==='ok')return; // v203: OK = gezien, melding wegvar url=new URL((e.notification.data&&e.notification.data.url)||'./',self.registration.scope).href;
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){
  for(var i=0;i<l.length;i++){var c=l[i];if('focus' in c){c.postMessage({go:url});return c.focus()}}
  return self.clients.openWindow(url)}))});
