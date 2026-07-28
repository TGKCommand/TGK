/* ============================================================
   TGK Command Center - service worker
   Strategy:
     - Same-origin app shell (index.html, manifest, icons): NETWORK-FIRST,
       so a new deploy is picked up immediately; falls back to cache offline.
     - Supabase / APIs / any cross-origin or non-GET request: NOT intercepted
       -> goes straight to the network, never cached (no stale data).
   Deploy step: change CACHE_NAME on every release (e.g. v2 -> v3) so installed
   PWA clients drop the old cache and pull the new files.
   ============================================================ */
const CACHE_NAME = 'tgk-command-v2';          // <-- BUMP THIS ON EVERY DEPLOY
const SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (c) {
      return c.addAll(SHELL).catch(function () { /* ok if some shell items 404 */ });
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Never touch non-GET or cross-origin (Supabase, Shopify, etc.) -> default network, no caching.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first for our own files; cache a copy; fall back to cache (then index.html) when offline.
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE_NAME).then(function (c) { c.put(req, copy).catch(function () {}); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
    })
  );
});
