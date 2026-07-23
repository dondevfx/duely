import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import GlowButton from './GlowButton';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';
import CreateRoomModal from './CreateRoomModal';
import JoinRoomModal from './JoinRoomModal';

export const COIN_FEES    = [1, 5, 10, 25, 50, 100];
export const DIAMOND_FEES = [500, 5000, 50000];

function fmtFee(fee) {
  if (fee < 1)         return `${fee}`;
  if (fee >= 1000)     return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

function calcPayout(fee, isDiamonds) {
  if (isDiamonds) return (fee * 2).toLocaleString();
  const p = fee * 2 * 0.95;
  return p % 1 === 0 ? p.toLocaleString() : p.toFixed(2);
}

// Updates slider visuals directly on DOM nodes — no React re-render needed
function applySliderDOM(rawIdx, fees, isDiamonds, thumb, fill, display, payout) {
  const maxIdx = fees.length - 1;
  const clampedRaw = Math.max(0, Math.min(maxIdx, rawIdx));
  const pct = maxIdx > 0 ? (clampedRaw / maxIdx) * 100 : 0;
  const fee = fees[Math.round(clampedRaw)] ?? fees[0];
  if (thumb)   thumb.style.left    = `${pct}%`;
  if (fill)    fill.style.width    = `${pct}%`;
  if (display) display.textContent = fmtFee(fee);
  if (payout)  payout.textContent  = fee > 0 ? `+${calcPayout(fee, isDiamonds)}` : '';
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
  const sliderTrackRef = useRef(null);
  const sliderThumbRef = useRef(null);
  const sliderFillRef  = useRef(null);
  const feeDisplayRef  = useRef(null);
  const payoutDisplayRef = useRef(null);
  const dragRef        = useRef({ active: false, fees: [], setEntryFee: null, isDiamonds: false });

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

  // Keep dragRef in sync so native event handlers always see current values
  dragRef.current.fees       = fees;
  dragRef.current.setEntryFee = setEntryFee;
  dragRef.current.isDiamonds  = isDiamonds;

  // Sync slider DOM position when entryFee changes externally (currency switch, mount)
  useEffect(() => {
    const idx = Math.max(0, fees.indexOf(entryFee));
    applySliderDOM(idx, fees, isDiamonds, sliderThumbRef.current, sliderFillRef.current, feeDisplayRef.current, payoutDisplayRef.current);
  }, [fees, entryFee, isDiamonds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach native pointer events once — no React re-renders during drag
  useEffect(() => {
    const track = sliderTrackRef.current;
    if (!track) return;

    function rawFromX(clientX) {
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pct * (dragRef.current.fees.length - 1);
    }

    function apply(raw) {
      applySliderDOM(raw, dragRef.current.fees, dragRef.current.isDiamonds,
        sliderThumbRef.current, sliderFillRef.current, feeDisplayRef.current, payoutDisplayRef.current);
    }

    function onDown(e) {
      dragRef.current.active = true;
      track.setPointerCapture(e.pointerId);
      apply(rawFromX(e.clientX));
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragRef.current.active) return;
      apply(rawFromX(e.clientX));
    }

    function onUp(e) {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      const snapped = Math.round(Math.max(0, Math.min(dragRef.current.fees.length - 1, rawFromX(e.clientX))));
      apply(snapped);
      dragRef.current.setEntryFee(dragRef.current.fees[snapped]);
    }

    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
    return () => {
      track.removeEventListener('pointerdown', onDown);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const payoutAmt = isDiamonds
    ? (entryFee * 2).toLocaleString()
    : ((entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2));
  const payout = isDiamonds
    ? `${payoutAmt} 💎`
    : <span className="inline-flex items-center gap-1">{payoutAmt} <CoinIcon size="0.9em" /></span>;

  return (
    <div className="w-full max-w-md animate-slide-up">
      <h1 className="text-5xl font-black text-white text-center mb-3">{title}</h1>
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
            <span ref={feeDisplayRef}>{fmtFee(entryFee)}</span>{' '}
            <span className="text-primary">{currLabel}</span>
          </span>
          <span className="text-sm text-muted">Max: {fmtFee(fees[fees.length - 1])} {currLabel}</span>
        </div>

        {/* Custom smooth slider — DOM-driven during drag, zero React re-renders per frame */}
        <div
          ref={sliderTrackRef}
          className="relative w-full h-12 flex items-center cursor-grab active:cursor-grabbing select-none touch-none"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          {/* Track background */}
          <div className="absolute left-0 right-0 h-2 rounded-full bg-border overflow-hidden">
            {/* width is controlled exclusively via sliderFillRef — never set here so React re-renders don't override drag position */}
            <div ref={sliderFillRef} className="h-full rounded-full bg-primary" style={{ width: '0%' }} />
          </div>
          {/* Tick marks — static, React-controlled fine */}
          {fees.map((_, i) => {
            const tickPct = fees.length > 1 ? (i / (fees.length - 1)) * 100 : 0;
            return (
              <div
                key={i}
                className="absolute w-1.5 h-1.5 rounded-full bg-white opacity-50 -translate-x-1/2 pointer-events-none"
                style={{ left: `${tickPct}%` }}
              />
            );
          })}
          {/* Thumb — left is controlled exclusively via sliderThumbRef */}
          <div
            ref={sliderThumbRef}
            className="absolute w-6 h-6 rounded-full bg-white border-2 border-primary -translate-x-1/2 pointer-events-none"
            style={{ left: '0%', boxShadow: '0 2px 12px rgba(18,80,180,0.6)' }}
          />
        </div>

        {/* Payout — updates live during drag via payoutDisplayRef */}
        {entryFee > 0 && (
          <div className="mt-4 text-center">
            <div className="text-xs text-muted uppercase tracking-widest mb-1 font-semibold">Win Payout</div>
            <div className="text-3xl font-black text-success inline-flex items-center gap-1" style={{ textShadow: '0 0 16px rgba(34,197,94,0.4)' }}>
              <span ref={payoutDisplayRef}>{`+${calcPayout(entryFee, isDiamonds)}`}</span>
              {' '}{currLabel}
            </div>
          </div>
        )}

        {/* Live player count — only show when > 0 */}
        {typeof liveCount === 'number' && liveCount > 0 && (
          <div className="flex items-center gap-1.5 mt-1">
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4', animation: 'pulse 2s infinite' }} />
            <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{liveCount} playing</span>
          </div>
        )}

        {/* Per-bet live count — only show when > 0 */}
        {gameType && (() => {
          const betKey = `${gameType}:${entryFee}:${betCurrency}`;
          const betLiveCount = betCounts?.[betKey] || 0;
          if (betLiveCount <= 0) return null;
          return (
            <div className="flex items-center gap-1.5 mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4', animation: 'pulse 2s infinite' }} />
              <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>
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
            disabled={session && insufficient}
          >
            {session ? `🤖 Bet vs Bot — ${fmtFee(entryFee)} 💎` : '🔒 Login to Play'}
          </GlowButton>
        )}

        {/* Free play — always available */}
        {onBotFree && (() => {
          const label = botLabel || '🎮 Play Free vs Bot';
          return (
            <GlowButton
              onClick={session ? onBotFree : () => navigate('/login')}
              variant="ghost"
              size="lg"
              className="w-full text-lg py-4 border border-border hover:border-border"
              disabled={false}
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
                🔒 Create Game
              </button>
              <button
                onClick={() => setPrivateMode(privateMode === 'join' ? null : 'join')}
                className={`py-4 rounded-xl text-base font-semibold border transition-all ${
                  privateMode === 'join'
                    ? 'border-primary text-primary bg-primary/10'
                    : 'border-border text-muted hover:border-primary hover:text-white bg-surface'
                }`}
              >
                🔗 Join Game
              </button>
            </div>

            <CreateRoomModal
              open={privateMode === 'create'}
              onClose={() => setPrivateMode(null)}
              gameType={gameType}
              entryFee={entryFee}
              currency={betCurrency}
              onCreateCode={() => onCreatePrivate(entryFee, betCurrency)}
            />

            <JoinRoomModal
              open={privateMode === 'join'}
              onClose={() => setPrivateMode(null)}
              onJoin={(code) => onJoinPrivate(code)}
              authenticated={authenticated}
            />
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
