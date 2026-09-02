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

// One wide chevron, stretched the full width of the button and rotated for
// the open state.
//
// preserveAspectRatio="none" is what does the stretching: the viewBox is a
// long flat box and the SVG is told not to letterbox it, so the stroke spans
// whatever width the button has instead of sitting as a small glyph in the
// middle. vectorEffect keeps the line the same weight while that happens —
// without it, stretching an 80-wide box to 340px would thicken the horizontal
// run and leave the ends hairline-thin.
//
// The shaft is gone. At this height there is no room for one, and a chevron
// spanning the whole control already says which way it goes — the shaft was
// carrying no information the shape did not.
function WideChevron({ up }) {
  return (
    <svg
      viewBox="0 0 80 10" preserveAspectRatio="none" aria-hidden="true"
      className="w-full h-2.5 transition-transform duration-200"
      style={{ transform: up ? 'rotate(180deg)' : 'none' }}
    >
      <path
        d="M2 2.5 L40 8 L78 2.5" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
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
      // Full width, and about a third of the height of a normal button. It
      // reads as a lid on the group below rather than as another button
      // competing with the two above it — which is what a full-height row
      // with a label did.
      className={`w-full flex items-center justify-center px-4 py-1 rounded-lg
                  border border-border bg-surface text-white/70
                  hover:border-primary hover:text-white active:bg-surfaceLight
                  transition-all ${className}`}
    >
      <WideChevron up={open} />
    </button>
  );
}

export default MoreWaysToggle;
