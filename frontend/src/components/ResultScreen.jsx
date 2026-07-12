import { useState, useEffect } from 'react';
import { getRank, isRanked, placementMatches, getDisplayRank } from '../utils/ranks';
import CoinIcon from './CoinIcon';
import { playWin, playLoss, playDraw } from '../utils/sound';

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Big countdown number shown below the payout — 10 seconds, flashes red at 5
function ResultTimer({ seconds = 10, onTimeout }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(id); onTimeout?.(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flashing = remaining <= 5;
  return (
    <div className="text-center mt-4">
      <div
        key={remaining}
        className={`text-5xl font-black font-mono ${flashing ? 'animate-pulse' : ''}`}
        style={{ color: remaining <= 3 ? '#ef4444' : flashing ? '#f97316' : '#64748b' }}
      >
        {remaining}
      </div>
      <div className="text-xs text-muted mt-0.5">returning to lobby…</div>
    </div>
  );
}

/**
 * ResultScreen — shared result card used by all game pages.
 *
 * Props:
 *   isWinner        bool
 *   winnerUsername  string
 *   loserUsername   string
 *   newWinnerElo    number
 *   newLoserElo     number
 *   eloBeforeRef    ref  (ref.current = elo before match)
 *   balanceChange   { winnerPayout }
 *   currency        'coins' | 'diamonds'
 *   entryFee        number
 *   disconnected    bool   (opponent left)
 *   winnerStreak    number
 *   isFirstWin      bool
 *   profile         profile object
 *   extraRows       [{ label, value }]  — game-specific stats
 *   onRematch       fn | null   (null = hide rematch button)
 *   onPlayAgain     fn          (back to lobby)
 *   rematchLabel    string      default 'Rematch'
 *   gameLabel       string      e.g. '🟩 Block Fall'
 */
export default function ResultScreen({
  isWinner,
  isDraw = false,
  winnerUsername,
  loserUsername,
  newWinnerElo,
  newLoserElo,
  eloBeforeRef,
  balanceChange,
  currency = 'coins',
  entryFee = 0,
  disconnected = false,
  winnerStreak = 0,
  isFirstWin = false,
  profile,
  extraRows = [],
  onRematch,
  onPlayAgain,
  onBackToLobby,
  rematchLabel = 'Rematch',
  gameLabel = '',
}) {
  // onBackToLobby falls back to onPlayAgain for pages that haven't split the two yet
  const goBack = onBackToLobby ?? onPlayAgain;
  const elo       = isWinner ? newWinnerElo : newLoserElo; // undefined = no ELO data yet
  const eloBefore = eloBeforeRef?.current ?? null;
  const eloDelta  = (elo != null && eloBefore != null) ? elo - eloBefore : null;

  const totalMatches = (profile?.wins ?? 0) + (profile?.losses ?? 0);
  const ranked = isRanked(profile);
  const placement = placementMatches(profile);
  // Paid matches always update ELO regardless of placement — show the real number
  const showElo = ranked || (entryFee > 0 && elo != null);

  // Play the result sound once when this card mounts.
  useEffect(() => {
    if (isDraw) playDraw();
    else if (isWinner) playWin();
    else playLoss();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="w-full max-w-sm mx-auto relative animate-slide-up"
      onMouseEnter={() => {}} // timer continues — intentional
    >
      <div className="bg-surface border border-surfaceLight rounded-2xl overflow-hidden shadow-2xl">
        <div className="p-7">
          {/* Win / Loss / Draw header */}
          <div className="text-center mb-5">
            <div className="text-5xl mb-2">
              {isDraw ? '🤝' : isWinner ? '🏆' : '💀'}
            </div>
            <div className={`text-3xl font-black ${isDraw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`}>
              {isDraw ? 'Draw!' : isWinner ? 'Victory!' : 'Defeat'}
            </div>
            {!isDraw && isWinner && winnerStreak >= 1 && (
              <p className="text-base font-bold text-orange-400 mt-1" style={{ textShadow: '0 0 10px rgba(251,146,60,0.5)' }}>
                🔥 {winnerStreak} Win Streak!
              </p>
            )}
            {!isDraw && !isWinner && (
              <p className="text-sm text-muted mt-1">Your win streak has been reset</p>
            )}
            {!isDraw && isWinner && isFirstWin && (
              <div className="mt-2 px-4 py-1.5 rounded-xl bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 text-sm font-bold inline-block">
                🎉 First Victory!
              </div>
            )}
          </div>

          {/* Placement progress (first 3 matches) */}
          {!ranked && (
            <div className="mb-4 p-3 rounded-xl bg-primary/10 border border-primary/30 text-center">
              <div className="text-xs font-bold text-primary mb-1">Placement Matches</div>
              <div className="flex justify-center gap-2 mb-1">
                {[0,1,2].map(i => (
                  <div key={i} className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[9px] font-black transition-all ${
                    i < placement
                      ? 'bg-success border-success text-white'
                      : 'border-muted text-muted'
                  }`}>
                    {i < placement ? '✓' : i + 1}
                  </div>
                ))}
              </div>
              <div className="text-xs text-muted">{placement}/3 — {3 - placement} match{3 - placement !== 1 ? 'es' : ''} to unlock ranked</div>
            </div>
          )}

          {/* Stats */}
          <div className="bg-bg rounded-xl p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">{isWinner ? winnerUsername : loserUsername} vs {isWinner ? loserUsername : winnerUsername}</span>
              <span className="text-xs text-muted">{gameLabel}</span>
            </div>
            {disconnected && (
              <div className="flex justify-between">
                <span className="text-muted">Reason</span>
                <span className="text-warning font-bold">Opponent disconnected</span>
              </div>
            )}
            {disconnected && isWinner && entryFee > 0 && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted">Prize pool</span>
                  <span className="text-white font-bold">
                    {currency === 'diamonds'
                      ? `${(entryFee * 2).toLocaleString()} 💎`
                      : <span className="inline-flex items-center gap-1">{fmt(entryFee * 2)} <CoinIcon size="0.85em" /></span>}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Platform fee</span>
                  <span className="font-bold" style={{ color: '#f97316' }}>
                    {currency === 'diamonds' ? '0%' : '5%'}
                  </span>
                </div>
              </>
            )}
            {extraRows.map(r => (
              <div key={r.label} className="flex justify-between">
                <span className="text-muted">{r.label}</span>
                <span className="text-white font-bold">{r.value}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-surfaceLight/40 pt-2">
              <span className="text-muted">ELO</span>
              {showElo ? (
                <span className="text-white font-bold">
                  {elo ?? '—'}{' '}
                  {eloDelta != null && (
                    <span className={eloDelta >= 0 ? 'text-success' : 'text-danger'}>
                      ({eloDelta >= 0 ? '+' : ''}{eloDelta})
                    </span>
                  )}
                </span>
              ) : (
                <span className="font-bold" style={{ color: '#64748b' }}>Unranked</span>
              )}
            </div>
            {(balanceChange || (isDraw && entryFee > 0) || (!isDraw && entryFee > 0)) && (
              <div className="border-t border-surfaceLight/40 pt-3 mt-1 text-center">
                <div className="text-xs text-muted mb-1 uppercase tracking-widest font-semibold">
                  {isDraw ? 'Your Split' : isWinner ? 'Payout' : 'Entry Lost'}
                </div>
                <div
                  className={`text-4xl font-black ${isDraw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`}
                  style={{ textShadow: isWinner && !isDraw ? '0 0 20px rgba(74,222,128,0.6)' : isDraw ? '0 0 20px rgba(56,189,248,0.5)' : 'none' }}
                >
                  {isDraw ? (
                    currency === 'diamonds'
                      ? `+${Math.round(balanceChange?.winnerPayout ?? entryFee).toLocaleString()} 💎`
                      : <span className="inline-flex items-center gap-1">+{fmt(balanceChange?.winnerPayout ?? entryFee)} <CoinIcon size="0.8em" /></span>
                  ) : isWinner ? (
                    currency === 'diamonds'
                      ? `+${Math.round(balanceChange?.winnerPayout ?? 0).toLocaleString()} 💎`
                      : <span className="inline-flex items-center gap-1">+{fmt(balanceChange?.winnerPayout ?? 0)} <CoinIcon size="0.8em" /></span>
                  ) : (
                    currency === 'diamonds'
                      ? `-${entryFee} 💎`
                      : <span className="inline-flex items-center gap-1">-{entryFee} <CoinIcon size="0.8em" /></span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Countdown timer — goes back to lobby, not re-queue */}
          <ResultTimer seconds={10} onTimeout={goBack} />

          {/* Buttons */}
          <div className="flex gap-3 mt-4">
            {onRematch && (
              <button
                onClick={onRematch}
                className="flex-1 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
              >
                {rematchLabel}
              </button>
            )}
            <button
              onClick={onPlayAgain}
              className={`py-3 rounded-xl font-black text-base transition-all ${
                onRematch
                  ? 'flex-1 bg-surface border border-surfaceLight text-white hover:border-primary'
                  : 'w-full bg-primary text-white hover:bg-blue-500'
              }`}
              style={!onRematch ? { boxShadow: '0 0 18px rgba(18,80,180,0.35)' } : {}}
            >
              Play Again
            </button>
          </div>

          <button
            onClick={goBack}
            className="w-full text-center text-xs text-muted hover:text-white transition-colors mt-3 py-1"
          >
            ← Back to lobby
          </button>
        </div>
      </div>
    </div>
  );
}
