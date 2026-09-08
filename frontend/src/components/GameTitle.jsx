/**
 * The game's name, set in its own game's materials.
 *
 * A card is a clip and a title now, so the title is doing more work than it
 * was. These are not custom letterforms — hand-drawn paths for eight names
 * would be a great deal of SVG and would read as amateur next to the real
 * artwork. They are the actual type, dressed in each game's own palette and
 * shapes, which is the part a player recognises.
 *
 * Every colour below is lifted from the game it belongs to rather than picked
 * to look nice here: Block Burst's ten block colours, Word VS's green and
 * amber tile states, Color Rush's three targets, Tower's pale blue, the coin's
 * golds. If a game is restyled, these are the values to change.
 *
 * SIZING. Everything is in em, so a treatment scales with whatever font-size
 * the card gives it — text-sm on a phone, text-xl on a desktop — and nothing
 * needs a breakpoint of its own. Words are separate flex items that wrap,
 * because "Block Burst" as eleven tiles is wider than a phone card: it breaks
 * to two lines instead of overflowing or being shrunk to nothing.
 *
 * ACCESSIBILITY. Split into per-letter spans, the name is announced letter by
 * letter, or with pauses where the tiles are. So the decorated version is
 * aria-hidden and the real name is carried once, on the wrapper.
 */

// ── Block Burst ────────────────────────────────────────────────────────────
// The ten colours the falling blocks actually use, in the order they run
// through the spectrum, so consecutive letters never repeat a colour.
const BLOCK_COLORS = [
  '#ff2244', '#ff8800', '#ffee00', '#aaff00', '#00ff66',
  '#00ffee', '#00aaff', '#7755ff', '#cc44ff', '#ff66cc',
];

// ── Word VS ────────────────────────────────────────────────────────────────
// The tile states from the game: correct, present, and not in the word.
const WORD_CORRECT = '#22c55e';
const WORD_PRESENT = '#f59e0b';
const WORD_ABSENT  = '#374151';
// Which letters of "WORDVS" land on which state. Chosen so the word reads as a
// real board mid-guess rather than a row of green.
const WORD_STATES = ['correct', 'absent', 'present', 'absent', 'correct', 'correct'];

// ── Color Rush ─────────────────────────────────────────────────────────────
// The three target colours the game asks you to hit.
const RUSH_COLORS = ['#FF4D4D', '#2FD46B', '#2E7BF6'];

const words = (title) => title.split(' ');

// A row of words that wraps as a whole rather than mid-word.
function Words({ children, className = '' }) {
  return <span className={`inline-flex flex-wrap items-center gap-x-[0.28em] gap-y-[0.15em] ${className}`}>{children}</span>;
}

export default function GameTitle({ slug, title, className = '' }) {
  const wrap = (inner) => (
    <span className={`inline-block ${className}`} aria-label={title} role="text">
      <span aria-hidden="true">{inner}</span>
    </span>
  );

  switch (slug) {
    // Letters stamped on the game's own blocks.
    case 'block-blast': {
      let i = 0;
      return wrap(
        <Words>
          {words(title).map((word, w) => (
            <span key={w} className="inline-flex gap-[0.09em]">
              {[...word].map((ch, c) => {
                const bg = BLOCK_COLORS[i++ % BLOCK_COLORS.length];
                return (
                  <span
                    key={c}
                    className="inline-flex items-center justify-center w-[0.92em] h-[0.92em] rounded-[0.16em]
                               font-black text-[0.62em] leading-none text-black/85"
                    style={{
                      background: bg,
                      // The blocks in game have a lit top edge and a shadowed
                      // base; without it these read as flat swatches.
                      boxShadow: `inset 0 0.09em 0 rgba(255,255,255,.45), inset 0 -0.09em 0 rgba(0,0,0,.3)`,
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
            <span key={w} className="inline-flex gap-[0.1em]">
              {[...word].map((ch, c) => {
                const state = WORD_STATES[i++ % WORD_STATES.length];
                const filled = state !== 'absent';
                const bg = state === 'correct' ? WORD_CORRECT
                         : state === 'present' ? WORD_PRESENT : 'transparent';
                return (
                  <span
                    key={c}
                    className="inline-flex items-center justify-center w-[0.92em] h-[0.92em] rounded-[0.1em]
                               font-black text-[0.62em] leading-none uppercase text-white"
                    style={{
                      background: bg,
                      border: filled ? 'none' : `0.1em solid ${WORD_ABSENT}`,
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

    // Leaning into the corner, with the road streaking past behind it.
    case 'car-dash':
      return wrap(
        <span className="relative inline-block">
          <span
            aria-hidden="true"
            className="absolute inset-y-[0.32em] -left-[0.35em] right-[60%] rounded-full opacity-70"
            style={{ background: 'linear-gradient(90deg, transparent, #1250B4)', height: '0.09em', top: '0.35em' }}
          />
          <span
            aria-hidden="true"
            className="absolute -left-[0.15em] right-[75%] rounded-full opacity-50"
            style={{ background: 'linear-gradient(90deg, transparent, #4DA3FF)', height: '0.07em', bottom: '0.3em' }}
          />
          <span className="font-black italic tracking-tight text-white" style={{ transform: 'skewX(-8deg)', display: 'inline-block' }}>
            {title}
          </span>
        </span>
      );

    // A stack that is not quite straight — the thing the game is about.
    case 'tower': {
      // Alternating offsets, biggest at the top of the stack, so it reads as
      // a tower drifting rather than as text set badly.
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

    // Struck metal.
    case 'coin-flip':
      return wrap(
        <span
          className="font-black tracking-tight"
          style={{
            backgroundImage: 'linear-gradient(180deg,#FFE08A 0%,#D4920E 45%,#C07800 55%,#FFD46B 100%)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            // A thin dark edge, or gold on a bright frame of the clip vanishes.
            filter: 'drop-shadow(0 0.03em 0.02em rgba(0,0,0,.9))',
          }}
        >
          {title}
        </span>
      );

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

    // The house style — this one IS the brand, so it stays the brand.
    case 'quick-match':
      return wrap(
        <span
          className="font-black tracking-tight"
          style={{ color: '#4DA3FF', textShadow: '0 0 0.5em rgba(18,80,180,.9)' }}
        >
          {title}
        </span>
      );

    default:
      return wrap(<span className="font-bold text-white">{title}</span>);
  }
}
