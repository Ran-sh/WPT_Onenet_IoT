/* Service Worker — 离线回退 + 版本管理
 * 使用相对作用域, 兼容根路径和子路径部署 */
var CACHE = 'wpt-v4';
var BASE = self.location.pathname.replace(/\/[^/]*$/, '');
var ASSETS = [
  BASE + '/', BASE + '/login.html', BASE + '/index.html', BASE + '/monitoring.html',
  BASE + '/control.html', BASE + '/history.html', BASE + '/alerts.html', BASE + '/settings.html',
  BASE + '/js/config.js', BASE + '/js/onenet.js', BASE + '/js/mobile-nav.js'
];

self.addEventListener('install', function(e) {
  /* 单个可选页面缺失时不应让整个 Service Worker 安装失败。 */
  e.waitUntil(caches.open(CACHE).then(function(c) {
    return Promise.all(ASSETS.map(function(asset) {
      return c.add(asset).catch(function() { return null; });
    }));
  }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(function(r) { return r || fetch(e.request).catch(function() {
      if (e.request.mode === 'navigate') return caches.match(BASE + '/index.html');
      return new Response('', { status: 408 });
    }); })
  );
});
