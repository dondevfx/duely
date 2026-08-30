import { ICON_ALIGN } from './UiIcon';

/**
 * GameIcon — the little picture that stands for each game.
 *
 * These were emoji, scattered as literals through about a dozen lists: the
 * navbar, the sidebar, Quick Match, the invite toast, the join modal, the
 * challenge page, the leaderboard, the profile, the help panel and the games
 * grid. Emoji render differently on every platform — a 🃏 is a joker on one
 * phone and a pair of cards on another — and there is no way to make them look
 * like the game they point at.
 *
 * One component, one place. Everything that lists a game asks for its icon by
 * the game's key, so adding a seventh game means drawing one more icon here
 * rather than remembering a dozen call sites.
 *
 * Every icon is drawn on a 24x24 grid, sized by `size` and inheriting nothing
 * from the page — the colors are deliberate, because each one is meant to look
 * like the thing you actually see in that game.
 */

// Both spellings of every game are accepted. The codebase carries two names
// for the same game — a queue key ('block-blast') and a room id
// ('blockBlast') — and call sites hold whichever one they happen to have.
const ALIASES = {
  'block-blast': 'blockBlast',
  'car-dash':    'carDash',
  'color-rush':  'colorRush',
  'word-vs':     'scrabble',
  wordle:        'scrabble',
  coinflip:      'coin-flip',
  coinFlip:      'coin-flip',
  'quick-match': 'quickMatch',
  // The database writes game_type with underscores (profiles' per-game stats
  // read straight off it), so the same game arrives spelled three ways
  // depending on who is asking. Coin Flip's stat card on the profile drew
  // nothing at all because of exactly this.
  coin_flip:     'coin-flip',
  block_blast:   'blockBlast',
  car_dash:      'carDash',
  color_rush:    'colorRush',
  word_vs:       'scrabble',
};

// ── Block Burst: the blue L piece ───────────────────────────────────────────
function BlockBurst() {
  const cell = (x, y, k) => (
    <rect key={k} x={x} y={y} width="6.4" height="6.4" rx="1.4"
      fill="#2E7BF6" stroke="#7FB0FF" strokeWidth="0.9" />
  );
  return <g>{[cell(4.4, 3.2, 'a'), cell(4.4, 10, 'b'), cell(4.4, 16.8, 'c'), cell(11.2, 16.8, 'd')]}</g>;
}

// ── Coin Flip: the heads face, as it is drawn in the game ───────────────────
// The in-game coin is BLUE metal with a white H, not gold — the gold coin here
// was the C Coin, which is a different thing entirely and made the game look
// like it was about coins rather than the flip.
function CoinFlip() {
  const ticks = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    ticks.push(
      <line key={i}
        x1={12 + Math.cos(a) * 8.2} y1={12 + Math.sin(a) * 8.2}
        x2={12 + Math.cos(a) * 9.4} y2={12 + Math.sin(a) * 9.4}
        stroke="rgba(195,228,255,0.75)" strokeWidth="0.8" />
    );
  }
  return (
    <g>
      <defs>
        <radialGradient id="cf_face" cx="38%" cy="32%" r="72%">
          <stop offset="0%"  stopColor="#A0D8FF" />
          <stop offset="42%" stopColor="#1250B4" />
          <stop offset="100%" stopColor="#003088" />
        </radialGradient>
      </defs>
      <circle cx="12" cy="12" r="9.6" fill="url(#cf_face)" stroke="#0066DD" strokeWidth="1.4" />
      {ticks}
      <circle cx="12" cy="12" r="7" fill="none" stroke="rgba(160,216,255,0.55)" strokeWidth="0.8" />
      <text x="12" y="16.2" fontSize="10.5" fontWeight="900" textAnchor="middle"
        fontFamily="system-ui, sans-serif" fill="#FFFFFF">H</text>
    </g>
  );
}

// ── Blackjack: the ace ──────────────────────────────────────────────────────
function Blackjack() {
  return (
    <g>
      <rect x="4.6" y="2.6" width="14.8" height="18.8" rx="2.2"
        fill="#FFFFFF" stroke="#C9D2E3" strokeWidth="1" />
      <text x="7.4" y="9.1" fontSize="6" fontWeight="900"
        fontFamily="system-ui, sans-serif" fill="#111827">A</text>
      <path d="M12 10.6l3.5 4.4c0.9 1.2 0 2.8-1.5 2.8-0.8 0-1.4-0.4-1.6-1l-0.4 2.1h-0.1l-0.4-2.1c-0.2 0.6-0.8 1-1.6 1-1.5 0-2.4-1.6-1.5-2.8z"
        fill="#111827" />
    </g>
  );
}

// ── Rush Hour: the player's car, seen from above ────────────────────────────
function RushHour() {
  return (
    <g>
      {/* Narrower body with a cabin that reads as a car rather than a capsule:
          at 14px the windows were the only cue and they vanished. The wheels
          breaking the silhouette are what make it legible small. */}
      <rect x="4.2" y="8.6" width="2.6" height="3.4" rx="0.9" fill="#0B1A33" />
      <rect x="17.2" y="8.6" width="2.6" height="3.4" rx="0.9" fill="#0B1A33" />
      <rect x="4.2" y="14.4" width="2.6" height="3.4" rx="0.9" fill="#0B1A33" />
      <rect x="17.2" y="14.4" width="2.6" height="3.4" rx="0.9" fill="#0B1A33" />
      <rect x="6.4" y="2.6" width="11.2" height="18.8" rx="3.4"
        fill="#2E7BF6" stroke="#8FBBFF" strokeWidth="1.1" />
      {/* windscreen — one big dark shape, not two small ones */}
      <path d="M8.4 7.4h7.2l-0.9 3.4H9.3z" fill="#08111F" />
      <rect x="8.9" y="13.2" width="6.2" height="4.4" rx="1.2" fill="#08111F" opacity="0.75" />
      <rect x="7.3" y="3.3" width="2.4" height="1.6" rx="0.8" fill="#FFF3B0" />
      <rect x="14.3" y="3.3" width="2.4" height="1.6" rx="0.8" fill="#FFF3B0" />
    </g>
  );
}

// ── Color Rush: the ring obstacle with the diamond inside ───────────────────
function ColorRush() {
  // Same four colors as the game, a quarter each, in the same order.
  const quarter = (from, color, k) => {
    const r = 8.4, cx = 12, cy = 12;
    const a0 = (from - 90) * Math.PI / 180;
    const a1 = (from - 90 + 90) * Math.PI / 180;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    return <path key={k} d={`M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`}
      fill="none" stroke={color} strokeWidth="3" strokeLinecap="butt" />;
  };
  return (
    <g>
      {quarter(0,   '#FFFFFF', 'a')}
      {quarter(90,  '#2E7BF6', 'b')}
      {quarter(180, '#2FD46B', 'c')}
      {quarter(270, '#FF4D5E', 'd')}
      <path d="M12 8.3l2.1 3.7L12 15.7 9.9 12z" fill="#FFFFFF" />
    </g>
  );
}

// ── Tower: the stack, in the game's blue ────────────────────────────────────
function Tower() {
  const slab = (x, y, w, k, shade) => (
    <rect key={k} x={x} y={y} width={w} height="3.5" rx="0.9"
      fill={shade} stroke="#8FBBFF" strokeWidth="0.7" />
  );
  return (
    <g>
      {slab(4.6, 17.6, 14.8, 'a', '#1E5FD0')}
      {slab(6.0, 13.6, 12.0, 'b', '#2E7BF6')}
      {slab(7.6, 9.6,   8.8, 'c', '#4B90FF')}
      {slab(9.0, 5.6,   6.0, 'd', '#7FB0FF')}
    </g>
  );
}

// ── Word VS: a letter tile ──────────────────────────────────────────────────
function WordVs() {
  return (
    <g>
      <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3"
        fill="#141821" stroke="#2E7BF6" strokeWidth="1.4" />
      <text x="12" y="16.4" fontSize="10" fontWeight="900" textAnchor="middle"
        fontFamily="system-ui, sans-serif" fill="#FFFFFF">W</text>
    </g>
  );
}

// ── Quick Match: the bolt ───────────────────────────────────────────────────
function QuickMatch() {
  return <path d="M13.6 2.4L5.6 13.4h5.2l-1.4 8.2 8.2-11.4h-5.2z"
    fill="#FFD24A" stroke="#B8860B" strokeWidth="0.8" strokeLinejoin="round" />;
}

const ICONS = {
  blockBlast:  BlockBurst,
  'coin-flip': CoinFlip,
  blackjack:   Blackjack,
  carDash:     RushHour,
  colorRush:   ColorRush,
  tower:       Tower,
  scrabble:    WordVs,
  quickMatch:  QuickMatch,
};

export const hasGameIcon = (game) => !!ICONS[ALIASES[game] || game];

export default function GameIcon({ game, size = 24, className = '', title }) {
  const key = ALIASES[game] || game;
  const Art = ICONS[key];
  if (!Art) return null;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      <Art />
    </svg>
  );
}
