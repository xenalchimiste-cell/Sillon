// Service worker : app disponible hors ligne + cache des polices et pochettes.
const VERSION = 'sillon-v9';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/tags.js', 'js/player.js', 'js/deezer.js', 'js/spotify.js', 'js/cloud.js', 'js/config.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const RUNTIME = 'sillon-runtime-v2';
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn-images.dzcdn.net', 'i.scdn.co', 'e-cdns-images.dzcdn.net', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Fichiers de l'app : réseau d'abord (mises à jour), cache si hors ligne
  if (url.origin === self.location.origin) {
    if (request.headers.has('range')) return;
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    );
    return;
  }

  // Polices et pochettes : cache d'abord
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(request.url);
        if (hit) return hit;
        // Toujours en CORS : la réponse sert aussi bien aux <img> qu'à l'extraction de couleur
        const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
        if (res.ok) cache.put(request.url, res.clone());
        return res;
      }).catch(() => fetch(request)),
    );
  }
});
