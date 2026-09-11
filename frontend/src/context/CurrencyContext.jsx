import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  // 'coins' | 'diamonds' — which currency is shown in the navbar
  const [displayCurrency, setDisplayCurrency] = useState('coins');
  const { pathname, state } = useLocation();
  const { profile } = useAuth();
  const appliedFor = useRef(null);

  // A game's betting screen opens on diamonds when the player has no coins.
  //
  // A new account has its welcome diamonds and nothing else, and landing on a
  // coin screen it cannot afford meant a trip to the toggle before it could
  // play at all. Once per visit to a game, so a player who switches back to
  // coins on that screen is not switched again; and never over a currency the
  // navigation asked for explicitly (a rematch, a challenge link).
  useEffect(() => {
    if (!pathname.startsWith('/game/')) { appliedFor.current = null; return; }
    if (!profile || appliedFor.current === pathname) return;
    appliedFor.current = pathname;
    if (state?.betCurrency) return;
    const coins = parseFloat(profile.c_coins) || 0;
    const diamonds = Number(profile.diamonds) || 0;
    if (coins <= 0 && diamonds > 0) setDisplayCurrency('diamonds');
  }, [pathname, profile, state]);

  return (
    <CurrencyContext.Provider value={{ displayCurrency, setDisplayCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export const useCurrency = () => useContext(CurrencyContext);
