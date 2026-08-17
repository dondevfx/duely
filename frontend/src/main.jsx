import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Register service worker for PWA install prompt
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── A stale index.html is a blank page ──────────────────────────────────────
//
// Bundles are content-hashed. If a browser is holding an old index.html — from
// the service worker's offline shell, or a proxy, or a tab restored from days
// ago — it asks for JavaScript filenames that no longer exist on the server.
// Every one 404s, nothing boots, and the screen stays black. A refresh fixes it
// because the refresh fetches the current HTML.
//
// So do the refresh automatically, ONCE. The sessionStorage flag is what makes
// it safe: if the reload does not fix it, the cause is not a stale document and
// a second reload would only start a loop.
const RELOAD_FLAG = 'duely_chunk_reload';
function reloadOnceForStaleBuild(detail) {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;   // already tried
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch { return; }                                   // no storage, no auto-reload
  console.warn('[boot] stale build detected, reloading once:', detail);
  window.location.reload();
}
// Clear the flag once the app has actually booted, so a genuine stale build
// weeks from now still gets its one reload.
window.addEventListener('load', () => {
  setTimeout(() => { try { sessionStorage.removeItem(RELOAD_FLAG); } catch {} }, 5000);
});

// A module script that fails to load fires an error event on window with no
// message; a failed dynamic import rejects. Both mean the same thing here.
window.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'SCRIPT' && /\.js(\?|$)/.test(el.src || '')) {
    reloadOnceForStaleBuild(el.src);
  }
}, true);
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e.reason?.message || e.reason || '');
  if (/dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(msg)) {
    reloadOnceForStaleBuild(msg);
  }
});

// Apply saved theme before first render to avoid flash
if (localStorage.getItem('theme') === 'light') {
  document.documentElement.classList.add('light');
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
