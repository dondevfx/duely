import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import BetSlider from '../components/BetSlider';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

const GAMES = [
  { route: '/game/block-blast', name: 'Block Burst',         icon: '🟦' },
  { route: '/game/tetris',      name: 'Block Fall',              icon: '🟩' },
  { route: '/game/chess',       name: 'Chess',               icon: '♟' },
  { route: '/game/c4',          name: 'Drop Zone',        icon: '🔴' },
  { route: '/game/piano',       name: 'Tile Tap',         icon: '🎹' },
  { route: '/game/type',        name: 'Type Race',           icon: '⌨️' },
];

function fmtFee(fee) {
  if (fee < 1)       return `${fee}`;
  if (fee >= 1000)   return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

export default function RandomGame() {
  const ready = usePageReady();
  const { profile } = useAuth();
  const { authenticated } = useSocket();
  const navigate = useNavigate();

  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const [entryFee, setEntryFee]       = useState(1);
  const [rolling, setRolling]         = useState(false);
  const [picked, setPicked]           = useState(null);

  const isDiamonds  = betCurrency === 'diamonds';
  const fees        = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel   = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance   = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;

  const sliderIdx = Math.max(0, fees.indexOf(entryFee));

  function switchCurrency(cur) {
    setBetCurrency(cur);
    const newFees = cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES;
    const idx = Math.min(sliderIdx, newFees.length - 1);
    setEntryFee(newFees[idx]);
  }

  function handleSlider(e) {
    setEntryFee(fees[parseInt(e.target.value)]);
  }

  const payoutAmt = (entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2);
  const payout = isDiamonds
    ? `${(entryFee * 2).toLocaleString()} 💎`
    : <span className="inline-flex items-center gap-1">{payoutAmt} <CoinIcon size="0.85em" /></span>;

  function roll() {
    if (!authenticated || insufficient || rolling) return;
    setRolling(true);
    setPicked(null);

    let count = 0;
    const flashes = 14;
    const id = setInterval(() => {
      setPicked(GAMES[Math.floor(Math.random() * GAMES.length)]);
      count++;
      if (count >= flashes) {
        clearInterval(id);
        const final = GAMES[Math.floor(Math.random() * GAMES.length)];
        setPicked(final);
        setRolling(false);
        setTimeout(() => navigate(final.route, { state: { entryFee, betCurrency, autoQueue: true } }), 1100);
      }
    }, 75);
  }

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="w-full max-w-md animate-slide-up">

        <div className="text-center mb-6">
          <div className="text-5xl mb-3">🎲</div>
          <h1 className="text-5xl font-black text-white mb-2">Random Game</h1>
          <p className="text-muted text-base">Pick your bet — we'll choose the game</p>
        </div>

        {/* Entry Fee */}
        <div className="mb-4 bg-surface border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <span className="text-base font-bold text-white">Entry Fee</span>
            <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
              <button
                onClick={() => switchCurrency('coins')}
                className={`px-4 py-2 rounded text-sm font-bold transition-all inline-flex items-center gap-1 ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
              >
                <CoinIcon size="0.85em" /> Coins
              </button>
              <button
                onClick={() => switchCurrency('diamonds')}
                className={`px-4 py-2 rounded text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
              >
                💎 Diamonds
              </button>
            </div>
          </div>

          <BetSlider fees={fees} entryFee={entryFee} setEntryFee={setEntryFee} currLabel={currLabel} />

          {entryFee > 0 && (
            <div className="flex items-center justify-between mt-3 px-1">
              <span className="text-sm text-muted">Payout if you win</span>
              <span className="text-success font-bold text-sm">+{payout}</span>
            </div>
          )}

          {insufficient && (
            <p className="text-danger text-sm mt-2 text-center font-semibold">Insufficient balance.</p>
          )}
        </div>

        {/* Selected game display */}
        {picked && (
          <div className={`mb-4 bg-surface border rounded-2xl p-5 text-center transition-all ${
            rolling ? 'border-border' : 'border-primary/50 bg-primary/5'
          }`}>
            <div className={`text-4xl mb-2 transition-all ${rolling ? 'scale-90 opacity-70' : 'scale-100'}`}>
              {picked.icon}
            </div>
            <div className={`text-xl font-black text-white transition-all ${rolling ? 'blur-[1px] opacity-60' : ''}`}>
              {picked.name}
            </div>
            {!rolling && <p className="text-sm text-primary mt-1 animate-pulse">Launching...</p>}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <GlowButton
            onClick={roll}
            variant="primary"
            size="lg"
            className="w-full text-lg py-4"
            disabled={!authenticated || insufficient || rolling}
          >
            {rolling ? '🎲 Rolling...' : picked ? '🎲 Roll Again' : '🎲 Roll for a Game!'}
          </GlowButton>

          {entryFee > 0 && !rolling && (
            <p className="text-center text-sm text-muted" style={{ marginTop: '12px' }}>
              Payout if you win:{' '}
              <span className="text-success font-bold">
                +{payout}
              </span>
            </p>
          )}
        </div>

        {!authenticated && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted mt-3">
            <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            Connecting...
          </div>
        )}
      </div>
    </div>
  );
}

