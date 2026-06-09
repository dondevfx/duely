import { createContext, useContext, useState } from 'react';

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  // 'coins' | 'diamonds' — which currency is shown in the navbar
  const [displayCurrency, setDisplayCurrency] = useState('coins');

  return (
    <CurrencyContext.Provider value={{ displayCurrency, setDisplayCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export const useCurrency = () => useContext(CurrencyContext);
