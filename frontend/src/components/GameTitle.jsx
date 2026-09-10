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

import CoinFaceIcon from './CoinFaceIcon';

// ── Block Burst ────────────────────────────────────────────────────────────
// The ten colours the falling blocks actually use, running through the
// spectrum so consecutive letters never repeat.
// The site's blues rather than the game's neon rainbow. The rainbow was the
// palette the blocks fall in, but ten saturated hues next to each other read
// as a toy next to the rest of the interface, which is built out of two blues
// and a cyan. Ordered light-to-dark and back so adjacent tiles always differ.
const BLOCK_COLORS = [
  '#00BFFF',  // accent
  '#4DA3FF',
  '#1250B4',  // primary
  '#8AB8F0',
  '#0066DD',
  '#A0D8FF',
  '#003088',
];

// ── Word VS ────────────────────────────────────────────────────────────────
const WORD_CORRECT = '#22c55e';
const WORD_PRESENT = '#f59e0b';
const WORD_ABSENT  = '#374151';
// A board mid-guess rather than a solved row of green.
const WORD_STATES = ['correct', 'absent', 'present', 'absent', 'correct', 'correct'];

// ── Color Rush ─────────────────────────────────────────────────────────────
const RUSH_COLORS = ['#FF4D4D', '#2FD46B', '#2E7BF6'];

// The bet screens pass a queue key, the cards pass a slug, and for two games
// those disagree. Normalised here so callers do not each need to know.
const SLUG_ALIASES = {
  carDash: 'car-dash', colorRush: 'color-rush', blockBlast: 'block-blast',
  coinFlip: 'coin-flip', quickMatch: 'quick-match', wordle: 'scrabble',
};

const words = (title) => title.split(' ');

// Words stack, second under first.
//
// Not wrapping — stacking. A card is square and a title is two short words, so
// side by side it runs edge to edge and has to be set small to fit; stacked, it
// can be half again as large in the same space. One word is unaffected.
function Words({ children, className = '' }) {
  return (
    <span className={`inline-flex flex-col items-center justify-center leading-[1.05] ${className}`}>
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
      // One row per word, each with its own trail — a single trail behind a
      // stacked pair would streak past the wrong word.
      const Row = ({ word }) => (
        <span className="relative inline-block whitespace-nowrap">
          {ghosts.map((g, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="absolute inset-0 font-black tracking-tighter"
              style={{ transform: `translateX(${g.dx})`, color: '#4DA3FF', opacity: g.o }}
            >
              {word}
            </span>
          ))}
          <span className="relative font-black tracking-tighter text-white">{word}</span>
        </span>
      );
      return wrap(
        <span style={{ transform: 'skewX(-10deg)', display: 'inline-block' }}>
          <Words>
            {words(title).map((w, i) => <Row key={i} word={w} />)}
          </Words>
        </span>
      );
    }

    // The coin is the letter.
    //
    // The game's actual coin — the same CoinFaceIcon the bet screen and the
    // result card use, so the thing in the title is the thing that gets
    // flipped. It sits at the x-height rather than the cap height and is sized
    // to a lowercase letter, so it reads as the "o" in Coin rather than as an
    // icon parked in the middle of a word.
    case 'coin-flip': {
      const idx = title.toLowerCase().indexOf('o');
      const before = idx >= 0 ? title.slice(0, idx) : title;
      const rest   = idx >= 0 ? title.slice(idx + 1) : '';
      const [restFirst, ...restWords] = rest.split(' ');
      const Coin = (
        <span className="inline-block align-baseline mx-[0.02em]" style={{ transform: 'translateY(0.02em)' }}>
          <CoinFaceIcon side="heads" size="0.66em" />
        </span>
      );
      return wrap(
        <Words className="font-black tracking-tight text-white">
          <span className="whitespace-nowrap">{before}{idx >= 0 && Coin}{restFirst}</span>
          {restWords.length > 0 && <span className="whitespace-nowrap">{restWords.join(' ')}</span>}
        </Words>
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

    // The name, cut from the site's own blue.
    //
    // It had a little podium beside it, which at card size read as an emoji
    // stuck to the front of the word rather than as part of the title — three
    // coloured bars next to eight letters. The name carries it alone.
    //
    // The first version of that name was solid gold, which is the obvious
    // answer for a prize and the wrong one here: this interface is built out
    // of two blues and a cyan, and a block of gold in the middle of it reads
    // as borrowed from another product. The second kept a gold band across the
    // middle, which was the same problem in a thinner line — the only warm
    // thing on a cool page draws the eye straight to it.
    //
    // So it is white falling into #1250B4, the primary everything else here is
    // built from. It reads as a heading belonging to this site that happens to
    // be lit from above, rather than as a trophy plate stuck onto it.
    //
    // The dark edge is not decoration. On a bright frame of a game clip the
    // pale end of the plate has almost no contrast, and the card's scrim only
    // darkens the bottom of the image; without the shadow the word disappears
    // on the paler clips.
    case 'tournament':
      return wrap(
        <span className="inline-block font-black tracking-tight">
          <span
            style={{
              // White into the site's own blue, and nothing else in it.
              //
              // #1250B4 is the primary this interface is built on, so the word
              // is made of the same material as everything around it rather
              // than of a colour borrowed to mean "prize". The gold band that
              // used to cross it is gone: one warm stripe was the only warm
              // thing on the page, and it read as a different product's logo.
              //
              // Four stops, not eight. The same word is set at 56px on the bet
              // screen and 22px on a home card, and a gradient with a stop
              // every few percent turns to mush once a letter is eight pixels
              // tall.
              backgroundImage:
                'linear-gradient(180deg,#FFFFFF 0%,#BBD4F5 38%,#1250B4 72%,#5E9BEE 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              filter: 'drop-shadow(0 0.035em 0.03em rgba(0,0,0,.95))',
            }}
          >
            {title}
          </span>
        </span>
      );

    // Two players, matched.
    //
    // The first version was brand-blue text with a glow, which is what every
    // other heading on the site already looks like — it read as "no treatment
    // applied". This is the thing the mode does: two sides brought together,
    // with the bolt for how fast it happens.
    case 'quick-match':
      return wrap(
        <Words className="font-black tracking-tight">
          {/* No bolt. It was the only treatment carrying a glyph, which made
              this card the odd one out on a screen of eight — and on the clip
              it read as a stray icon rather than as part of the name. */}
          <span className="text-white whitespace-nowrap">{words(title)[0]}</span>
          {words(title)[1] && (
            <span
              className="whitespace-nowrap"
              style={{
                // Two blues meeting, which is the match itself.
                backgroundImage: 'linear-gradient(90deg,#4DA3FF 0%,#1250B4 100%)',
                WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
              }}
            >
              {words(title).slice(1).join(' ')}
            </span>
          )}
        </Words>
      );

    default:
      return wrap(<span className="font-bold text-white">{title}</span>);
  }
}
