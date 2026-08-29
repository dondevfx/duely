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
  rakeback: () => (
    <g {...P}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.4 4.2v4.4h-4.4" />
      <path d="M12 8.6v3.6l2.4 1.6" />
    </g>
  ),
};

export const hasUiIcon = (name) => !!ICONS[name];

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
