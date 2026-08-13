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
 * @param {boolean} active  true while counting down or playing
 */
export function useGameScrollLock(active) {
  useEffect(() => {
    if (!active) return;

    const main = document.querySelector('main');
    if (!main) return;

    const prevOverflow   = main.style.overflowY;
    const prevOverscroll = document.body.style.overscrollBehavior;

    // Start at the top: a match should open on the board, not wherever the
    // lobby was left. Unconditional — this half is always right.
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

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      main.style.overflowY = prevOverflow;
      document.body.style.overscrollBehavior = prevOverscroll;
    };
  }, [active]);
}
