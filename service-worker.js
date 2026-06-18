/* Service Worker — 离线回退 + 版本管理 */
var CACHE = 'wpt-v3';
var ASSETS = [
  '/', '/login.html', '/index.html', '/monitoring.html', '/control.html',
  '/history.html', '/alerts.html', '/settings.html',
  '/js/config.js', '/js/onenet.js', '/js/mobile-nav.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
});

self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.match(e.request).then(function(r) { return r || fetch(e.request).catch(function() {
      if (e.request.mode === 'navigate') return caches.match('/index.html');
      return new Response('', { status: 408 });
    }); })
  );
});
