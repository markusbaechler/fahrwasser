// Fahrwasser Service Worker: App-Shell offline, Kartenteile im Laufzeit-Cache
const SHELL = 'fw-shell-v1';
const TILES = 'fw-tiles-v1';
const MAX_TILES = 4000;
const CACHEABLE_HOSTS = ['tiles.openwaters.io', 'tiles.versatiles.org', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', './index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, TILES];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

let putCount = 0;
async function trim() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  // Älteste Einträge zuerst entfernen (Cache-Reihenfolge = Einfügereihenfolge)
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App selbst: Netzwerk zuerst, offline aus dem Cache
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }

  // Karte, Schriften, Bibliothek: Cache sofort, im Hintergrund erneuern
  if (CACHEABLE_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      const net = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') {
          c.put(req, res.clone());
          if (++putCount % 100 === 0) trim();
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
  }
  // Wetter, Suche und AIS laufen immer live übers Netz
});
