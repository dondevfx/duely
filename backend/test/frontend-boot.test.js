// Why the site sometimes needed a manual refresh to open.
//
// Three separate faults produced the same symptom — a black or frozen page that
// a reload fixed. These lock in the fixes. They are source scans because the
// frontend has no test runner; the behaviour itself was reproduced in a real
// browser, where the old service worker's fallback was confirmed to resolve to
// undefined and respondWith was confirmed to reject on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');

// ── 1. The service worker ──────────────────────────────────────────────────
//
// It was:
//   e.respondWith(fetch(req).catch(() => caches.match('/index.html')))
//
// Nothing ever wrote to the cache, so caches.match resolved to undefined, and
// respondWith(undefined) is a hard failure. Any transient failure of the
// document fetch — a cold-starting backend, a flaky phone network, a restored
// tab — became a black screen rather than the browser's own error handling.

test('the service worker never hands respondWith a value that may not exist', () => {
  const sw = read('public', 'sw.js');

  // A bare `caches.match(...)` as the tail of the catch is the exact bug.
  assert.ok(!/catch\s*\(\s*\)\s*=>\s*caches\.match/.test(sw),
    'falling back straight to caches.match resolves to undefined when the cache is empty, and respondWith rejects');

  // Whatever path is taken, a Response must be constructible.
  assert.match(sw, /new Response\(/,
    'there must be a real Response for the case where there is no network and nothing cached');
});

test('the cache the service worker reads from is actually written to', () => {
  const sw = read('public', 'sw.js');
  // The original declared CACHE and never opened it — the fallback could never
  // have worked even once.
  assert.match(sw, /caches\.open\(/, 'nothing ever populates the cache');
  assert.ok(/\.add\(|\.put\(/.test(sw), 'the shell is never stored, so the offline fallback is always empty');
});

test('old caches are cleaned up so a stale shell cannot outlive a deploy', () => {
  const sw = read('public', 'sw.js');
  assert.match(sw, /caches\.keys\(\)/, 'without a sweep, an old precached index.html is served forever');
  assert.match(sw, /caches\.delete\(/, 'old versions must be removed on activate');
});

test('page navigations go to the network first', () => {
  // Cache-first for navigation serves a build's HTML alongside another build's
  // hashed bundles, which is its own blank page.
  const sw = read('public', 'sw.js');
  const handler = sw.slice(sw.indexOf("addEventListener('fetch'"));
  const fetchAt = handler.indexOf('await fetch(');
  const cacheAt = handler.indexOf('await caches.match(');
  assert.ok(fetchAt !== -1 && cacheAt !== -1, 'both paths must exist');
  assert.ok(fetchAt < cacheAt, 'the live document must be preferred over the cached shell');
});

// ── 2. The error boundary ──────────────────────────────────────────────────
//
// React unmounts the ENTIRE tree on an uncaught render error. The boundary only
// wrapped <Routes>, so a throw in a provider, the navbar or a toast blanked the
// app to black with nothing to click.

test('the whole app is inside an error boundary, not just the routes', () => {
  const app = read('src', 'App.jsx');
  const root = app.slice(app.indexOf('export default function App'));
  const boundary = root.indexOf('<ErrorBoundary');
  const router   = root.indexOf('<BrowserRouter>');
  assert.notEqual(boundary, -1, 'a crash outside the routes blanks the app with no way back');
  assert.ok(boundary < router,
    'the boundary must be OUTSIDE BrowserRouter — the providers are the most likely thing to throw at startup');
});

test('the page-level boundary still exists', () => {
  // The outer one must not have replaced it: when only a page breaks, the shell
  // should survive so the player can navigate away.
  const app = read('src', 'App.jsx');
  assert.match(app, /<ErrorBoundary resetKey=/,
    'the inner boundary keeps the navbar alive when a single page throws');
});

test('a crash that reloading cannot fix has an escape hatch', () => {
  // A bad value in localStorage makes the app throw on every load forever, and
  // Reload just reproduces it.
  const eb = read('src', 'components', 'ErrorBoundary.jsx');
  assert.match(eb, /localStorage\.clear\(\)/,
    'there must be a way out of a crash caused by stored state');
  assert.match(eb, /allowReset/, 'and it must be opt-in, since it signs the user out');
});

// ── 3. The socket ──────────────────────────────────────────────────────────
//
// The context published `socket: socketRef.current`. Refs are assigned in the
// effect, after the first render, and assigning one re-renders nothing — so
// consumers read null until some other state happened to change. Anything that
// emits once on mount silently did nothing, and the page sat on "Connecting…".

test('the socket reaches consumers on the commit that creates it', () => {
  const src = read('src', 'context', 'SocketContext.jsx');
  const value = src.slice(src.indexOf('<SocketContext.Provider'));
  assert.ok(!/socket:\s*socketRef\.current/.test(value),
    'publishing the ref leaves every consumer holding null until an unrelated state change');
  assert.match(src, /setSocket\(socket\)/, 'the socket must be put in state so the provider re-renders with it');
});

// ── 4. A stale document ────────────────────────────────────────────────────

test('a stale build reloads once, and only once', () => {
  const main = read('src', 'main.jsx');
  assert.match(main, /dynamically imported module|Importing a module script failed/,
    'a failed chunk load is the signature of an index.html older than the deploy');
  assert.match(main, /sessionStorage/,
    'the reload must be guarded, or a failure it cannot fix becomes an infinite reload loop');
});
