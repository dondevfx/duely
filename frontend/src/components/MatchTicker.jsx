import { useState, useEffect, useRef } from 'react';
import CoinIcon from './CoinIcon';
import { api } from '../utils/api';

const GAME_META = {
  block_blast: { icon: '🟦', name: 'Block Burst' },
  scrabble:    { icon: '🔤', name: 'Word VS'     },
  coin_flip:   { icon: '🟡', name: 'Coin Flip'   },
  blackjack:   { icon: '🃏', name: 'Blackjack'   },
};

const GAME_LIST = Object.values(GAME_META);
const COIN_POOL    = [1, 5, 10];
const DIAMOND_POOL = [100, 250, 500];

// Just the fee amount (not game) — used for fake repeat check
function feeKey(item) {
  return `${item.fee}-${item.diamonds ? 'd' : 'c'}`;
}

function makeFakeItem(lastFeeKey = null, lastTwoGames = []) {
  // Try up to 10 times to avoid same bet size back-to-back and same game 3 in a row
  const blockedGame = lastTwoGames.length === 2 && lastTwoGames[0] === lastTwoGames[1]
    ? lastTwoGames[0] : null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const game     = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
    if (blockedGame && game.name === blockedGame) continue;
    const diamonds = Math.random() < 0.4;
    const pool     = diamonds ? DIAMOND_POOL : COIN_POOL;
    const fee      = pool[Math.floor(Math.random() * pool.length)];
    const key      = `${fee}-${diamonds ? 'd' : 'c'}`;
    if (key !== lastFeeKey) {
      const payout = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
      return { id: `fake-${Date.now()}-${Math.random()}`, game, payout, fee, diamonds, fake: true };
    }
  }
  // Fallback — just pick anything
  const game     = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
  const diamonds = Math.random() < 0.4;
  const pool     = diamonds ? DIAMOND_POOL : COIN_POOL;
  const fee      = pool[Math.floor(Math.random() * pool.length)];
  const payout   = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  return { id: `fake-${Date.now()}-${Math.random()}`, game, payout, fee, diamonds, fake: true };
}

function makeRealItem(match) {
  const game     = GAME_META[match.game_type] || GAME_META.block_blast;
  const diamonds = (match.entry_fee_diamonds ?? 0) > 0;
  const fee      = diamonds ? (match.entry_fee_diamonds ?? 0) : (match.entry_fee_c ?? 0);
  const payout   = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  return { id: `real-${match.id}`, game, payout, fee, diamonds, fake: false };
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
const MIN_REAL_INTERVAL = 500; // max 2 real matches per second

function buildInitialItems() {
  const result = [];
  for (let i = 0; i < MAX; i++) {
    const last = result[result.length - 1];
    const prev = result[result.length - 2];
    const lastGames = [last?.game.name, prev?.game.name].filter(Boolean);
    result.push(makeFakeItem(last ? feeKey(last) : null, lastGames));
  }
  return result;
}

export default function MatchTicker() {
  const [items, setItems]   = useState(buildInitialItems);
  const timerRef            = useRef(null);
  const realPool            = useRef([]);
  const itemsRef            = useRef(items);
  const lastRealShownAt     = useRef(0);   // timestamp of last real match shown
  const lastFakeKeyRef      = useRef(null); // fee key of last fake shown
  const lastTwoGamesRef     = useRef([]);   // last 2 fake game names shown

  useEffect(() => { itemsRef.current = items; }, [items]);

  // Fetch recent real matches once on mount
  useEffect(() => {
    api.get('/match/recent').then(matches => {
      if (!Array.isArray(matches)) return;
      const real = matches.map(makeRealItem).filter(m => m.payout > 0);
      realPool.current = real;
      if (real.length > 0) {
        setItems(prev => {
          const seeded = [...prev];
          real.slice(0, MAX).forEach((r, i) => {
            seeded[i * 2] = { ...r, id: `real-seed-${i}` };
          });
          return seeded.slice(0, MAX);
        });
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    function scheduleNext() {
      // Fake items: 2–5 second interval
      const delay = 2000 + Math.random() * 3000;
      timerRef.current = setTimeout(() => {
        const pool = realPool.current;
        const now  = Date.now();
        const canShowReal = pool.length > 0 && (now - lastRealShownAt.current) >= MIN_REAL_INTERVAL;

        let next;
        if (canShowReal && Math.random() < 0.70) {
          // Pick a random real match
          const pick = pool[Math.floor(Math.random() * pool.length)];
          next = { ...pick, id: `real-${Date.now()}-${Math.random()}` };
          lastRealShownAt.current = now;
        } else {
          // Fake — avoid same bet size as last fake
          next = makeFakeItem(lastFakeKeyRef.current, lastTwoGamesRef.current);
          lastFakeKeyRef.current = feeKey(next);
          lastTwoGamesRef.current = [next.game.name, ...(lastTwoGamesRef.current)].slice(0, 2);
        }

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
      style={{ height: 90, width: 80 }}
    >
      <span className="text-3xl leading-none shrink-0">{item.game.icon}</span>
      <span className="text-[9px] text-muted font-medium leading-none w-full text-center truncate px-1">
        {item.game.name}
      </span>
      <span className="text-[10px] font-bold text-success leading-none truncate w-full text-center px-1">
        {fmtPayout(item.payout, item.diamonds)}
      </span>
    </div>
  );

  return (
    <>
      <div className="lg:hidden flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {items.map((item, i) => card(item, i))}
      </div>
      <div className="hidden lg:grid gap-2" style={{ gridTemplateColumns: `repeat(${MAX}, 1fr)` }}>
        {items.map((item, i) => card(item, i))}
      </div>
    </>
  );
}
