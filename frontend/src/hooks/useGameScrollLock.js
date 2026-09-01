import { useEffect } from 'react';

/**
 * Pins the page while a match is counting down or in progress.
 *
 * Two problems, one cause. The countdown starts wherever the lobby happened to
 * be scrolled to, so a player who had scrolled down to read the rules began the
 * match looking at the middle of the board. And nothing stopped them scrolling
 * during play, so the board could be dragged half off-screen at the moment it
 * mattered most — on Block Burst a drag that started outside the grid scrolled
 * the page instead of moving a piece.
 *
 * Locks the scroll CONTAINER rather than the document, because <main> is the
 * scroller in this app (App.jsx: absolute inset with overflow-y-auto), not the
 * window. Setting overflow on body would do nothing here.
 *
 * Deliberately does NOT preventDefault on touchmove. That is the usual way to
 * pin a page on iOS and it would break every touch control we have — Block
 * Burst's drag and Rush Hour's steering both need those events. Removing the
 * overflow means there is nothing to scroll in the first place, which gets the
 * same result without taking input away from the game.
 *
 * @param {boolean} active  true while queued, counting down or playing
 * @param {*} pinOn  re-pins to the top whenever this value changes. Pass the
 *                   phase: arming the lock is not enough on its own, because
 *                   the lock stays armed ACROSS the queue -> countdown -> play
 *                   transitions, so its one-time pin fires at the start of the
 *                   queue and never again. A player who scrolled while waiting
 *                   then dropped into a board that was already scrolled — which
 *                   is the bug, and it is invisible from inside this hook.
 */
export function useGameScrollLock(active, pinOn) {
  // Back to the top on every phase change while the lock is on.
  //
  // Separate from the lock effect below so it can re-run without tearing the
  // lock down and putting it back, which would drop the overflow style for a
  // frame and let the page jump.
  useEffect(() => {
    if (!active) return undefined;
    const main = document.querySelector('main');
    if (!main) return undefined;
    // Same three-frame assertion as the lock: the previous screen is still
    // mounted on the frame the next one begins, and the browser restores the
    // old scroll position once the taller screen is swapped for the shorter.
    let frames = 3;
    let raf = 0;
    const toTop = () => {
      main.scrollTop = 0;
      if (--frames > 0) raf = requestAnimationFrame(toTop);
    };
    main.scrollTop = 0;
    raf = requestAnimationFrame(toTop);
    return () => cancelAnimationFrame(raf);
  }, [active, pinOn]);

  useEffect(() => {
    if (!active) return;

    const main = document.querySelector('main');
    if (!main) return;

    const prevOverflow   = main.style.overflowY;
    const prevOverscroll = document.body.style.overscrollBehavior;

    // Start at the top: a match should open on the board, not wherever the
    // lobby was left. Unconditional — this half is always right.
    //
    // Re-asserted over the next few frames rather than set once. The lobby is
    // still mounted on the frame the countdown begins, and the browser restores
    // the old scroll position after the taller lobby is swapped for the shorter
    // board — so a single assignment here is undone a frame later and the match
    // opens scrolled down anyway. Three frames covers the swap without ever
    // fighting the player, since nothing they do in the first 50ms of a
    // countdown can scroll.
    let frames = 3;
    const toTop = () => {
      main.scrollTop = 0;
      if (--frames > 0) raf = requestAnimationFrame(toTop);
    };
    let raf = requestAnimationFrame(toTop);
    main.scrollTop = 0;

    // Mobile browsers rubber-band the document past a locked child, which drags
    // the navbar out of view mid-match and springs back.
    document.body.style.overscrollBehavior = 'none';

    // Only take the scrollbar away when everything already fits.
    //
    // Hiding the overflow on a page taller than its container stops the user
    // reaching the rest of it — and the part that falls off the bottom of a
    // short phone is the action row: HIT/STAND, the keyboard, the tray. Locking
    // there would trade "can scroll the board away" for "cannot play at all",
    // which is much worse. Re-checked on resize because rotating a phone or
    // opening the keyboard changes the answer mid-match.
    const apply = () => {
      const fits = main.scrollHeight <= main.clientHeight + 1;
      const want = fits ? 'hidden' : prevOverflow;
      if (main.style.overflowY !== want) main.style.overflowY = want;
    };
    apply();

    const ro = new ResizeObserver(apply);
    ro.observe(main);
    if (main.firstElementChild) ro.observe(main.firstElementChild);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);

    // Give the styles back whenever the page is hidden, and take them again on
    // return.
    //
    // A phone can suspend or discard a backgrounded tab without ever running a
    // React cleanup, so a page put to sleep mid-match could come back with the
    // scroller still locked and nothing able to move — which reads as a frozen
    // or blank app that only a reload clears. Releasing on pagehide means the
    // worst case is an unlocked page, never a stuck one.
    const release = () => {
      main.style.overflowY = prevOverflow;
      document.body.style.overscrollBehavior = prevOverscroll;
    };
    const onHide = () => release();
    const onShow = () => {
      document.body.style.overscrollBehavior = 'none';
      apply();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    const onVis = () => {
      if (document.visibilityState === 'hidden') onHide(); else onShow();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVis);
      release();
    };
  }, [active]);
}
