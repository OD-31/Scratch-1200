// Service worker : l'app est mise en cache par version, en une seule fois.
// Tant que tous les fichiers d'une version ne sont pas récupérés, l'ancienne version
// reste active : on ne peut donc jamais se retrouver avec un mélange des deux
// (c'est ce qui empêchait l'app de démarrer).
const VERSION = '3';
const CACHE = 'skratch-v' + VERSION;
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'dsp.js', 'render.js', 'storage.js',
  'turntable-worklet.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // ?v= contourne les caches intermédiaires (CDN) qui pourraient renvoyer l'ancien fichier
    await Promise.all(FILES.map(async (f) => {
      const res = await fetch(f + '?v=' + VERSION, { cache: 'reload' });
      if (!res.ok) throw new Error('Téléchargement impossible : ' + f);
      await cache.put(f === './' ? './' : f, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : new URL(req.url).pathname.replace(/^\//, '') || './';
    const hit = (await cache.match(key)) || (await cache.match(req));
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match('index.html');
      if (fallback && req.mode === 'navigate') return fallback;
      throw err;
    }
  })());
});

// Permet à la page de forcer la mise à jour
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
