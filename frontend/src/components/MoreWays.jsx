/**
 * The "more ways to play" toggle, shared by every betting screen.
 *
 * A bet screen opens on one question — how much — and the two ways to start a
 * real match. Everything else (a bot match, a solo run, joining someone's
 * code) is a thing almost nobody reaches for on arrival, and stacking it all
 * under the stake made the lobby the tallest screen in the app.
 *
 * Deliberately just an arrow. A full-width button
 * with a label is another thing to read on a screen whose whole problem was
 * having too much on it — and naming what is hidden defeats the point of
 * hiding it. An arrow pointing down at a gap is understood without being read.
 *
 * Lives in its own file rather than in GameLobby, because Coin Flip and
 * Blackjack build their own lobbies and need the identical control. A second
 * copy is how the two drift apart.
 */

// A small chevron, centred on a full-width bar.
//
// It used to be stretched across the whole button with
// preserveAspectRatio="none", which made it a line drawn on the card rather
// than an arrow sitting on it. The bar spans the card because it is a lid on
// the group below; the mark does not have to span anything.
//
// No shaft. At this height there is no room for one, and a chevron already
// says which way it goes.
function WideChevron({ up }) {
  return (
    <svg
      viewBox="0 0 24 10" aria-hidden="true"
      // A fixed, small glyph now, centred — not stretched.
      // preserveAspectRatio="none" made the chevron span the whole button,
      // which turned it into a line across the card rather than an arrow on
      // it. The bar still spans the card; the mark on it does not have to.
      className="w-6 h-2.5 transition-transform duration-200"
      // rotateX, not rotate. A flat rotate spins the chevron through the
      // horizontal — it passes edge-on and reads as sideways travel. rotateX
      // tips it over the top instead, which is the motion the control is
      // describing: the panel coming down, and going back up.
      style={{ transform: up ? 'rotateX(180deg)' : 'none' }}
    >
      <path
        d="M3 3 L12 8 L21 3" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
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
      className={`w-full flex items-center justify-center px-4 py-2 rounded-lg
                  border border-border bg-surface text-white/70
                  hover:border-primary hover:text-white active:bg-surfaceLight
                  transition-all ${className}`}
    >
      <WideChevron up={open} />
    </button>
  );
}

export default MoreWaysToggle;
