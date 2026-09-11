import { lazy } from 'react';

/**
 * A page loaded when it is first needed rather than in the one big bundle.
 *
 * Everything used to ship in a single 1.3MB script, so the home page waited
 * for the code of every game, the wallet and the admin panel before it could
 * draw. Each page is now its own file.
 *
 * Two things keep that from being felt:
 *
 * Every page's file is fetched in the background once the first page has
 * loaded (prefetchPages), so moving between pages — and between tournament
 * rounds — is as immediate as it was.
 *
 * A deploy replaces the files. A tab opened before it asks for a file that is
 * no longer there, and the import fails. That reloads the page once, which
 * picks up the new files; a second failure in the same session is a real error
 * and is left to the error boundary.
 */
const loaders = [];

export function lazyPage(load) {
  const wrapped = () => load().catch((err) => {
    const KEY = 'chunkReloadAt';
    let last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* private mode */ }
    if (Date.now() - last > 60_000) {
      try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
      window.location.reload();
      return new Promise(() => {});   // the reload takes over
    }
    throw err;
  });
  loaders.push(wrapped);
  return lazy(wrapped);
}

let prefetched = false;
export function prefetchPages() {
  if (prefetched || typeof window === 'undefined') return;
  prefetched = true;
  const run = () => { for (const l of loaders) l().catch(() => {}); };
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  if (document.readyState === 'complete') idle(run);
  else window.addEventListener('load', () => idle(run), { once: true });
}
