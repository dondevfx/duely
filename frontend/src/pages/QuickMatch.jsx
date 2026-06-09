import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../utils/supabase';
import { useSocket } from '../context/SocketContext';
import { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';

const POOL = [
  { route: '/game/block-blast', name: 'Block Burst',  icon: '🟦' },
  { route: '/game/coin-flip',   name: 'Coin Flip',    icon: '🪙' },
  { route: '/game/blackjack',   name: 'Blackjack',    icon: '🃏' },
  { route: '/game/word-vs',     name: 'Word VS',       icon: '🔤' },
];

function fmtFee(fee) {
  if (fee >= 1000) return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

export default function QuickMatch() {
  const ready      = usePageReady();
  const { profile, session } = useAuth();
  const { authenticated } = useSocket();
  const navigate   = useNavigate();

  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const [entryFee, setEntryFee] = useState(() => {
    // start at first fee of whichever currency is active
    return betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0];
  });
  const [rolling, setRolling]   = useState(false);
  const [picked, setPicked]     = useState(null);

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? '💎' : '🪙';
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  // Find index; if current entryFee not in new fees array, default to 0
  const sliderIdx = (() => {
    const i = fees.indexOf(entryFee);
    return i >= 0 ? i : 0;
  })();

  function switchCurrency(cur) {
    setBetCurrency(cur);
    // Always reset to first fee of the new currency to avoid index mismatch
    const newFees = cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES;
    setEntryFee(newFees[0]);
  }

  function handleSlider(e) { setEntryFee(fees[parseInt(e.target.value)]); }

  function play() {
    if (!authenticated || insufficient || rolling) return;
    setRolling(true);
    setPicked(null);

    // Flash through games quickly for visual excitement
    let count = 0;
    const flashes = 12;
    const interval = setInterval(() => {
      setPicked(POOL[Math.floor(Math.random() * POOL.length)]);
      count++;
      if (count >= flashes) {
        clearInterval(interval);
        const final = POOL[Math.floor(Math.random() * POOL.length)];
        setPicked(final);
        setRolling(false);
        setTimeout(() => {
          navigate(final.route, { state: { entryFee, betCurrency, autoQueue: true } });
        }, 900);
      }
    }, 70);
  }

  const payout = isDiamonds
    ? `${(entryFee * 2).toLocaleString()} 💎`
    : `${(entryFee * 2 * 0.95).toFixed(entryFee * 2 * 0.95 % 1 === 0 ? 0 : 2)} 🪙`;

  return (
    <div
      className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      <div className="w-full max-w-md animate-slide-up">

        <div className="text-center mb-6">
          <div className="text-5xl mb-3">⚡</div>
          <h1 className="text-5xl font-black text-white mb-2">Quick Match</h1>
          <p className="text-muted text-base">Pick your bet — we'll choose the game</p>
        </div>

        {/* Game pool preview */}
        <div className="flex justify-center gap-3 mb-5">
          {POOL.map(g => (
            <div
              key={g.route}
              className={`text-2xl transition-all duration-75 ${picked?.route === g.route ? 'scale-125' : 'opacity-40 scale-100'}`}
              title={g.name}
            >
              {g.icon}
            </div>
          ))}
        </div>

        {/* Entry fee selector */}
        <div className="mb-4 bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <span className="text-base font-bold text-white">Entry Fee</span>
            <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
              <button
                onClick={() => switchCurrency('coins')}
                className={`px-4 py-2 rounded text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
              >
                🪙 Coins
              </button>
              <button
                onClick={() => switchCurrency('diamonds')}
                className={`px-4 py-2 rounded text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
              >
                💎 Diamonds
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted">Min: {fmtFee(fees[0])} {currLabel}</span>
            <span className="text-2xl font-black text-white">
              {fmtFee(entryFee)} <span className="text-primary">{currLabel}</span>
            </span>
            <span className="text-sm text-muted">Max: {fmtFee(fees[fees.length - 1])} {currLabel}</span>
          </div>

          <input
            type="range" min={0} max={fees.length - 1} step={1} value={sliderIdx}
            onChange={handleSlider}
            className="w-full cursor-pointer h-2 rounded-full"
            style={{ accentColor: '#1E90FF' }}
          />

          {entryFee > 0 && (
            <div className="flex items-center justify-between mt-3 px-1">
              <span className="text-sm text-muted">Win payout</span>
              <span className="text-success font-bold text-sm">+{payout}</span>
            </div>
          )}
          {insufficient && (
            <p className="text-danger text-sm mt-2 text-center font-semibold">Insufficient balance.</p>
          )}
        </div>

        {/* Picked game display */}
        {picked && (
          <div className={`mb-4 bg-surface border rounded-2xl p-5 text-center transition-all ${
            rolling ? 'border-border' : 'border-primary/50 bg-primary/5'
          }`}>
            <div className={`text-4xl mb-2 transition-all ${rolling ? 'scale-90 opacity-70' : 'scale-110'}`}>
              {picked.icon}
            </div>
            <div className={`text-xl font-black text-white ${rolling ? 'blur-[1px] opacity-60' : ''}`}>
              {picked.name}
            </div>
            {!rolling && <p className="text-sm text-primary mt-1 animate-pulse">Joining queue…</p>}
          </div>
        )}

        <GlowButton
          onClick={session ? play : () => navigate('/login')}
          variant="primary"
          size="lg"
          className="w-full text-lg py-4"
          disabled={session && (!authenticated || insufficient || rolling)}
        >
          {!session ? '🔒 Login to Play' : rolling ? '⚡ Finding game…' : '⚡ Play'}
        </GlowButton>

        {!authenticated && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted mt-3">
            <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            Connecting…
          </div>
        )}

        <p className="text-center text-xs text-muted mt-4">
          Pool: Block Burst · Coin Flip · Blackjack · Word VS
        </p>
      </div>
    </div>
  );
}
