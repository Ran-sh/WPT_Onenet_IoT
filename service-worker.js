const CACHE = 'wpt-v2';
const ASSETS = [
  '/', '/login.html', '/index.html', '/monitoring.html', '/control.html',
  '/history.html', '/alerts.html', '/settings.html',
  '/js/config.js', '/js/onenet.js', '/js/mobile-nav.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => {
      /* 离线时返回缓存的 index.html (避免白屏), 非导航请求返回空响应 */
      if (e.request.mode === 'navigate') {
        return caches.match('/index.html');
      }
      return new Response('', { status: 408 });
    }))
  );
});
