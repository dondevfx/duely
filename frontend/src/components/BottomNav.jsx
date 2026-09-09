import { NavLink, useLocation } from 'react-router-dom';
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
 * FIVE, and that is the ceiling. A bar of eight is a menu lying down — the
 * point is that each target is wide enough to hit without looking. At five,
 * on the narrowest phone still in use, each one is about 65px across, which
 * is comfortably past the 44px a fingertip needs.
 *
 * Profile is in the bar AND on the avatar in the top bar. That is deliberate
 * duplication rather than an oversight: the avatar is a 30px target in a
 * corner, and the bar is where people look for their own things.
 */
const ITEMS = [
  { ui: 'home',        label: 'Home',        to: '/' },
  { ui: 'rewards',     label: 'Rewards',     to: '/rewards' },
  { ui: 'leaderboard', label: 'Leaderboard', to: '/leaderboard' },
  { ui: 'wallet',      label: 'Wallet',      to: '/wallet' },
  { ui: 'profile',     label: 'Profile',     to: '/profile' },
];

// Whether the bar shows, and how a bet screen asks for it back.
//
// A game ROUTE is two different screens: the bet screen, where the bar is
// wanted, and the game itself, where it would sit on top of what is being
// played. The path cannot tell them apart — both are /game/<slug> — so the
// screen says so instead.
//
// A bet screen calls useShowBottomBar(true) while it is the thing on screen.
// Default off for /game/*, so a screen that says nothing gets no bar: a game
// that forgets to opt out would otherwise have a bar over its board, which is
// the worse failure of the two.
import { createContext, useContext, useEffect, useState } from 'react';

const BarContext = createContext(null);

export function BottomBarProvider({ children }) {
  const [asked, setAsked] = useState(0);
  return (
    <BarContext.Provider value={{ asked, setAsked }}>{children}</BarContext.Provider>
  );
}

/**
 * Ask for the bar while `active`. Counted rather than a boolean, so two screens
 * mounting across a transition cannot leave it stuck off when the first
 * unmounts after the second has already asked.
 */
export function useShowBottomBar(active = true) {
  const ctx = useContext(BarContext);
  useEffect(() => {
    if (!ctx || !active) return;
    ctx.setAsked(n => n + 1);
    return () => ctx.setAsked(n => n - 1);
  }, [ctx, active]);
}

// Exported because App.jsx has to reserve the bar's height in the scroll area
// and must not decide that separately — it did, and the two disagreed: main
// held back 56px for a bar that no longer rendered while every game page still
// asked for min-h-[calc(100dvh-3.5rem)], a page taller than the box it sits in.
export function useShowsBottomNav(pathname) {
  const ctx = useContext(BarContext);
  // Matched on the /game/ prefix rather than a list of slugs, so a game added
  // later is covered the day it ships. /games is a normal page and keeps it.
  if (!/^\/game(\/|$)/.test(pathname)) return true;
  return (ctx?.asked || 0) > 0;
}

export default function BottomNav() {
  const { pathname } = useLocation();
  const showsNav = useShowsBottomNav(pathname);

  // A bet screen asks for the bar back; a game does not — see
  // useShowsBottomNav above.
  if (!showsNav) return null;

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
