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
      className={`inline-block shrink-0 align-middle ${className}`}>{art}</svg>
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
    // Score: a rising bar chart.
    score: (
      <g>
        <rect x="3.6" y="13.4" width="4.4" height="7.2" rx="1.2" fill="#2FD46B" />
        <rect x="9.8" y="9" width="4.4" height="11.6" rx="1.2" fill="#4BE08A" />
        <rect x="16" y="4.2" width="4.4" height="16.4" rx="1.2" fill="#7BEBAB" />
      </g>
    ),
  }[kind];
  if (!art) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      className={`inline-block shrink-0 align-middle ${className}`}>{art}</svg>
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
      className={`inline-block shrink-0 align-middle ${className}`}>
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
      className={`inline-block shrink-0 align-middle ${className}`}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      <Art />
    </svg>
  );
}
