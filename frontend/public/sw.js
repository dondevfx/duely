// Duely Service Worker
//
// This existed to enable the PWA install prompt, and its fetch handler was
// turning ordinary network hiccups into blank pages.
//
// The old navigate handler was:
//
//   e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')))
//
// Nothing ever wrote to the cache — CACHE was declared and never used — so
// caches.match always resolved to undefined. respondWith(undefined) is a hard
// failure, so any transient failure of the document fetch (a cold-starting
// backend, a flaky phone network, a tab being restored) became a BLACK SCREEN
// instead of the browser's own retry. Refreshing "fixed" it because the second
// fetch usually succeeded. That is the reload-to-get-in bug.
//
// Two rules here now:
//   1. Never respondWith something that might not be a Response.
//   2. Only fall back to the cache when there is genuinely something in it.

const VERSION = 'v2';
const CACHE   = `duely-${VERSION}`;
const SHELL   = '/index.html';

self.addEventListener('install', (e) => {
  // Precache the shell so the offline fallback has something to serve. If it
  // fails, installation still succeeds — a missing fallback is survivable, a
  // service worker that refuses to install is not.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.add(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // Drop older versions, or a stale shell from a previous deploy can be served
  // forever — pointing at hashed bundles that no longer exist.
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never touch the API or the socket.
  if (url.pathname.startsWith('/api')) return;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // Everything except page navigations goes straight to the network. Bundles
  // are content-hashed, so caching them here buys nothing and risks serving a
  // build's HTML alongside another build's JavaScript.
  if (e.request.mode !== 'navigate') return;

  e.respondWith((async () => {
    // Network first: the live document is always the correct answer when it is
    // available, and it is what keeps a new deploy from being shadowed.
    try {
      const fresh = await fetch(e.request);
      if (fresh) {
        // Keep the shell current for the next offline load.
        if (fresh.ok) {
          const copy = fresh.clone();
          caches.open(CACHE).then(c => c.put(SHELL, copy)).catch(() => {});
        }
        return fresh;
      }
    } catch { /* offline or the request failed — try the cache below */ }

    const cached = await caches.match(SHELL);
    if (cached) return cached;

    // Nothing cached and no network. Returning undefined here is what caused
    // the black screen, so return a real Response the browser can render and
    // the user can act on.
    return new Response(
      `<!doctype html><meta charset="utf-8">
       <meta name="viewport" content="width=device-width,initial-scale=1">
       <title>Duely — offline</title>
       <body style="background:#000;color:#fff;font-family:system-ui,sans-serif;
                    display:flex;align-items:center;justify-content:center;
                    height:100vh;margin:0;text-align:center">
         <div>
           <h1 style="font-size:1.25rem;margin:0 0 .5rem">Can't reach Duely</h1>
           <p style="color:#9aa0a6;margin:0 0 1.25rem">Check your connection and try again.</p>
           <button onclick="location.reload()"
                   style="background:#1250B4;color:#fff;border:0;padding:.75rem 1.5rem;
                          border-radius:.75rem;font-weight:700;font-size:1rem">Retry</button>
         </div>
       </body>`,
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  })());
});
