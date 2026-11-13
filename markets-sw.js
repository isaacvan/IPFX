// IPFX Markets app helper (service worker).
// Scope is /trading.html only, so it never touches any other page of the site. It does one thing: if the phone is
// offline when Markets is opened from the home screen, it shows a clear offline page instead of a browser error.
// Markets itself is always loaded fresh from the network (never served from a cache), so a new release is picked up
// straight away, and no prices, account data or API calls are ever stored here.
const CACHE = 'ipfx-markets-offline-v1';
const OFFLINE = '/markets-offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/assets/images/app/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ipfx-markets-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return; // everything else goes straight to the network
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});
