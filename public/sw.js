const CACHE_NAME = 'piano-p2p-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/app.js',
  './js/webrtc.js',
  'https://cdn.tailwindcss.com',
];

// Instalação e Cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
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

// Estratégia: Cache First para assets estáticos, sempre rede para WebSocket (não é interceptado de qualquer forma)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
