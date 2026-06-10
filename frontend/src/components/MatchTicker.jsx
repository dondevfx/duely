import { useState, useEffect, useRef } from 'react';
import CoinIcon from './CoinIcon';
import { api } from '../utils/api';

// Only games currently live on the site
const GAME_META = {
  block_blast: { icon: '🟦', name: 'Block Burst' },
  scrabble:    { icon: '🔤', name: 'Word VS'     },
  coin_flip:   { icon: '🟡', name: 'Coin Flip'   },
  blackjack:   { icon: '🃏', name: 'Blackjack'   },
};

const GAME_LIST = Object.values(GAME_META);

// Match real bet sizes exactly
const COIN_POOL    = [1, 1, 1, 5, 5, 10];
const DIAMOND_POOL = [100, 100, 250, 250, 500];

function makeFakeItem() {
  const game    = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
  const diamonds = Math.random() < 0.4;
  const fee     = diamonds
    ? DIAMOND_POOL[Math.floor(Math.random() * DIAMOND_POOL.length)]
    : COIN_POOL[Math.floor(Math.random() * COIN_POOL.length)];
  const payout  = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  const vsBot   = Math.random() < 0.25;
  return {
    id: `fake-${Date.now()}-${Math.random()}`,
    game,
    payout,
    diamonds,
    vsBot,
    fake: true,
  };
}

function makeRealItem(match) {
  const key = match.game_type || 'block_blast';
  const game = GAME_META[key] || GAME_META.block_blast;
  const diamonds = (match.entry_fee_diamonds ?? 0) > 0;
  const fee = diamonds ? (match.entry_fee_diamonds ?? 0) : (match.entry_fee_c ?? 0);
  const payout = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  return {
    id: `real-${match.id}`,
    game,
    payout,
    diamonds,
    vsBot: !match.player2_id,
    fake: false,
    winner: match.winner_username,
  };
}

function fmtPayout(payout, diamonds) {
  if (diamonds) {
    if (payout >= 1000) return `+${(payout / 1000).toFixed(1).replace(/\.0$/, '')}k 💎`;
    return `+${payout} 💎`;
  }
  const amt = payout >= 1000
    ? `+${(payout / 1000).toFixed(1).replace(/\.0$/, '')}k`
    : `+${payout % 1 === 0 ? payout : payout.toFixed(2)}`;
  return <span className="inline-flex items-center gap-0.5">{amt} <CoinIcon size="0.85em" /></span>;
}

const MAX = 14;

export default function MatchTicker() {
  const [items, setItems] = useState(() => Array.from({ length: MAX }, () => makeFakeItem()));
  const timerRef  = useRef(null);
  const realPool  = useRef([]); // cached real match items

  // Fetch recent real matches once on mount
  useEffect(() => {
    api.get('/match/recent').then(matches => {
      if (Array.isArray(matches) && matches.length > 0) {
        realPool.current = matches.map(makeRealItem).filter(m => m.payout > 0);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    function scheduleNext() {
      // New item every 3–5 seconds
      const delay = 3000 + Math.random() * 2000;
      timerRef.current = setTimeout(() => {
        // 30% chance to show a real match if we have any
        const useReal = realPool.current.length > 0 && Math.random() < 0.30;
        const next = useReal
          ? { ...realPool.current[Math.floor(Math.random() * realPool.current.length)], id: `real-${Date.now()}` }
          : makeFakeItem();
        setItems(prev => [next, ...prev].slice(0, MAX));
        scheduleNext();
      }, delay);
    }
    scheduleNext();
    return () => clearTimeout(timerRef.current);
  }, []);

  const card = (item, i) => (
    <div
      key={item.id}
      className={`flex flex-col items-center justify-center gap-1.5 py-3 px-1 bg-surface border rounded-xl overflow-hidden shrink-0${
        i === 0 ? ' animate-pop-in' : ''
      }`}
      style={{
        height: 90,
        width: 80,
        borderColor: item.fake ? undefined : 'rgba(30,144,255,0.3)',
      }}
    >
      <span className="text-3xl leading-none shrink-0">{item.game.icon}</span>
      <span className="text-[9px] text-muted font-medium leading-none w-full text-center truncate px-1">
        {item.game.name}{item.vsBot ? ' · Bot' : ''}
      </span>
      <span className="text-[10px] font-bold text-success leading-none truncate w-full text-center px-1">
        {fmtPayout(item.payout, item.diamonds)}
      </span>
    </div>
  );

  return (
    <>
      {/* Mobile: horizontal scroll strip */}
      <div className="lg:hidden flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {items.map((item, i) => card(item, i))}
      </div>
      {/* Desktop: full grid */}
      <div className="hidden lg:grid gap-2" style={{ gridTemplateColumns: `repeat(${MAX}, 1fr)` }}>
        {items.map((item, i) => card(item, i))}
      </div>
    </>
  );
}
