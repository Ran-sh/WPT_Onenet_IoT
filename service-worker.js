/* WPT Monitor V6.0.0 Service Worker：同源资源网络优先，CDN资源缓存优先（外部仅保留 CDNJS 与 jsDelivr）。 */
var CACHE = 'wpt-v6-0-0-web-12';
var BASE = self.location.pathname.replace(/\/[^/]*$/, '');
var CORE_ASSETS = [
  BASE + '/', BASE + '/login.html', BASE + '/index.html', BASE + '/monitoring.html',
  BASE + '/control.html', BASE + '/history.html', BASE + '/alerts.html', BASE + '/settings.html',
  BASE + '/js/auth-guard.js', BASE + '/js/config.js', BASE + '/js/onenet.js', BASE + '/js/ui-common.js',
  BASE + '/js/control-core.js', BASE + '/js/control-page.js',
  BASE + '/js/index-page.js', BASE + '/js/monitoring-page.js', BASE + '/js/settings-page.js',
  BASE + '/js/history-core.js', BASE + '/js/history-page.js', BASE + '/js/mobile-nav.js',
  BASE + '/js/alert-engine.js', BASE + '/js/alerts-page.js',
  BASE + '/css/tailwind.css', BASE + '/css/dashboard.css', BASE + '/manifest.json', BASE + '/icon.svg'
];
var CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

function cacheResponse(request, response) {
  if (!response || !(response.ok || response.type === 'opaque')) return response;
  var copy = response.clone();
  caches.open(CACHE).then(function(cache) { return cache.put(request, copy); }).catch(function() {});
  return response;
}

function networkFirst(request) {
  return fetch(request).then(function(response) {
    return cacheResponse(request, response);
  }).catch(function() {
    return caches.match(request).then(function(cached) {
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return caches.match(BASE + '/login.html').then(function(login) {
          return login || Response.error();
        });
      }
      return Response.error();
    });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function(cached) {
    if (cached) return cached;
    return fetch(request).then(function(response) { return cacheResponse(request, response); });
  });
}

self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE).then(function(cache) {
    return Promise.all(CORE_ASSETS.map(function(asset) {
      return cache.add(asset).catch(function() { return null; });
    }));
  }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener('activate', function(event) {
  event.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(key) { return key !== CACHE; }).map(function(key) { return caches.delete(key); }));
  }).then(function() { return self.clients.claim(); }));
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    /* 同源所有 GET 一律网络优先，避免新 HTML 搭配旧 JS/CSS 的混版窗口。 */
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (CDN_HOSTS.indexOf(url.hostname) >= 0) event.respondWith(cacheFirst(event.request));
});
