// Squad Ledger Dashboard - service worker
//
// NETWORK-FIRST strategy: whenever the phone has a connection, always fetch
// the latest index.html from the server and show that immediately. The
// cache is only used as a fallback when there's no connection at all.
//
// (Earlier version used cache-first, which showed the OLD cached page
// instantly and only updated the cache quietly in the background — meaning
// every real fix took one or two extra app reopens before it actually
// appeared. This version fixes that: updates show up on the very next open.)
//
// Bump CACHE_NAME any time you want to force old cached copies to be purged.
const CACHE_NAME = 'squad-ledger-v2';
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // offline: fall back to whatever's cached
  );
});
