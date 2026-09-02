/**
 * The "more ways to play" toggle, shared by every betting screen.
 *
 * A bet screen opens on one question — how much — and the two ways to start a
 * real match. Everything else (a bot match, a solo run, joining someone's
 * code) is a thing almost nobody reaches for on arrival, and stacking it all
 * under the stake made the lobby the tallest screen in the app.
 *
 * Deliberately just an arrow, and deliberately narrow. A full-width button
 * with a label is another thing to read on a screen whose whole problem was
 * having too much on it — and naming what is hidden defeats the point of
 * hiding it. An arrow pointing down at a gap is understood without being read.
 *
 * Lives in its own file rather than in GameLobby, because Coin Flip and
 * Blackjack build their own lobbies and need the identical control. A second
 * copy is how the two drift apart.
 */

// One long arrow, rotated rather than swapped for a second drawing — the
// control is one thing in two states, and a glyph that changes shape reads as
// two different controls.
function LongArrow({ up }) {
  return (
    <svg
      width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"
      className="transition-transform duration-200"
      style={{ transform: up ? 'rotate(180deg)' : 'none' }}
    >
      {/* Shaft first, then the head — a long arrow rather than a bare chevron,
          which at this size reads as a direction instead of a decoration. */}
      <path d="M12 4.5v12.5" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" />
      <path d="M6.8 12.2 12 17.8l5.2-5.6" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MoreWaysToggle({ open, onToggle, className = '' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      // Named for a screen reader, since the face of it is only an arrow.
      aria-label={open ? 'Fewer ways to play' : 'More ways to play'}
      title={open ? 'Fewer ways to play' : 'More ways to play'}
      // A third of the width, centred. Wide enough to be an easy tap target on
      // a phone, narrow enough that it reads as a handle rather than as a
      // fourth button competing with the three above it.
      className={`w-1/3 mx-auto flex items-center justify-center py-2.5 rounded-xl
                  border border-border bg-surface text-white/70
                  hover:border-primary hover:text-white active:bg-surfaceLight
                  transition-all ${className}`}
    >
      <LongArrow up={open} />
    </button>
  );
}

export default MoreWaysToggle;
