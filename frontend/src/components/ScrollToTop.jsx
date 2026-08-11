import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Reset the scroll position on navigation.
//
// A browser does this for free on a normal page load, but client-side routing
// only swaps the DOM — the window keeps whatever scroll it had. So scrolling
// halfway down Home and then opening Games landed you halfway down Games.
//
// Three deliberate exceptions:
//
//   POP    — back/forward. Returning to a page you had scrolled should land
//            where you left it, which is what every site does and what the
//            browser would have done itself.
//   #hash  — an anchor link is a request to go somewhere specific, so honour it
//            rather than overriding it with the top.
//   search — pathname only, so changing a query string does not jump. The
//            referral capture rewrites ?ref= off the URL on landing, and that
//            must not yank the page.
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;

    if (hash) {
      // The target may not be mounted on this tick; if it is missing, leave the
      // scroll alone rather than jumping to the top of a page it asked about.
      document.getElementById(hash.slice(1))?.scrollIntoView();
      return;
    }

    // The page does NOT scroll the window. <main> is absolutely positioned with
    // overflow-y-auto (see App.jsx), so it owns the scroll and window.scrollTo
    // would do nothing at all. Reset both: the element that actually scrolls,
    // and the window for any route that scrolls the document instead.
    //
    // 'instant', not 'smooth' — a page that visibly races to the top after a
    // navigation reads as a glitch rather than a transition.
    document.querySelector('main')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname, hash, navigationType]);

  return null;
}
