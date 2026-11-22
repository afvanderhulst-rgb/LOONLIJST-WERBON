// MIT Kantoor (mit-kantoor.web.app): kleine service worker, zodat de kantoor-app als eigen programma te installeren is.
// Alles komt altijd live van internet (kantoor werkt online); zonder internet: de laatst geladen pagina.
var V = 'mit-kantoor-v1';
self.addEventListener('install', function (e) { e.waitUntil(caches.open(V).then(function (c) { return c.add(new Request('./', {cache: 'reload'})); }).catch(function () {}).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (k) { return Promise.all(k.filter(function (n) { return n !== V; }).map(function (n) { return caches.delete(n); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).then(function (r) { var cp = r.clone(); caches.open(V).then(function (c) { c.put('./', cp); }); return r; }).catch(function () { return caches.match('./'); }));
});
