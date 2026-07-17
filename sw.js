/* TGK Command Center service worker.
 * Design goal: make the app installable + shell-cached for instant/offline launch,
 * WITHOUT ever serving stale data. All Supabase/Shopify/API traffic bypasses the
 * cache entirely and goes straight to the network.
 *
 * Bump CACHE_VERSION whenever you change the shell so clients pick up the update.
 */
const CACHE_VERSION = 'tgk-cc-v1';
const SHELL = [
  './index.html',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_VERSION; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only ever handle same-origin GET requests. Everything else — Supabase,
  // Shopify, ShipStation, Google Fonts, POST/PUT/etc. — passes straight through
  // untouched, so live data is never intercepted or cached.
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Same-origin static assets (icons, manifest): cache-first, then network.
  event.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        return resp;
      });
    })
  );
});
