import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import GlowButton from './GlowButton';
import { useSocket } from '../context/SocketContext';
import BetSlider from './BetSlider';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';
import CreateRoomModal from './CreateRoomModal';
import JoinRoomModal from './JoinRoomModal';

// Small secondary buttons under the two primary actions on every betting screen.
export const SMALL_BTN =
  'flex-1 px-3 sm:px-4 py-3 sm:py-3 rounded-xl text-sm font-bold whitespace-nowrap border border-border bg-surface text-muted ' +
  'hover:border-primary hover:text-white transition-all disabled:opacity-40 disabled:hover:border-border';

export const COIN_FEES    = [1, 5, 10, 25, 50, 100];
export const DIAMOND_FEES = [500, 5000, 50000];

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

  const payoutAmt = isDiamonds
    ? (entryFee * 2).toLocaleString()
    : ((entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2));
  const payout = isDiamonds
    ? `${payoutAmt} 💎`
    : <span className="inline-flex items-center gap-1">{payoutAmt} <CoinIcon size="0.9em" /></span>;

  return (
    <div className="w-full max-w-md animate-slide-up">
      <h1 className="text-4xl sm:text-6xl font-black text-white text-center mb-0.5 sm:mb-3 leading-tight">{title}</h1>
      {description && (
        <p className="text-center text-muted text-xs sm:text-base leading-snug sm:leading-relaxed mb-1 sm:mb-6 px-2 line-clamp-2 sm:line-clamp-none">{description}</p>
      )}

      {/* ── Entry Fee ── */}
      <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl p-2.5 sm:p-5">
        <div className="flex items-center justify-between mb-1.5 sm:mb-4">
          <span className="text-base font-bold text-white">Entry Fee</span>
          <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
            <button
              onClick={() => switchCurrency('coins')}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
            >
              <CoinIcon size="0.85em" /> Coins
            </button>
            <button
              onClick={() => switchCurrency('diamonds')}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}
            >
              💎 Diamonds
            </button>
          </div>
        </div>

        {/* One shared slider for every betting screen. This used to be a second,
            near-identical implementation living here, which is why the bet
            sections drifted apart between games and why a fix to the shared
            control never reached Rush Hour, Block Burst or Word VS. */}
        <BetSlider
          fees={fees}
          entryFee={entryFee}
          setEntryFee={setEntryFee}
          currLabel={currLabel}
          isDiamonds={isDiamonds}
        />

        {/* Live player count — only show when > 0 */}
        {typeof liveCount === 'number' && liveCount > 0 && (
          <div className="flex items-center gap-1.5 mt-0 sm:mt-1">
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
            <div className="flex items-center gap-1.5 mt-0 sm:mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4', animation: 'pulse 2s infinite' }} />
              <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>
                {betLiveCount} at this bet size
              </span>
            </div>
          );
        })()}

      </div>

      {/* ── Controls / extras ── */}
      {controls && <div className="mb-2 sm:mb-4">{controls}</div>}

      {/* ── Action Buttons ── */}
      <div className="flex flex-col gap-1 sm:gap-3">
        {!session ? (
          <GlowButton onClick={() => navigate('/login')} variant="primary" size="lg" className="w-full text-base sm:text-lg py-3.5 sm:py-4">
            🔒 Login to Play
          </GlowButton>
        ) : (
        <>
      {/* Insufficient balance is surfaced ON the disabled action button,
          not as a line of its own. As a separate row it added ~14px of
          height that only ever appeared to players who could not afford
          the bet — i.e. it pushed the lobby off small screens in exactly
          the case where the buttons most needed to stay reachable. */}
        <GlowButton
          onClick={session ? onQueue : () => navigate('/login')}
          variant="primary"
          size="lg"
          className="w-full text-base sm:text-lg py-3.5 sm:py-4"
          disabled={session && (!authenticated || insufficient)}
        >
          {!session ? '🔒 Login to Play' : insufficient ? 'Insufficient Balance' : 'Find Opponent'}
        </GlowButton>

        {/* ── Challenge a Friend (link or direct invite) ── */}
        {session && onCreatePrivate && (
          <GlowButton
            onClick={() => setPrivateMode('create')}
            variant="ghost"
            size="lg"
            className="w-full text-base sm:text-lg py-3.5 sm:py-4 border border-border hover:border-primary"
          >
            🎮 Challenge a Friend
          </GlowButton>
        )}

        {/* Secondary options — small buttons, still visible but not competing
            with the two primary actions above. */}
        {session && (onBot || onBotFree || onCreatePrivate) && (
          <div className="flex flex-col gap-1.5 sm:gap-2 pt-0 sm:pt-1">
            {/* Diamond bet-vs-bot gets its own full-width row — the label is too
                long to share a row with the other two. */}
            {onBot && isDiamonds && entryFee > 0 && (
              <button onClick={onBot} disabled={insufficient} className={SMALL_BTN}>
                Bet vs Bot — {fmtFee(entryFee)} 💎
              </button>
            )}
            <div className="flex gap-1.5 sm:gap-2">
              {onBotFree && (
                <button onClick={onBotFree} className={SMALL_BTN}>
                  {botLabel || 'Play vs Bot'}
                </button>
              )}
              {onCreatePrivate && (
                <button onClick={() => setPrivateMode('join')} className={SMALL_BTN}>
                  Join Game
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Private Match modals ── */}
        {onCreatePrivate && (
          <>
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
        </>
        )}
      </div>

      {statusMsg && (
        <p className="text-center text-sm sm:text-base text-muted mt-2 sm:mt-4 animate-fade-in">{statusMsg}</p>
      )}
      {session && !authenticated && (
        <div className="flex items-center justify-center gap-2 text-xs sm:text-sm text-muted mt-1.5 sm:mt-3">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          Connecting...
          <button onClick={doAuth} className="text-primary underline">Retry</button>
        </div>
      )}
    </div>
  );
}
