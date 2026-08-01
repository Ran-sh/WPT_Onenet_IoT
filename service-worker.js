/* WPT Monitor V5.1.3 Service Worker：页面网络优先，静态资源缓存优先。 */
var CACHE = 'wpt-v5-1-3-web-3';
var BASE = self.location.pathname.replace(/\/[^/]*$/, '');
var CORE_ASSETS = [
  BASE + '/', BASE + '/login.html', BASE + '/index.html', BASE + '/monitoring.html',
  BASE + '/control.html', BASE + '/history.html', BASE + '/alerts.html', BASE + '/settings.html',
  BASE + '/js/auth-guard.js', BASE + '/js/config.js', BASE + '/js/onenet.js', BASE + '/js/mobile-nav.js',
  BASE + '/css/dashboard-v5.css', BASE + '/manifest.json', BASE + '/icon.svg'
];
var CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

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
      return caches.match(BASE + '/login.html');
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
    event.respondWith(event.request.mode === 'navigate' ? networkFirst(event.request) : cacheFirst(event.request));
    return;
  }
  if (CDN_HOSTS.indexOf(url.hostname) >= 0) event.respondWith(cacheFirst(event.request));
});
