/**
 * The game's name, set in that game's own materials.
 *
 * Used on the home and games cards, and as the heading on every bet screen.
 * Not custom letterforms — hand-drawn paths for eight names would be a great
 * deal of SVG and would read as amateur next to the real artwork. It is the
 * actual type, dressed in each game's palette and shapes, with a game object
 * standing in for a letter where one fits (the coin in Coin Flip).
 *
 * Every colour is lifted from the game it belongs to rather than picked to
 * look nice here. If a game is restyled, these are the values to change.
 *
 * SIZING. Everything is in em, so a treatment scales with whatever font-size
 * it is given — text-sm on a phone card, text-6xl on a bet screen — and needs
 * no breakpoint of its own. Words are separate flex items that wrap, because
 * "Block Burst" as eleven tiles is wider than a phone card: it breaks between
 * the words instead of overflowing.
 *
 * ACCESSIBILITY. Split into per-letter spans the name is announced letter by
 * letter, or with a pause at every tile, so the decorated version is
 * aria-hidden and the real name is carried once on the wrapper.
 */

// ── Block Burst ────────────────────────────────────────────────────────────
// The ten colours the falling blocks actually use, running through the
// spectrum so consecutive letters never repeat.
const BLOCK_COLORS = [
  '#ff2244', '#ff8800', '#ffee00', '#aaff00', '#00ff66',
  '#00ffee', '#00aaff', '#7755ff', '#cc44ff', '#ff66cc',
];

// ── Word VS ────────────────────────────────────────────────────────────────
const WORD_CORRECT = '#22c55e';
const WORD_PRESENT = '#f59e0b';
const WORD_ABSENT  = '#374151';
// A board mid-guess rather than a solved row of green.
const WORD_STATES = ['correct', 'absent', 'present', 'absent', 'correct', 'correct'];

// ── Color Rush ─────────────────────────────────────────────────────────────
const RUSH_COLORS = ['#FF4D4D', '#2FD46B', '#2E7BF6'];

// ── Coin Flip ──────────────────────────────────────────────────────────────
const GOLD_LIGHT = '#FFE08A';
const GOLD_MID   = '#D4920E';
const GOLD_DARK  = '#C07800';

// The bet screens pass a queue key, the cards pass a slug, and for two games
// those disagree. Normalised here so callers do not each need to know.
const SLUG_ALIASES = {
  carDash: 'car-dash', colorRush: 'color-rush', blockBlast: 'block-blast',
  coinFlip: 'coin-flip', quickMatch: 'quick-match', wordle: 'scrabble',
};

const words = (title) => title.split(' ');

// A row of words that wraps as a whole rather than mid-word.
function Words({ children, className = '' }) {
  return (
    <span className={`inline-flex flex-wrap items-center justify-center gap-x-[0.3em] gap-y-[0.16em] ${className}`}>
      {children}
    </span>
  );
}

export default function GameTitle({ slug, title, className = '' }) {
  const key = SLUG_ALIASES[slug] || slug;

  const wrap = (inner) => (
    <span className={`inline-block ${className}`} aria-label={title} role="text">
      <span aria-hidden="true">{inner}</span>
    </span>
  );

  switch (key) {
    // Letters stamped on the game's own blocks.
    case 'block-blast': {
      let i = 0;
      return wrap(
        <Words>
          {words(title).map((word, w) => (
            <span key={w} className="inline-flex gap-[0.08em]">
              {[...word].map((ch, c) => {
                const bg = BLOCK_COLORS[i++ % BLOCK_COLORS.length];
                return (
                  <span
                    key={c}
                    className="inline-flex items-center justify-center w-[1.1em] h-[1.1em] rounded-[0.2em]
                               font-black text-[0.74em] leading-none text-black/80"
                    style={{
                      // A lit face rather than a flat swatch: the blocks in
                      // game are shaded top-to-bottom, and the inset edges are
                      // what make these read as objects instead of squares.
                      background: `linear-gradient(160deg, ${bg} 0%, ${bg} 55%, rgba(0,0,0,.28) 100%), ${bg}`,
                      boxShadow: `inset 0 0.1em 0 rgba(255,255,255,.55),
                                  inset 0 -0.1em 0 rgba(0,0,0,.35),
                                  0 0.06em 0.14em rgba(0,0,0,.5)`,
                    }}
                  >
                    {ch}
                  </span>
                );
              })}
            </span>
          ))}
        </Words>
      );
    }

    // The guess board: outlined tiles, some filled in.
    case 'scrabble': {
      let i = 0;
      return wrap(
        <Words>
          {words(title).map((word, w) => (
            <span key={w} className="inline-flex gap-[0.09em]">
              {[...word].map((ch, c) => {
                const state = WORD_STATES[i++ % WORD_STATES.length];
                const filled = state !== 'absent';
                const bg = state === 'correct' ? WORD_CORRECT
                         : state === 'present' ? WORD_PRESENT : 'transparent';
                return (
                  <span
                    key={c}
                    className="inline-flex items-center justify-center w-[1.05em] h-[1.05em] rounded-[0.1em]
                               font-black text-[0.76em] leading-none uppercase text-white"
                    style={{
                      background: bg,
                      border: filled ? 'none' : `0.09em solid ${WORD_ABSENT}`,
                    }}
                  >
                    {ch}
                  </span>
                );
              })}
            </span>
          ))}
        </Words>
      );
    }

    // Each letter one of the three targets, cycling.
    case 'color-rush': {
      let i = 0;
      return wrap(
        <Words className="font-black tracking-tight">
          {words(title).map((word, w) => (
            <span key={w}>
              {[...word].map((ch, c) => {
                const col = RUSH_COLORS[i++ % RUSH_COLORS.length];
                return (
                  <span key={c} style={{ color: col, textShadow: `0 0 0.35em ${col}66` }}>{ch}</span>
                );
              })}
            </span>
          ))}
        </Words>
      );
    }

    // Motion, not a lean.
    //
    // The first version was italic text with two thin lines behind it, which
    // read as underlining rather than speed. This is the word printed three
    // times — two ghosts trailing behind at falling opacity, the solid one on
    // top — which is what motion blur actually looks like.
    case 'car-dash': {
      const ghosts = [
        { dx: '-0.5em', o: 0.16 },
        { dx: '-0.25em', o: 0.34 },
      ];
      return wrap(
        <span className="relative inline-block" style={{ transform: 'skewX(-10deg)' }}>
          {ghosts.map((g, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="absolute inset-0 font-black tracking-tighter whitespace-nowrap"
              style={{ transform: `translateX(${g.dx})`, color: '#4DA3FF', opacity: g.o }}
            >
              {title}
            </span>
          ))}
          <span className="relative font-black tracking-tighter text-white whitespace-nowrap">
            {title}
          </span>
        </span>
      );
    }

    // The coin is the letter.
    //
    // Gold gradient text on its own was muddy — at card size the dark half of
    // the gradient swallowed the letterforms. The metal now lives in one
    // object, an actual struck coin standing in for the O, and the type around
    // it stays plain and legible.
    case 'coin-flip': {
      const idx = title.toLowerCase().indexOf('o');
      const before = idx >= 0 ? title.slice(0, idx) : title;
      const after  = idx >= 0 ? title.slice(idx + 1) : '';
      return wrap(
        <span className="inline-flex items-baseline font-black tracking-tight text-white">
          {before}
          {idx >= 0 && (
            <span
              className="relative inline-block w-[0.82em] h-[0.82em] rounded-full mx-[0.03em]"
              style={{
                transform: 'translateY(0.04em)',
                background: `radial-gradient(circle at 35% 28%, ${GOLD_LIGHT} 0%, ${GOLD_MID} 55%, ${GOLD_DARK} 100%)`,
                boxShadow: `inset 0 0 0 0.09em ${GOLD_DARK}, 0 0.04em 0.12em rgba(0,0,0,.6)`,
              }}
            >
              {/* The sheen. A flat disc reads as a dot; this reads as metal. */}
              <span
                className="absolute rounded-full"
                style={{
                  left: '18%', top: '14%', width: '34%', height: '26%',
                  background: 'rgba(255,255,255,.75)', filter: 'blur(0.02em)',
                }}
              />
            </span>
          )}
          {after}
        </span>
      );
    }

    // The two colours on a card table.
    case 'blackjack': {
      const half = Math.ceil(title.length / 2);
      return wrap(
        <span className="font-black tracking-tight">
          <span className="text-white">{title.slice(0, half)}</span>
          <span style={{ color: '#dc2626' }}>{title.slice(half)}</span>
          <span aria-hidden="true" className="ml-[0.15em] text-[0.7em]" style={{ color: '#dc2626' }}>♦</span>
        </span>
      );
    }

    // A stack that is not quite straight.
    case 'tower': {
      const drift = ['-0.09em', '0.06em', '-0.05em', '0.08em', '-0.04em'];
      return wrap(
        <span className="inline-flex items-end font-black tracking-tight" style={{ color: '#9dc4ff' }}>
          {[...title].map((ch, c) => (
            <span key={c} style={{ transform: `translateY(${drift[c % drift.length]})`, display: 'inline-block' }}>
              {ch === ' ' ? ' ' : ch}
            </span>
          ))}
        </span>
      );
    }

    // Two players, matched.
    //
    // The first version was brand-blue text with a glow, which is what every
    // other heading on the site already looks like — it read as "no treatment
    // applied". This is the thing the mode does: two sides brought together,
    // with the bolt for how fast it happens.
    case 'quick-match':
      return wrap(
        // Wraps like the tiled ones do. nowrap held "Quick Match" on a single
        // line and ran it straight off the edge of a phone card.
        <span className="inline-flex flex-wrap items-center justify-center gap-x-[0.2em] font-black tracking-tight">
          <span className="inline-flex items-center gap-[0.14em]">
            <svg viewBox="0 0 24 24" className="w-[0.72em] h-[0.72em] shrink-0" aria-hidden="true"
                 style={{ filter: 'drop-shadow(0 0 0.2em rgba(255,209,71,.7))' }}>
              <path d="M13 2 L4 14h6l-1 8 9-12h-6z" fill="#FFD147" />
            </svg>
            <span className="text-white">{words(title)[0]}</span>
          </span>
          {words(title)[1] && (
            <span
              style={{
                // Two blues meeting, which is the match itself.
                backgroundImage: 'linear-gradient(90deg,#4DA3FF 0%,#1250B4 100%)',
                WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
              }}
            >
              {words(title).slice(1).join(' ')}
            </span>
          )}
        </span>
      );

    default:
      return wrap(<span className="font-bold text-white">{title}</span>);
  }
}
