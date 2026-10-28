// Service worker : l'app reste utilisable hors ligne. Réseau d'abord pour tout ce qui est à nous
// (une mise à jour est vue tout de suite), cache en secours ; les polices et icônes externes sont gardées en cache.
const CACHE = 'fusain-shell';
const SHELL = ['./', 'index.html', 'labo.html', 'css/style.css', 'css/mobile.css', 'version.json', 'CHANGELOG.md', 'favicon.svg', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // jamais de cache pour l'API Supabase
  if (url.hostname.endsWith('.supabase.co')) return;
  const sameOrigin = url.origin === location.origin;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, sameOrigin ? { cache: 'no-store' } : undefined);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const shell = await cache.match('index.html') || await cache.match('./'); if (shell) return shell; }
      throw err;
    }
  })());
});
