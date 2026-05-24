const CACHE = 'wpt-v1';
const ASSETS = [
  '/login.html', '/index.html', '/monitoring.html', '/control.html',
  '/history.html', '/alerts.html', '/settings.html',
  '/js/config.js', '/js/onenet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
