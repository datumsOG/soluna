// Network-first service worker. Always tries the network so deploys take
// effect immediately; only falls back to cache when offline.

const CACHE = 'sun-stable-v123';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tiles, geocoding: pass through
  if (e.request.method !== 'GET') return;

  // Same-origin assets (the app shell + every ES module) are fetched with
  // cache:'reload' so the browser BYPASSES its HTTP cache and revalidates from the
  // network every time. This is what keeps the un-versioned module imports
  // (`./layers/shadow.js`, …) consistent: a deploy can never leave a client running
  // a fresh app.js against a stale module, which would link-fail and blank the app.
  // We still write each fresh response into the versioned cache for offline fallback.
  e.respondWith(
    fetch(new Request(url.href, { cache: 'reload', credentials: 'same-origin' })).then((r) => {
      if (r && r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return r;
    }).catch(() =>
      caches.match(e.request).then((m) => m || caches.match('./index.html'))
    )
  );
});
