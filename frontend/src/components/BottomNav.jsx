import { NavLink } from 'react-router-dom';
import UiIcon from './UiIcon';

/**
 * The phone's main navigation.
 *
 * Phones used to reach everything through a hamburger in the top bar: a tap to
 * open a full-screen menu, a tap to choose, and the four places people actually
 * go were three taps deep and invisible until you opened it. This is those four
 * places, always on screen, one tap each.
 *
 * Phones only. On md and up the left sidebar is permanently visible and already
 * does this job.
 *
 * FOUR, not more. A bar of eight is a menu lying down — the point is that each
 * target is wide enough to hit without looking. Profile is the one thing that
 * used to live in the hamburger and is not here: it moved to the avatar in the
 * top bar, which is where a profile belongs and where people already tap for
 * it. Sign out lives on the profile page.
 */
const ITEMS = [
  { ui: 'home',        label: 'Home',        to: '/' },
  { ui: 'rewards',     label: 'Rewards',     to: '/rewards' },
  { ui: 'leaderboard', label: 'Leaderboard', to: '/leaderboard' },
  { ui: 'wallet',      label: 'Wallet',      to: '/wallet' },
];

export default function BottomNav() {
  return (
    <nav
      aria-label="Main"
      // Fixed, and padded for the home indicator. Without the safe-area inset
      // the labels sit under the gesture bar on any modern iPhone.
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border
                 bg-black/85 backdrop-blur-md"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <ul className="flex items-stretch">
        {ITEMS.map(item => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              end={item.to === '/'}
              // 56px of height, so the tap target clears the 44px minimum with
              // room for the label underneath.
              className={({ isActive }) =>
                `h-14 flex flex-col items-center justify-center gap-0.5 transition-colors ` +
                (isActive ? 'text-primary' : 'text-muted active:text-white')
              }
              style={{ touchAction: 'manipulation' }}
            >
              {({ isActive }) => (
                <>
                  <UiIcon name={item.ui} size={22} />
                  <span className={`text-[0.625rem] leading-none ${isActive ? 'font-bold' : 'font-medium'}`}>
                    {item.label}
                  </span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
