/**
 * How a drawn icon sits on a line of text.
 *
 * These all used `vertical-align: middle`, which is the obvious choice and is
 * wrong: it centres the box on the x-height midline, about 0.25em above the
 * baseline, while text reads as centred on its cap height, about 0.35em above
 * it. The icon therefore hangs roughly a tenth of an em low beside every
 * label — the top edges line up and the bottom edge drops past the text, which
 * is exactly what it looked like.
 *
 * Aligning to a fixed offset from the baseline instead puts an icon roughly as
 * tall as its text visually centred on it, and matches what DiamondIcon and
 * CoinIcon were already doing (those two never looked off). It is also inert
 * inside a flex row, where vertical-align does not apply and `items-center`
 * has already done the job — so this cannot nudge the icons that were fine.
 */
export const ICON_ALIGN = { verticalAlign: '-0.15em' };

/**
 * UiIcon — the menu icons.
 *
 * Home, Games, Rewards, Profile, Leaderboard, Wallet, Tip and Rakeback were
 * emoji (🏠 🎮 🎡 👤 🏆 💳 💸 …), which meant the navigation was drawn by the
 * operating system: a different weight, a different palette and a different
 * level of detail on every device, sitting next to text that is none of those
 * things.
 *
 * These are line icons on a common 24x24 grid with one stroke weight, drawn in
 * `currentColor` so they take the colour of the menu item — which is what lets
 * the active state actually work, since an emoji cannot change colour.
 */

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };

const ICONS = {
  home: () => (
    <g {...P}>
      <path d="M3.4 10.6 12 3.6l8.6 7" />
      <path d="M5.6 9.4v10.2h12.8V9.4" />
      <path d="M9.8 19.6v-5.4h4.4v5.4" />
    </g>
  ),
  games: () => (
    <g {...P}>
      <rect x="2.6" y="7.2" width="18.8" height="10.4" rx="4.2" />
      <path d="M7 10.6v3.4M5.3 12.3h3.4" />
      <circle cx="15.6" cy="11.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.9" cy="13.6" r="1" fill="currentColor" stroke="none" />
    </g>
  ),
  rewards: () => (
    <g {...P}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="2.1" />
      <path d="M12 3.4v6.5M12 14.1v6.5M3.4 12h6.5M14.1 12h6.5" />
    </g>
  ),
  profile: () => (
    <g {...P}>
      <circle cx="12" cy="8.4" r="3.8" />
      <path d="M4.8 20.2c0-3.8 3.2-6.4 7.2-6.4s7.2 2.6 7.2 6.4" />
    </g>
  ),
  leaderboard: () => (
    <g {...P}>
      <path d="M8.2 3.6h7.6v5.2a3.8 3.8 0 0 1-7.6 0z" />
      <path d="M8.2 5.2H5.1v1.4a3.1 3.1 0 0 0 3.1 3.1M15.8 5.2h3.1v1.4a3.1 3.1 0 0 1-3.1 3.1" />
      <path d="M12 12.6v3.6M8.8 20.4h6.4M10.4 16.2h3.2l.9 4.2h-5z" />
    </g>
  ),
  wallet: () => (
    <g {...P}>
      <rect x="3" y="6.2" width="18" height="12.4" rx="2.8" />
      <path d="M3 10.2h18" />
      <circle cx="16.8" cy="14.4" r="1.2" fill="currentColor" stroke="none" />
    </g>
  ),
  tip: () => (
    <g {...P}>
      <path d="M12 20.4V6.4" />
      <path d="M15.4 8.6c0-1.5-1.5-2.4-3.4-2.4s-3.4.9-3.4 2.4 1.5 2.2 3.4 2.6 3.4 1.1 3.4 2.6-1.5 2.4-3.4 2.4-3.4-.9-3.4-2.4" />
      <path d="M12 3.6v2.8M12 18v2.8" />
    </g>
  ),
  // A coin coming back round, which is what rakeback is. The old clock-and-
  // arrow read as "history" and said nothing about money returning.
  rakeback: () => (
    <g>
      <path d="M4.6 12a7.4 7.4 0 0 1 12.6-5.3" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19.4 12a7.4 7.4 0 0 1-12.6 5.3" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" />
      <path d="M17.6 3.4v3.6h-3.6" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.4 20.6V17h3.6" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3.1" fill="currentColor" opacity="0.9" />
    </g>
  ),
  settings: () => (
    <g {...P}>
      <circle cx="12" cy="12" r="2.9" />
      <path d="M19.1 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.3a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.5 1z" />
    </g>
  ),
  transactions: () => (
    <g {...P}>
      <rect x="4" y="3.2" width="16" height="17.6" rx="2.6" />
      <path d="M8 8.4h8M8 12h8M8 15.6h5" />
    </g>
  ),
  friends: () => (
    <g {...P}>
      <circle cx="9.2" cy="8.6" r="3.3" />
      <path d="M3.4 19.6c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4" />
      <path d="M16.2 5.7a3.3 3.3 0 0 1 0 6.3M17.4 14.6c2.1.6 3.4 2.4 3.4 5" />
    </g>
  ),
  affiliate: () => (
    <g {...P}>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.4.4l2.8-2.8a3.6 3.6 0 0 0-5.1-5.1l-1.6 1.6" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.4-.4l-2.8 2.8a3.6 3.6 0 0 0 5.1 5.1l1.6-1.6" />
    </g>
  ),
  share: () => (
    <g {...P}>
      <circle cx="17.6" cy="5.8" r="2.6" />
      <circle cx="6.4" cy="12" r="2.6" />
      <circle cx="17.6" cy="18.2" r="2.6" />
      <path d="M8.7 10.8l6.6-3.7M8.7 13.2l6.6 3.7" />
    </g>
  ),
};

export const hasUiIcon = (name) => !!ICONS[name];

/**
 * The coloured icons — the ones that are not menu furniture and should look
 * like the thing they name rather than take the text colour around them.
 */
export function RakebackTierIcon({ tier, size = 18, className = '' }) {
  const art = {
    // Instant: a bolt. Daily: a sun. Weekly: a calendar. Colour separates them
    // at a glance in a row where all three sit together and the only other
    // difference is a word.
    instant: (
      <path d="M13.6 2.6L5.8 13.2h4.9l-1.3 8 7.8-11h-4.9z"
        fill="#FFD24A" stroke="#B8860B" strokeWidth="0.9" strokeLinejoin="round" />
    ),
    daily: (
      <g>
        <circle cx="12" cy="12" r="4.4" fill="#FF9F43" stroke="#C2670A" strokeWidth="0.9" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => {
          const a = (d * Math.PI) / 180;
          return <line key={d}
            x1={12 + Math.cos(a) * 6.6} y1={12 + Math.sin(a) * 6.6}
            x2={12 + Math.cos(a) * 9.2} y2={12 + Math.sin(a) * 9.2}
            stroke="#FFC061" strokeWidth="1.7" strokeLinecap="round" />;
        })}
      </g>
    ),
    weekly: (
      <g>
        <rect x="3.4" y="5" width="17.2" height="15.6" rx="2.6"
          fill="#1B2740" stroke="#5B8DEF" strokeWidth="1.5" />
        <path d="M3.4 9.6h17.2" stroke="#5B8DEF" strokeWidth="1.5" />
        <path d="M8 3.4v3.4M16 3.4v3.4" stroke="#5B8DEF" strokeWidth="1.8" strokeLinecap="round" />
        <rect x="6.6" y="12.2" width="3.2" height="3" rx="0.8" fill="#8AB4FF" />
        <rect x="11.6" y="12.2" width="3.2" height="3" rx="0.8" fill="#8AB4FF" opacity="0.65" />
        <rect x="6.6" y="16.4" width="3.2" height="2.4" rx="0.8" fill="#8AB4FF" opacity="0.4" />
      </g>
    ),
  }[tier];
  if (!art) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}>{art}</svg>
  );
}

// ELO and Score, for the leaderboard tabs. Streaks keep their flame — it is
// already the right thing and reads as heat in a way a drawing would not.
export function StatIcon({ kind, size = 18, className = '' }) {
  const art = {
    // ELO: crossed swords, the thing the rating comes from.
    elo: (
      <g>
        <path d="M4.4 4.2l10 10.4M19.6 4.2l-10 10.4" stroke="#8FBBFF" strokeWidth="2.1"
          strokeLinecap="round" />
        <path d="M3.2 3.2h3.4v3.4M20.8 3.2h-3.4v3.4" fill="none" stroke="#2E7BF6"
          strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6.6 20.6l3.4-3.4M17.4 20.6L14 17.2" stroke="#2E7BF6" strokeWidth="2.1"
          strokeLinecap="round" />
      </g>
    ),
    // Score: a podium. The bar chart was three ascending bars, which reads as
    // analytics — this tab is a ranking, and a podium says that immediately.
    score: (
      <g>
        {/* 2nd, left */}
        <rect x="2.6" y="11.8" width="5.9" height="9" rx="1" fill="#C8D0DC" stroke="#8A93A3" strokeWidth="0.8" />
        <text x="5.55" y="18.1" fontSize="4.6" fontWeight="900" textAnchor="middle"
          fontFamily="system-ui, sans-serif" fill="#5C6470">2</text>
        {/* 1st, centre and tallest */}
        <rect x="9" y="7.6" width="6" height="13.2" rx="1" fill="#FFD24A" stroke="#B8860B" strokeWidth="0.8" />
        <text x="12" y="15.6" fontSize="5.2" fontWeight="900" textAnchor="middle"
          fontFamily="system-ui, sans-serif" fill="#7A5A06">1</text>
        {/* 3rd, right */}
        <rect x="15.5" y="14.2" width="5.9" height="6.6" rx="1" fill="#E0A268" stroke="#96602C" strokeWidth="0.8" />
        <text x="18.45" y="19.2" fontSize="4.4" fontWeight="900" textAnchor="middle"
          fontFamily="system-ui, sans-serif" fill="#6B4420">3</text>
        {/* a star over the winner, so the tallest block reads as first */}
        <path d="M12 2.2l1.05 2.2 2.35.33-1.7 1.68.4 2.36L12 7.63 9.9 8.77l.4-2.36-1.7-1.68 2.35-.33z"
          fill="#FFD24A" stroke="#B8860B" strokeWidth="0.5" strokeLinejoin="round" />
      </g>
    ),
  }[kind];
  if (!art) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}>{art}</svg>
  );
}

// 1st / 2nd / 3rd — a medal on a ribbon, in the metal's own colour.
const PLACE = {
  1: { metal: '#FFD24A', dark: '#B8860B', ribbon: '#2E7BF6' },
  2: { metal: '#D6DCE6', dark: '#8A93A3', ribbon: '#5B8DEF' },
  3: { metal: '#E0A268', dark: '#96602C', ribbon: '#8B5E3C' },
};
export function PlaceIcon({ place, size = 18, className = '' }) {
  const c = PLACE[place];
  if (!c) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img"
      aria-label={`${place} place`} focusable="false"
      className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}>
      <path d="M7.4 2.6l3.2 6.2H7.2L4.2 2.6z" fill={c.ribbon} />
      <path d="M16.6 2.6l-3.2 6.2h3.4l3-6.2z" fill={c.ribbon} opacity="0.75" />
      <circle cx="12" cy="15" r="6.6" fill={c.metal} stroke={c.dark} strokeWidth="1.1" />
      <circle cx="12" cy="15" r="4.6" fill="none" stroke={c.dark} strokeWidth="0.7" opacity="0.55" />
      <text x="12" y="18.1" fontSize="6.2" fontWeight="900" textAnchor="middle"
        fontFamily="system-ui, sans-serif" fill={c.dark}>{place}</text>
    </svg>
  );
}

// The Duely bot's face. Every opponent has a picture except this one, which
// fell back to a letter and read as a half-loaded player.
export function BotAvatar({ size = 32, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Duely bot"
      focusable="false" className={`inline-block shrink-0 ${className}`}>
      <circle cx="12" cy="12" r="12" fill="#12213B" />
      <rect x="5.2" y="7.4" width="13.6" height="10.4" rx="3.4"
        fill="#1E5FD0" stroke="#8FBBFF" strokeWidth="1.1" />
      <circle cx="9.2" cy="12.3" r="1.7" fill="#DFF0FF" />
      <circle cx="14.8" cy="12.3" r="1.7" fill="#DFF0FF" />
      <path d="M9.6 15.6h4.8" stroke="#8FBBFF" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M12 4.2v3.2" stroke="#8FBBFF" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="12" cy="3.6" r="1.3" fill="#FFD24A" />
    </svg>
  );
}

export default function UiIcon({ name, size = 20, className = '', title }) {
  const Art = ICONS[name];
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

// ── Result headers ──────────────────────────────────────────────────────────
//
// The four cards that end a match opened with 🏆 💀 🤝 🔌. At the 3rem size
// they are drawn at, an emoji is the one place on the page rendered by the
// operating system rather than by us: it is a different illustration on iOS,
// Android and Windows, and none of them match the site. These are the same
// four ideas, drawn once, in the colour the card is already using.
const OUTCOME = {
  win: { label: 'Victory', art: (
    <>
      <path d="M6 4h12v4.5a6 6 0 0 1-12 0z" fill="#F5C518" />
      <path d="M6 5.2H3.4v1.9a4.2 4.2 0 0 0 3.3 4.1M18 5.2h2.6v1.9a4.2 4.2 0 0 1-3.3 4.1"
        fill="none" stroke="#F5C518" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 14.5v3.2" stroke="#C99A0E" strokeWidth="2" strokeLinecap="round" />
      <rect x="7.6" y="17.6" width="8.8" height="2.6" rx="1" fill="#C99A0E" />
      {/* the shine that makes it read as metal rather than a flat cup */}
      <path d="M8.6 5.4v3a3.4 3.4 0 0 0 1.5 2.8" fill="none" stroke="#FFF3C4"
        strokeWidth="1.1" strokeLinecap="round" opacity="0.85" />
    </>
  ) },
  loss: { label: 'Defeat', art: (
    <>
      {/* A cracked shield, not a skull: the loss is the guard breaking, and it
          keeps the same shield language the rank badges use. */}
      <path d="M12 2.6l7.4 2.7v6c0 4.5-3.1 8.2-7.4 10-4.3-1.8-7.4-5.5-7.4-10v-6z"
        fill="#FF4D5E22" stroke="#FF4D5E" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12.8 5.6l-3.2 5.6h3.1l-2.5 6" fill="none" stroke="#FF4D5E"
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ) },
  draw: { label: 'Draw', art: (
    <>
      {/* Balanced scales — two equal sides, which is what a draw is. */}
      <path d="M12 4.4v14.2" stroke="#8FB4FF" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="3.6" r="1.5" fill="#8FB4FF" />
      <path d="M4.6 7.6h14.8" stroke="#8FB4FF" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4.6 7.6L2 13.2h5.2zM19.4 7.6L16.8 13.2H22z"
        fill="#2E7BF6" stroke="#8FB4FF" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="7.4" y="18.6" width="9.2" height="2.4" rx="1.1" fill="#8FB4FF" />
    </>
  ) },
  disconnect: { label: 'Opponent disconnected', art: (
    <>
      {/* A plug pulled out of its socket, with the gap drawn between them. */}
      <rect x="2.6" y="8.4" width="6.4" height="7.2" rx="1.6" fill="#F5C518" />
      <path d="M9 10.6h2.2M9 13.4h2.2" stroke="#F5C518" strokeWidth="1.7" strokeLinecap="round" />
      <rect x="15" y="8.4" width="6.4" height="7.2" rx="1.6"
        fill="none" stroke="#8A8F98" strokeWidth="1.7" />
      <path d="M15 10.6h-2.2M15 13.4h-2.2" stroke="#8A8F98" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 4.4v2M9.4 5.4l1 1.6M14.6 5.4l-1 1.6"
        stroke="#F5C518" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
    </>
  ) },
};

export function OutcomeIcon({ kind, size = 48, className = '' }) {
  const o = OUTCOME[kind];
  if (!o) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={o.label}
      focusable="false" className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}>
      {o.art}
    </svg>
  );
}

// ── Lock ────────────────────────────────────────────────────────────────────
//
// The 🔒 that gates every logged-out button and every rank wheel. It is the
// most-repeated emoji on the site and the one most likely to render as a
// different object per platform — on some it is a padlock, on others a
// padlock with a key. Drawn in the site's gold so it reads as "you can have
// this" rather than as an error.
export function LockIcon({ size = '1em', open = false, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img"
      aria-label={open ? 'unlocked' : 'locked'} focusable="false"
      className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}>
      {/* The shackle. Open swings it clear of the body on one side, which is
          how an unlocked state reads without needing a caption. */}
      <path d={open ? 'M8 10.5V7a4 4 0 0 1 7.7-1.5' : 'M8 10.5V7a4 4 0 0 1 8 0v3.5'}
        fill="none" stroke="#C99A0E" strokeWidth="2.1" strokeLinecap="round" />
      <rect x="4.4" y="10.2" width="15.2" height="10.6" rx="2.4" fill="#F5C518" />
      <rect x="4.4" y="10.2" width="15.2" height="10.6" rx="2.4"
        fill="none" stroke="#C99A0E" strokeWidth="1" />
      {/* the keyhole, which is what makes it a lock at 14px */}
      <circle cx="12" cy="14.6" r="1.9" fill="#7A5A05" />
      <path d="M12 15.6v2.6" stroke="#7A5A05" strokeWidth="2" strokeLinecap="round" />
      <path d="M6.4 11.6h11.2" stroke="#FFF3C4" strokeWidth="1" opacity="0.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Blackjack table marks ───────────────────────────────────────────────────
//
// Stood, bust, the winner's crown and the split marker were ✅ 💥 👑 ✂️. These
// sit right on the felt next to the cards, which is the worst place for the one
// thing on screen drawn by the operating system: the check is flat green on
// Android and a rounded badge on iOS, and at 12px the scissors is a smudge.
// Drawn here in the colours the table already uses.
const BJ = {
  stand: { label: 'stood', art: (
    <>
      <circle cx="12" cy="12" r="9.2" fill="#2FD46B22" stroke="#2FD46B" strokeWidth="1.8" />
      <path d="M7.6 12.3l3 3 5.8-6.4" fill="none" stroke="#2FD46B" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round" />
    </>
  ) },
  bust: { label: 'bust', art: (
    <>
      {/* A burst, not a bomb: the hand blew past 21, and the shape reads at
          12px where anything with detail does not. */}
      <path d="M12 1.8l2.3 4.6 5-1.6-1.6 5 4.5 2.2-4.5 2.2 1.6 5-5-1.6L12 22.2l-2.3-4.6-5 1.6 1.6-5L1.8 12l4.5-2.2-1.6-5 5 1.6z"
        fill="#FF4D5E33" stroke="#FF4D5E" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 7.4v5.4" stroke="#FF4D5E" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="16.2" r="1.3" fill="#FF4D5E" />
    </>
  ) },
  crown: { label: 'winner', art: (
    <>
      <path d="M3.4 17.2l-1.6-9 5.1 3.4L12 4.6l5.1 7 5.1-3.4-1.6 9z" fill="#F5C518" />
      <rect x="3.4" y="18.2" width="17.2" height="2.6" rx="1" fill="#C99A0E" />
      <circle cx="12" cy="7.6" r="1.5" fill="#FFF3C4" />
    </>
  ) },
  split: { label: 'split', art: (
    <>
      {/* One hand becoming two — the fork says what happened; scissors only
          ever said "cut", which is not what a split is. */}
      <path d="M12 20.5V13m0 0L6.4 6.6M12 13l5.6-6.4" fill="none" stroke="#8FB4FF"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.4" cy="5" r="2.5" fill="#2E7BF6" stroke="#8FB4FF" strokeWidth="1.2" />
      <circle cx="17.6" cy="5" r="2.5" fill="#2E7BF6" stroke="#8FB4FF" strokeWidth="1.2" />
    </>
  ) },
};

// The signup reward present. Drawn rather than 🎁 for the same reason every
// other icon here is: the emoji renders as a different object on every
// platform and cannot take the brand palette. Brand blue box, gold ribbon —
// the same gold the lock and the coin already use, so a reward reads as a
// reward across the site.
export function GiftIcon({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img"
      aria-label="gift" focusable="false"
      className={`inline-block shrink-0 ${className}`}>
      <defs>
        {/* Lit from the upper left, so the box reads as a box and not a
            rectangle. Unique id per size would be overkill — the gradient is
            identical wherever it is used, so a collision is a no-op. */}
        <linearGradient id="giftBox" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#2E76E8" />
          <stop offset="100%" stopColor="#0B3F91" />
        </linearGradient>
        <linearGradient id="giftLid" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#4A90FF" />
          <stop offset="100%" stopColor="#1250B4" />
        </linearGradient>
      </defs>
      {/* body, then lid — the lid overhangs on both sides, which is what makes
          the shape read as a wrapped box at small sizes */}
      <rect x="4" y="10.5" width="16" height="10" rx="1.4" fill="url(#giftBox)" />
      <rect x="2.6" y="7" width="18.8" height="4.2" rx="1.3" fill="url(#giftLid)" />
      {/* ribbon down the front and across the lid */}
      <rect x="10.6" y="7" width="2.8" height="13.5" fill="#F5C518" />
      <rect x="2.6" y="8.4" width="18.8" height="1.5" fill="#F5C518" opacity="0.9" />
      {/* the bow: two loops and a knot */}
      <path d="M12 7C10.6 7 8.2 6.4 8.2 4.8 8.2 3.7 9.1 3 10.1 3c1.4 0 1.9 2 1.9 4z"
        fill="#FFD84D" stroke="#C99A0E" strokeWidth="0.7" strokeLinejoin="round" />
      <path d="M12 7c1.4 0 3.8-.6 3.8-2.2 0-1.1-.9-1.8-1.9-1.8-1.4 0-1.9 2-1.9 4z"
        fill="#FFD84D" stroke="#C99A0E" strokeWidth="0.7" strokeLinejoin="round" />
      <circle cx="12" cy="6.6" r="1.25" fill="#F5C518" stroke="#C99A0E" strokeWidth="0.7" />
      {/* highlight along the top edge of the lid */}
      <path d="M4 8.1h16" stroke="#BBD8FF" strokeWidth="0.8" opacity="0.45" strokeLinecap="round" />
    </svg>
  );
}

export function BjIcon({ kind, size = 16, className = '' }) {
  const o = BJ[kind];
  if (!o) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={o.label}
      focusable="false" className={`inline-block shrink-0 ${className}`} style={ICON_ALIGN}>
      {o.art}
    </svg>
  );
}
