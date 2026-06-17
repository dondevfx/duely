import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import GlowButton from './GlowButton';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';

export const COIN_FEES    = [1, 5, 10];
export const DIAMOND_FEES = [100, 250, 500, 50000];

function fmtFee(fee) {
  if (fee < 1)         return `${fee}`;
  if (fee >= 1000)     return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

export default function GameLobby({
  title,
  description,
  controls,
  betCurrency,
  setBetCurrency,
  entryFee,
  setEntryFee,
  balance,
  authenticated,
  doAuth,
  onQueue,
  onBot,
  onBotFree,
  botLabel,
  onCreatePrivate,
  onJoinPrivate,
  statusMsg,
  liveCount,
  gameType,
}) {
  const [privateMode, setPrivateMode] = useState(null); // null | 'create' | 'join'
  const [joinCode, setJoinCode]       = useState('');

  const { betCounts } = useSocket() || {};
  const { session } = useAuth();
  const navigate = useNavigate();

  function guardedAction(fn) {
    return () => {
      if (!session) { navigate('/login'); return; }
      fn();
    };
  }

  const isDiamonds = betCurrency === 'diamonds';
  const fees       = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel  = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const insufficient = entryFee > 0 && balance < entryFee;

  const sliderIdx = Math.max(0, fees.indexOf(entryFee));

  // Safety net on mount — catch case where betCurrency is already set but entryFee is stale
  useEffect(() => {
    if (!fees.includes(entryFee)) setEntryFee(fees[0]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Safety net on currency switch
  useEffect(() => {
    if (!fees.includes(entryFee)) setEntryFee(fees[0]);
  }, [betCurrency]); // eslint-disable-line react-hooks/exhaustive-deps

  function switchCurrency(cur) {
    setBetCurrency(cur);
    // Reset to first fee of new currency — avoids index mismatch between arrays
    const newFees = cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES;
    setEntryFee(newFees[0]);
  }

  function handleSlider(e) {
    setEntryFee(fees[parseInt(e.target.value)]);
  }

  const payoutAmt = isDiamonds
    ? (entryFee * 2).toLocaleString()
    : ((entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2));
  const payout = isDiamonds
    ? `${payoutAmt} 💎`
    : <span className="inline-flex items-center gap-1">{payoutAmt} <CoinIcon size="0.9em" /></span>;

  return (
    <div className="w-full max-w-md animate-slide-up">
      <h1 className="text-3xl sm:text-5xl font-black text-white text-center mb-3">{title}</h1>
      {description && (
        <p className="text-center text-muted text-base leading-relaxed mb-6 px-2">{description}</p>
      )}

      {/* ── Entry Fee ── */}
      <div className="mb-4 bg-surface border border-border rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <span className="text-base font-bold text-white">Entry Fee</span>
          <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
            <button
              onClick={() => switchCurrency('coins')}
              className={`px-4 py-2 rounded text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
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

        {/* Bet amount display */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-muted">Min: {fmtFee(fees[0])} {currLabel}</span>
          <span className="text-2xl font-black text-white">
            {fmtFee(entryFee)} <span className="text-primary">{currLabel}</span>
          </span>
          <span className="text-sm text-muted">Max: {fmtFee(fees[fees.length - 1])} {currLabel}</span>
        </div>

        {/* Slider */}
        <input
          type="range"
          min={0}
          max={fees.length - 1}
          step={1}
          value={sliderIdx}
          onChange={handleSlider}
          className="w-full accent-primary cursor-pointer h-2 rounded-full"
          style={{ accentColor: '#1E90FF' }}
        />

        {/* Payout — centered below slider, big and prominent */}
        {entryFee > 0 && (
          <div className="mt-4 text-center">
            <div className="text-xs text-muted uppercase tracking-widest mb-1 font-semibold">Win Payout</div>
            <div className="text-3xl font-black text-success" style={{ textShadow: '0 0 16px rgba(34,197,94,0.4)' }}>
              +{payout}
            </div>
          </div>
        )}

        {/* Live player count — only show when > 0 */}
        {typeof liveCount === 'number' && liveCount > 0 && (
          <div className="flex items-center gap-1.5 mt-1">
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80', animation: 'pulse 2s infinite' }} />
            <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 600 }}>{liveCount} playing</span>
          </div>
        )}

        {/* Per-bet live count — only show when > 0 */}
        {gameType && (() => {
          const betKey = `${gameType}:${entryFee}:${betCurrency}`;
          const betLiveCount = betCounts?.[betKey] || 0;
          if (betLiveCount <= 0) return null;
          return (
            <div className="flex items-center gap-1.5 mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80', animation: 'pulse 2s infinite' }} />
              <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 600 }}>
                {betLiveCount} at this bet size
              </span>
            </div>
          );
        })()}

        {insufficient && (
          <p className="text-danger text-sm mt-2 text-center font-semibold">Insufficient balance.</p>
        )}
      </div>

      {/* ── Controls / extras ── */}
      {controls && <div className="mb-4">{controls}</div>}

      {/* ── Action Buttons ── */}
      <div className="flex flex-col gap-3">
        <GlowButton
          onClick={session ? onQueue : () => navigate('/login')}
          variant="primary"
          size="lg"
          className="w-full text-lg py-4"
          disabled={session && (!authenticated || insufficient)}
        >
          {session ? 'Find Opponent' : '🔒 Login to Play'}
        </GlowButton>

        {/* Diamond-only bet vs bot — only visible when diamonds are selected */}
        {onBot && isDiamonds && entryFee > 0 && (
          <GlowButton
            onClick={session ? onBot : () => navigate('/login')}
            variant="ghost"
            size="lg"
            className="w-full text-lg py-4 border border-border hover:border-accent"
            disabled={session && (!authenticated || insufficient)}
          >
            {session ? `🤖 Bet vs Bot — ${fmtFee(entryFee)} 💎` : '🔒 Login to Play'}
          </GlowButton>
        )}

        {/* Free play — always available */}
        {onBotFree && (() => {
          const isSoloEndless = botLabel && botLabel.includes('Endless');
          const label = isSoloEndless
            ? botLabel
            : isDiamonds
              ? (botLabel && !botLabel.toLowerCase().includes('bet') ? botLabel : '🎮 Play Free vs Bot')
              : '🎮 Play Free vs Bot';
          return (
            <GlowButton
              onClick={session ? onBotFree : () => navigate('/login')}
              variant="ghost"
              size="lg"
              className="w-full text-lg py-4 border border-border hover:border-border"
              disabled={session && !authenticated}
            >
              {session ? label : '🔒 Login to Play'}
            </GlowButton>
          );
        })()}

        {/* ── Private Match ── */}
        {onCreatePrivate && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setPrivateMode(privateMode === 'create' ? null : 'create')}
                className={`py-4 rounded-xl text-base font-semibold border transition-all ${
                  privateMode === 'create'
                    ? 'border-primary text-primary bg-primary/10'
                    : 'border-border text-muted hover:border-primary hover:text-white bg-surface'
                }`}
              >
                🔒 Create Room
              </button>
              <button
                onClick={() => setPrivateMode(privateMode === 'join' ? null : 'join')}
                className={`py-4 rounded-xl text-base font-semibold border transition-all ${
                  privateMode === 'join'
                    ? 'border-primary text-primary bg-primary/10'
                    : 'border-border text-muted hover:border-primary hover:text-white bg-surface'
                }`}
              >
                🔗 Join Room
              </button>
            </div>

            {privateMode === 'create' && (
              <div className="bg-surface border border-border rounded-xl p-3 animate-slide-down">
                <p className="text-xs text-muted mb-3">
                  Create a private room — your entry fee setting applies. Share the code with a friend.
                </p>
                <div className="flex gap-2">
                  <GlowButton
                    onClick={() => { setPrivateMode(null); onCreatePrivate(entryFee, betCurrency); }}
                    variant="primary"
                    className="flex-1"
                    disabled={!authenticated}
                  >
                    Create &amp; Get Code
                  </GlowButton>
                  <button
                    onClick={() => setPrivateMode(null)}
                    className="px-4 rounded-lg border border-border text-muted hover:text-white text-xs transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {privateMode === 'join' && (
              <div className="bg-surface border border-border rounded-xl p-3 animate-slide-down">
                <p className="text-xs text-muted mb-3">Enter the 6-character room code your friend shared.</p>
                <div className="flex gap-2">
                  <input
                    value={joinCode}
                    onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                    placeholder="ABC123"
                    className="flex-1 bg-surfaceLight border border-border rounded-lg px-3 py-2 text-white font-mono text-base tracking-[0.2em] focus:outline-none focus:border-primary text-center"
                  />
                  <GlowButton
                    onClick={() => { onJoinPrivate(joinCode); setPrivateMode(null); setJoinCode(''); }}
                    variant="primary"
                    className="px-4"
                    disabled={!authenticated || joinCode.length < 4}
                  >
                    Join
                  </GlowButton>
                  <button
                    onClick={() => { setPrivateMode(null); setJoinCode(''); }}
                    className="px-3 rounded-lg border border-border text-muted hover:text-white text-xs"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {statusMsg && (
        <p className="text-center text-base text-muted mt-4 animate-fade-in">{statusMsg}</p>
      )}
      {session && !authenticated && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted mt-3">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          Connecting...
          <button onClick={doAuth} className="text-primary underline">Retry</button>
        </div>
      )}
    </div>
  );
}
