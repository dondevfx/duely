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

// Matches the 3 bet sizes on the bet screen
const COIN_POOL    = [1, 5, 10];
const DIAMOND_POOL = [100, 250, 500];

// Unique key for a game+payout combo — used to detect repeats
function itemKey(item) {
  return `${item.game.name}-${item.payout}-${item.diamonds ? 'd' : 'c'}`;
}

// Returns true if the same key appears 2+ times in the last 2 items
function wouldRepeat(key, recentItems) {
  return recentItems.slice(0, 2).filter(it => itemKey(it) === key).length >= 2;
}

function makeFakeItem(recentItems = []) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const game    = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
    const diamonds = Math.random() < 0.4;
    const pool    = diamonds ? DIAMOND_POOL : COIN_POOL;
    const fee     = pool[Math.floor(Math.random() * pool.length)];
    const payout  = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
    const candidate = {
      id: `fake-${Date.now()}-${Math.random()}`,
      game, payout, diamonds,
      vsBot: Math.random() < 0.25,
      fake: true,
    };
    if (!wouldRepeat(itemKey(candidate), recentItems)) return candidate;
  }
  // Fallback — generate without constraint if all combos exhausted
  const game    = GAME_LIST[Math.floor(Math.random() * GAME_LIST.length)];
  const diamonds = Math.random() < 0.4;
  const pool    = diamonds ? DIAMOND_POOL : COIN_POOL;
  const fee     = pool[Math.floor(Math.random() * pool.length)];
  const payout  = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  return { id: `fake-${Date.now()}-${Math.random()}`, game, payout, diamonds, vsBot: Math.random() < 0.25, fake: true };
}

function makeRealItem(match) {
  const key = match.game_type || 'block_blast';
  const game = GAME_META[key] || GAME_META.block_blast;
  const diamonds = (match.entry_fee_diamonds ?? 0) > 0;
  const fee = diamonds ? (match.entry_fee_diamonds ?? 0) : (match.entry_fee_c ?? 0);
  const payout = diamonds ? fee * 2 : parseFloat((fee * 2 * 0.95).toFixed(2));
  return {
    id: `real-${match.id}`,
    game, payout, diamonds,
    vsBot: !match.player2_id,
    fake: false,
  };
}

// Pick the next item to display, avoiding repeating the same game+payout within 2 consecutive tiles
function pickNext(recentItems, realPool) {
  const useReal = realPool.length > 0 && Math.random() < 0.70;

  if (useReal) {
    // Shuffle real pool and find first non-repeating candidate
    const shuffled = [...realPool].sort(() => Math.random() - 0.5);
    for (const candidate of shuffled) {
      if (!wouldRepeat(itemKey(candidate), recentItems)) {
        return { ...candidate, id: `real-${Date.now()}-${Math.random()}` };
      }
    }
    // All real combos would repeat — fall through to fake
  }

  return makeFakeItem(recentItems);
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

// Build the initial list with variety enforced from the start
function buildInitialItems() {
  const result = [];
  for (let i = 0; i < MAX; i++) {
    result.push(makeFakeItem(result));
  }
  return result;
}

export default function MatchTicker() {
  const [items, setItems] = useState(buildInitialItems);
  const timerRef  = useRef(null);
  const realPool  = useRef([]);

  // Fetch recent real matches once on mount
  useEffect(() => {
    api.get('/match/recent').then(matches => {
      if (Array.isArray(matches) && matches.length > 0) {
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
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    function scheduleNext() {
      const delay = 3000 + Math.random() * 2000;
      timerRef.current = setTimeout(() => {
        setItems(prev => {
          const next = pickNext(prev, realPool.current);
          return [next, ...prev].slice(0, MAX);
        });
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
