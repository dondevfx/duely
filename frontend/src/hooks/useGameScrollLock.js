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

    // Three frames is about 50ms, and that is not enough on its own.
    //
    // A player can hold a drag through the whole countdown. The pin above fires
    // the moment play begins, their finger is still down, and the scroll
    // resumes immediately after — so the board opens scrolled anyway, with the
    // score line cut off behind the navbar. That is the reported bug, and it
    // survived the pin because the pin only covers an instant.
    //
    // So the scroller is watched for as long as the lock is on. Anything that
    // scrolls it goes straight back to the top.
    //
    // Bounded by how much there is to scroll, NOT by a timer. A game screen
    // overhangs its viewport by a sliver — a controls line, a help button — and
    // hiding a sliver is exactly what must not happen. A screen that overhangs
    // by more than that has a real row down there (HIT/STAND, the keyboard, the
    // tray) and the player has to be able to reach it, so those are left alone.
    // This is the same trade the overflow rule below makes, at a threshold that
    // admits the sliver.
    const snapBack = () => { if (main.scrollTop !== 0) main.scrollTop = 0; };
    main.addEventListener('scroll', snapBack, { passive: true });
    // A held drag reports no scroll event until it moves again, so the release
    // is its own signal — without this, holding still at the bottom and lifting
    // leaves the page exactly where the finger left it.
    window.addEventListener('touchend', snapBack, { passive: true });
    window.addEventListener('touchcancel', snapBack, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      main.removeEventListener('scroll', snapBack);
      window.removeEventListener('touchend', snapBack);
      window.removeEventListener('touchcancel', snapBack);
    };
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

    // The scrollbar goes, unconditionally.
    //
    // This used to be conditional on the content already fitting, and that
    // condition was the bug. Every one of these screens is built on min-h,
    // which is "at least the viewport" — so a controls line, a help button or
    // a few pixels of padding makes the page taller than the fold, the
    // condition reads false, and the screen stays scrollable for the whole
    // match. Queue, countdown and board alike.
    //
    // The trade this gives up: anything below the fold on a locked screen can
    // no longer be reached. That is the intended behaviour here — these three
    // screens are built to fit, and the overhang is decoration rather than
    // controls. If a screen ever does need more room than the viewport, the
    // answer is to give that screen's own content a scroll container, not to
    // hand the page back.
    const apply = () => {
      if (main.style.overflowY !== 'hidden') main.style.overflowY = 'hidden';
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
