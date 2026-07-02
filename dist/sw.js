// Obsidian Reader service worker — offline *app shell* only.
//
// Deliberately conservative: dynamic content (/vault, /api, /data, /tts-cache)
// is per-user, authenticated and live-updated via SSE, so it is ALWAYS fetched
// from the network and never cached. Only the static shell (HTML + vendor JS +
// icons) is cached, using stale-while-revalidate so a new deploy is picked up
// on the next load without ever serving a hard-stale page.
const CACHE = 'or-shell-v16';
const SHELL = [
  '/', '/index.html',
  '/manifest.webmanifest',
  '/icon.svg', '/icon-180.png', '/icon-192.png', '/apple-touch-icon.png',
  '/vendor/marked.min.js', '/vendor/purify.min.js', '/vendor/html2canvas.min.js',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // Best-effort precache: a single 404 must not abort the whole install.
  // cache:'reload' bypasses the HTTP cache — a plain add() reads through it,
  // which could bake a stale (max-age'd) index.html into a brand-new cache
  // version right after a deploy.
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;              // never intercept writes
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;    // leave cross-origin alone
  // Dynamic / authenticated / live paths → straight to network, no caching.
  if (url.pathname.startsWith('/vault/') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/data/') ||
      url.pathname.startsWith('/tts-cache/')) {
    return;
  }
  // App shell → stale-while-revalidate.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    // cache:'no-cache' forces revalidation against the server (cheap 304 via
    // ETag) instead of trusting the HTTP cache, so the SWR refresh actually
    // picks up new deploys instead of recycling a max-age'd copy for an hour.
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
