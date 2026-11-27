// Cached files hash: ccbba787eb587ae9. Run python3 _qa/sw_version.py --update after changing a cached file.
const scope = self.registration.scope;
const shell = 'huntlink-offline-topo-v8:' + scope;
const viewer = new URL('offline.html', scope).href;
const files = ['offline.html', 'map-nav.css', 'offline.js', 'waypoints.js', 'public-land.js', 'offline-states.json', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  ...['layers.png','layers-2x.png','marker-icon.png','marker-icon-2x.png','marker-shadow.png'].map(name=>'vendor/leaflet/images/'+name),
  'vendor/firebase/firebase-app.js', 'vendor/firebase/firebase-auth.js', 'vendor/firebase/firebase-database.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'manifest.webmanifest'];
const urls = new Set(files.map(file => new URL(file, scope).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(shell);
    await cache.addAll([...urls].map(url => new Request(url, {cache: 'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('huntlink-offline-topo-') && key.endsWith(':' + scope) && key !== shell) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  if (urls.has(url.href)) {
    event.respondWith(caches.open(shell).then(async cache => (await cache.match(url.href)) || fetch(request)));
  } else if (request.mode === 'navigate' && [scope, new URL('index.html', scope).href].includes(url.href)) {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch { return Response.redirect(viewer); }
    })());
  }
});
