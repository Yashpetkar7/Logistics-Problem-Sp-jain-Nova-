/* Nova Shuttle service worker — lets the pass install to the home screen
   and open offline, while always getting the freshest page when online.
   The pass code itself is fetched live (never cached) so a stale QR can't board. */
const SHELL = 'nova-shell-v5';
const ASSETS = ['/pass.html', '/style.css', '/icon.svg', '/vendor/qrcode.min.js', '/vendor/three.min.js', '/vendor/nova-bg.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  // API is always live — passcode, state, analytics must never be cached.
  if (url.pathname.startsWith('/api/')) return;

  const isPage = req.mode === 'navigate' || req.destination === 'document';
  if (isPage) {
    // network-first: fresh page when online, cached page when offline.
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/pass.html')))
    );
    return;
  }
  // static assets: cache-first, refresh in the background (stale-while-revalidate).
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
