import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import ResultScreen from '../components/ResultScreen';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

function fmtFee(fee) {
  if (fee >= 1000) return `${(fee / 1000).toLocaleString()}k`;
  return `${fee}`;
}

// ── Coin geometry constants ──────────────────────────────────────────────────
const COIN_D = 176;          // diameter px
const COIN_R = COIN_D / 2;   // 88 px radius
const COIN_T = 16;            // edge thickness (z-depth between faces)
const EDGE_N = 36;            // number of cylinder-edge segments
const ARC_W  = (2 * Math.PI * COIN_R) / EDGE_N + 1.5; // arc width + small overlap

// Coin rendered purely via DOM refs — no React state for transforms
function Coin3D({ coinRef, resultLanded }) {
  const faceBase = {
    position: 'absolute', inset: 0, borderRadius: '50%',
    backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  };

  // 36 thin strips forming the cylinder edge. Transform sequence (right→left):
  //   rotateY(90deg)  → strip normal flips from +Z to +X (radially outward)
  //   translateX(R)   → moves strip center to coin circumference
  //   rotateZ(θ)      → positions strip at angle θ, normal becomes (cosθ, sinθ, 0)
  // Result: at outer rotateX(90°), the strip at θ=90° gains screen-normal +Z
  // and appears as the visible metallic edge facing the viewer.
  const edgeSegments = Array.from({ length: EDGE_N }, (_, i) => {
    const angle = (i / EDGE_N) * 360;
    return (
      <div
        key={`e${i}`}
        style={{
          position: 'absolute',
          width: COIN_T,  // becomes the Z depth after rotateY(90)
          height: ARC_W,  // arc span around the circumference
          left: '50%', top: '50%',
          marginLeft: -COIN_T / 2,
          marginTop:  -ARC_W  / 2,
          background: 'linear-gradient(180deg, #1a4080 0%, #0c2550 40%, #071530 100%)',
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          transform: `rotateZ(${angle}deg) translateX(${COIN_R}px) rotateY(90deg)`,
        }}
      />
    );
  });

  return (
    <>
      <style>{`
        @keyframes cf-coin-glow {
          0%,100% { filter: drop-shadow(0 0 16px rgba(30,144,255,0.65)) drop-shadow(0 10px 30px rgba(0,0,0,0.8)); }
          50%      { filter: drop-shadow(0 0 34px rgba(30,144,255,1.0))  drop-shadow(0 12px 38px rgba(0,0,0,0.9)); }
        }
      `}</style>

      {/* Drop-shadow wrapper — glow pulses after result lands */}
      <div style={{
        filter: resultLanded ? undefined : 'drop-shadow(0 14px 32px rgba(0,0,0,0.7))',
        animation: resultLanded ? 'cf-coin-glow 1.5s ease-in-out infinite' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div
          ref={coinRef}
          style={{
            width: COIN_D, height: COIN_D,
            position: 'relative',
            transformStyle: 'preserve-3d',
            transform: 'perspective(700px) rotateX(0deg)',
          }}
        >
          {/* Cylinder edge — 36 strips, visible as rim when coin is ~90° edge-on */}
          {edgeSegments}

          {/* ── Heads face — blue metallic ── */}
          {/* translateZ(COIN_T/2) pushes this face forward; visible at rotateX ≈ 0° */}
          <div style={{
            ...faceBase,
            background: 'radial-gradient(circle at 38% 32%, #a0d8ff 0%, #1E90FF 42%, #0050bb 72%, #003088 100%)',
            border: '4px solid #0066dd',
            boxShadow: 'inset 0 -10px 22px rgba(0,0,0,0.35), inset 0 8px 18px rgba(160,216,255,0.4)',
            transform: `translateZ(${COIN_T / 2}px)`,
          }}>
            <div style={{ position:'absolute', inset:0, borderRadius:'50%',
              background:'radial-gradient(circle at 36% 28%, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.15) 36%, transparent 62%)',
              pointerEvents:'none' }} />
            <div style={{ position:'absolute', inset:6, borderRadius:'50%',
              border:'1.5px solid rgba(160,216,255,0.5)', pointerEvents:'none' }} />
            <span style={{
              fontSize: 66, fontWeight: 900, color: '#fff', lineHeight: 1,
              textShadow: '0 2px 0 rgba(0,80,200,0.5), 0 -1px 0 rgba(255,255,255,0.3)',
              filter: 'drop-shadow(0 3px 5px rgba(0,0,0,0.4))',
              userSelect: 'none',
            }}>H</span>
          </div>

          {/* ── Tails face — silver / light-blue ── */}
          {/* rotateX(180deg) flips this face; visible at rotateX ≈ 180° */}
          <div style={{
            ...faceBase,
            background: 'radial-gradient(circle at 38% 32%, #ffffff 0%, #ddefff 42%, #b0d0ff 72%, #8ab8f0 100%)',
            border: '4px solid #90b8ff',
            boxShadow: 'inset 0 -10px 22px rgba(0,0,0,0.2), inset 0 8px 18px rgba(255,255,255,0.65)',
            transform: `rotateX(180deg) translateZ(${COIN_T / 2}px)`,
          }}>
            <div style={{ position:'absolute', inset:0, borderRadius:'50%',
              background:'radial-gradient(circle at 36% 28%, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.25) 36%, transparent 62%)',
              pointerEvents:'none' }} />
            <div style={{ position:'absolute', inset:6, borderRadius:'50%',
              border:'1.5px solid rgba(255,255,255,0.65)', pointerEvents:'none' }} />
            <span style={{
              fontSize: 66, fontWeight: 900, color: '#1E90FF', lineHeight: 1,
              textShadow: '0 2px 0 rgba(255,255,255,0.7), 0 -1px 0 rgba(30,80,180,0.3)',
              filter: 'drop-shadow(0 3px 5px rgba(0,0,0,0.25))',
              userSelect: 'none',
            }}>T</span>
          </div>
        </div>
      </div>
    </>
  );
}

export default function CoinFlipGame() {
  const ready = usePageReady();
  const navigate = useNavigate();
  const { profile, session, refreshProfile } = useAuth();
  const { socket, authenticated, playerCounts } = useSocket();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const eloBeforeRef    = useRef(profile?.elo ?? 1000);
  const lastModeRef     = useRef(null); // 'pvp' | 'bot_free' | 'bot_paid'
  const lastSettingsRef = useRef({ entryFee: 0, currency: 'coins', side: 'heads' });

  const [phase, setPhase] = useState('lobby');
  const [side, setSide] = useState('heads');
  const [privateCode, setPrivateCode] = useState('');
  const [privateMode, setPrivateMode] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [entryFee, setEntryFee] = useState(() => betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]);
  const [statusMsg, setStatusMsg] = useState('');
  const [flipResult, setFlipResult] = useState(null);
  const [resultData, setResultData] = useState(null);
  const [resultLanded, setResultLanded] = useState(false);

  // RAF-based coin animation — bypasses React state for smooth 60fps
  const coinRef   = useRef(null);
  const rotRef    = useRef(0);
  const rafRef    = useRef(null);
  const lastTRef  = useRef(null);
  const pendingResultRef = useRef(null);

  const stopSpin = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    lastTRef.current = null;
  }, []);

  // Slow idle spin (~70 deg/s) — plays during the wait period before the result arrives
  const startSlowSpin = useCallback(() => {
    stopSpin();
    const animate = (t) => {
      if (lastTRef.current === null) lastTRef.current = t;
      const dt = Math.min(t - lastTRef.current, 50);
      lastTRef.current = t;
      rotRef.current += dt * 0.07; // ~70 deg/s
      if (coinRef.current) {
        coinRef.current.style.transform = `perspective(700px) rotateX(${rotRef.current}deg)`;
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
  }, [stopSpin]);

  const startSpin = useCallback(() => {
    stopSpin();
    const animate = (t) => {
      if (lastTRef.current === null) lastTRef.current = t;
      const dt = Math.min(t - lastTRef.current, 50);
      lastTRef.current = t;
      rotRef.current += dt * 1.5; // ~1500 deg/s
      if (coinRef.current) {
        coinRef.current.style.transform = `perspective(700px) rotateX(${rotRef.current}deg)`;
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
  }, [stopSpin]);

  const landCoin = useCallback((result) => {
    stopSpin();
    // Start from current rotation (0 if no free spin) — easing handles spin-up visually
    const cur = rotRef.current;
    const faceOffset = result === 'heads' ? 0 : 180;
    const curMod = ((cur % 360) + 360) % 360;
    let toFace = ((faceOffset - curMod) + 360) % 360;
    if (toFace < 45) toFace += 360;
    const target = cur + toFace + 12 * 360; // 12 full spins — starts fast, decelerates to correct face

    if (coinRef.current) {
      coinRef.current.style.transition = 'none';
      coinRef.current.style.transform  = `perspective(700px) rotateX(${cur}deg)`;
      // Force reflow so transition starts from cur, not a cached value
      void coinRef.current.offsetHeight;
      coinRef.current.style.transition = 'transform 4.2s cubic-bezier(0.0, 0.0, 0.12, 1.0)';
      coinRef.current.style.transform  = `perspective(700px) rotateX(${target}deg)`;
      rotRef.current = target;
    }
  }, [stopSpin]);

  // Slow idle spin while waiting for the result
  useEffect(() => {
    if (phase !== 'flipping') return;
    if (coinRef.current) {
      coinRef.current.style.transition = 'none';
      coinRef.current.style.transform  = `perspective(700px) rotateX(0deg)`;
    }
    rotRef.current = 0;
    startSlowSpin();
    return () => stopSpin();
  }, [phase, startSlowSpin, stopSpin]);

  // Cleanup on unmount
  useEffect(() => () => stopSpin(), [stopSpin]);

  const isDiamonds = betCurrency === 'diamonds';
  const fees = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel = isDiamonds ? <span>💎</span> : <CoinIcon size="1em" />;
  const myBalance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const sliderIdx = Math.max(0, fees.indexOf(entryFee));

  function switchCurrency(cur) {
    setBetCurrency(cur);
    setEntryFee((cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES)[0]);
  }

  const payoutAmt = isDiamonds
    ? `${(entryFee * 2).toLocaleString()}`
    : `${(entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2)}`;
  const payout = <span className="inline-flex items-center gap-1">{payoutAmt} {currLabel}</span>;

  useEffect(() => {
    if (!socket) return;

    socket.on('coin_flip_queue_joined', ({ side: s }) => {
      setPhase('queue');
      setStatusMsg(`Waiting for someone to pick ${s === 'heads' ? 'Tails' : 'Heads'}…`);
    });

    socket.on('coin_flip_match_found', ({ opponent }) => {
      setFlipResult(null);
      setResultLanded(false);
      rotRef.current = 0;
      setPhase('flipping'); // triggers the useEffect that calls startSpin
      setStatusMsg(`vs ${opponent.username}`);
    });

    socket.on('coin_flip_result', (data) => {
      pendingResultRef.current = data;
      setFlipResult(data.result);
      landCoin(data.result);

      // After transition completes show label for 2s, then result screen
      setTimeout(() => setResultLanded(true), 4200);
      setTimeout(() => {
        setResultData(pendingResultRef.current);
        setPhase('result');
        refreshProfile(); // update balance/ELO when result screen shows
      }, 6200);
    });

    socket.on('opponent_disconnected', (data = {}) => {
      const payout = data.winnerPayout ?? null;
      setResultData({
        winnerId: data.winnerId,
        loserId: data.loserId,
        disconnected: true,
        balanceChange: payout != null ? { winnerPayout: payout } : undefined,
        currency: data.currency,
      });
      setPhase('result');
      refreshProfile();
    });

    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code); setPhase('private_waiting');
    });
    socket.on('private_room_error', ({ message }) => { setStatusMsg(message); setPhase('lobby'); });
    socket.on('error', ({ message }) => { setStatusMsg(message); setPhase('lobby'); });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      socket.off('coin_flip_queue_joined');
      socket.off('coin_flip_match_found');
      socket.off('coin_flip_result');
      socket.off('opponent_disconnected');
      socket.off('private_room_created');
      socket.off('private_room_error');
      socket.off('error');
    };
  }, [socket, landCoin, refreshProfile]);

  function joinQueue() {
    if (!session) { navigate('/login'); return; }
    if (!authenticated || insufficient) return;
    eloBeforeRef.current = profile?.elo ?? 1000;
    lastModeRef.current = 'pvp';
    lastSettingsRef.current = { entryFee, currency: betCurrency, side };
    socket.emit('join_coin_flip_queue', { entryFee, currency: 'coins', side });
  }

  function playVsBot(free = false) {
    if (!session) { navigate('/login'); return; }
    if (!authenticated) return;
    eloBeforeRef.current = profile?.elo ?? 1000;
    const fee = free ? 0 : (isDiamonds ? entryFee : 0);
    lastModeRef.current = free ? 'bot_free' : 'bot_paid';
    lastSettingsRef.current = { entryFee: fee, currency: free ? 'diamonds' : betCurrency, side };
    socket.emit('play_coin_flip_vs_bot', { entryFee: fee, currency: free ? 'diamonds' : betCurrency, side });
    setFlipResult(null);
    setResultLanded(false);
    rotRef.current = 0;
    setPhase('flipping');
    setStatusMsg('vs Duely Bot');
  }

  function leaveQueue() {
    socket?.emit('leave_coin_flip_queue');
    setPhase('lobby'); setStatusMsg('');
  }

  function createPrivate() {
    if (!session) { navigate('/login'); return; }
    socket.emit('create_private_room', { gameType: 'coin-flip', entryFee, currency: betCurrency, side });
  }

  function joinPrivate(code) {
    if (!session) { navigate('/login'); return; }
    socket.emit('join_private_room', { gameType: 'coin-flip', code });
  }

  function cancelPrivate() {
    socket?.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }

  function _resetCoin() {
    stopSpin();
    if (coinRef.current) {
      coinRef.current.style.transition = 'none';
      coinRef.current.style.transform = 'perspective(700px) rotateX(0deg)';
    }
    rotRef.current = 0;
    setResultData(null); setFlipResult(null);
    setResultLanded(false); setStatusMsg('');
  }

  function playAgain() {
    _resetCoin();
    const mode = lastModeRef.current;
    const s = lastSettingsRef.current;
    eloBeforeRef.current = profile?.elo ?? 1000;

    if (mode === 'pvp') {
      socket.emit('join_coin_flip_queue', { entryFee: s.entryFee, currency: s.currency, side: s.side });
      setPhase('queue');
      setStatusMsg(`Waiting for someone to pick ${s.side === 'heads' ? 'Tails' : 'Heads'}…`);
    } else if (mode === 'bot_free' || mode === 'bot_paid') {
      socket.emit('play_coin_flip_vs_bot', { entryFee: s.entryFee, currency: s.currency, side: s.side });
      setPhase('flipping');
      setStatusMsg('vs Duely Bot');
    } else {
      setPhase('lobby');
    }
  }

  if (phase === 'result' && resultData) {
    const isWinner = resultData.winnerId === profile?.id;
    return (
      <div className="min-h-[calc(100vh-56px)] bg-bg flex items-center justify-center px-4">
        <ResultScreen
          isWinner={isWinner}
          isDraw={false}
          winnerUsername={resultData.winnerUsername}
          loserUsername={resultData.loserUsername}
          newWinnerElo={resultData.newWinnerElo}
          newLoserElo={resultData.newLoserElo}
          eloBeforeRef={eloBeforeRef}
          balanceChange={resultData.balanceChange}
          currency={resultData.currency}
          entryFee={resultData.entryFee}
          winnerStreak={resultData.winnerStreak ?? 0}
          isFirstWin={resultData.isFirstWin ?? false}
          profile={profile}
          gameLabel="🟡 Coin Flip"
          extraRows={[
            { label: 'Your Pick', value: side === 'heads' ? '🔵 Heads' : '⚪ Tails' },
            { label: 'Landed On', value: resultData.result === 'heads' ? '🔵 Heads' : '⚪ Tails' },
          ]}
          onPlayAgain={playAgain}
          onBackToLobby={() => { _resetCoin(); setPhase('lobby'); }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="w-full max-w-md animate-slide-up">

        <div className="text-center mb-6">
          <h1 className="text-5xl font-black text-white mb-2">🟡 Coin Flip</h1>
          <p className="text-muted text-base">Pick a side — get matched with the opposite</p>
          {(playerCounts?.['coin-flip'] ?? 0) > 0 && (
            <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full bg-success/10 border border-success/30">
              <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" style={{ boxShadow: '0 0 5px #4ade80' }} />
              <span className="text-success text-xs font-bold">{playerCounts['coin-flip']} playing</span>
            </div>
          )}
        </div>

        {/* Flipping phase */}
        {phase === 'flipping' && (
          <div className="mb-6 text-center">
            {statusMsg && !resultLanded && (
              <p className="text-muted text-sm mb-8">{statusMsg}</p>
            )}
            <div className="flex justify-center my-8">
              <Coin3D coinRef={coinRef} resultLanded={resultLanded} />
            </div>
            {resultLanded && flipResult && (
              <div
                className="text-3xl font-black text-white capitalize mt-8"
                style={{ textShadow: '0 0 20px rgba(30,144,255,0.9)', animation: 'none' }}
              >
                {flipResult === 'heads' ? '🔵' : '⚪'} {flipResult.toUpperCase()}!
              </div>
            )}
            {!resultLanded && (
              <p className="text-muted text-xs mt-8 tracking-widest uppercase opacity-60">Flipping…</p>
            )}
          </div>
        )}

        {/* Queue phase */}
        {phase === 'queue' && (
          <div className="mb-6 bg-surface border border-border rounded-2xl p-5 text-center">
            <div className="text-4xl mb-3 animate-bounce">⏳</div>
            <p className="text-white font-bold mb-2">{statusMsg}</p>
            <p className="text-muted text-sm mb-4">You picked: <span className="font-bold text-white capitalize">{side}</span></p>
            <button onClick={leaveQueue} className="text-sm text-danger hover:text-red-400 transition-colors">Cancel</button>
          </div>
        )}

        {/* Lobby */}
        {phase === 'lobby' && (
          <>
            <div className="mb-4 bg-surface border border-border rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-base font-bold text-white">Entry Fee</span>
                <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
                  <button onClick={() => switchCurrency('coins')} className={`px-4 py-2 rounded text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}><CoinIcon size="0.85em" /> Coins</button>
                  <button onClick={() => switchCurrency('diamonds')} className={`px-4 py-2 rounded text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}>💎 Diamonds</button>
                </div>
              </div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-muted">Min: {fmtFee(fees[0])} {currLabel}</span>
                <span className="text-2xl font-black text-white">{fmtFee(entryFee)} <span className="text-primary">{currLabel}</span></span>
                <span className="text-sm text-muted">Max: {fmtFee(fees[fees.length - 1])} {currLabel}</span>
              </div>
              <input type="range" min={0} max={fees.length - 1} step={1} value={sliderIdx}
                onChange={e => setEntryFee(fees[parseInt(e.target.value)])}
                className="w-full cursor-pointer h-2 rounded-full" style={{ accentColor: '#1E90FF' }} />
              {entryFee > 0 && (
                <div className="mt-4 text-center">
                  <div className="text-xs text-muted uppercase tracking-widest mb-1 font-semibold">Win Payout</div>
                  <div className="text-3xl font-black text-success" style={{ textShadow: '0 0 16px rgba(34,197,94,0.4)' }}>+{payout}</div>
                </div>
              )}
              {insufficient && <p className="text-danger text-sm mt-2 text-center font-semibold">Insufficient balance.</p>}
            </div>

            <div className="mb-4 bg-surface border border-border rounded-2xl p-4">
              <p className="text-sm font-bold text-white mb-3">Pick Your Side</p>
              <div className="grid grid-cols-2 gap-3">
                {['heads', 'tails'].map(s => (
                  <button key={s} onClick={() => setSide(s)}
                    className={`py-3 rounded-xl text-center font-black border-2 transition-all ${
                      side === s ? 'border-primary bg-primary/20 text-white' : 'border-border text-muted hover:border-primary/50 hover:text-white'
                    }`}>
                    <div className="text-2xl mb-0.5">{s === 'heads' ? '🔵' : '⚪'}</div>
                    <div className="capitalize text-sm">{s}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {!isDiamonds && (
                <GlowButton onClick={joinQueue} variant="primary" size="lg" className="w-full text-lg py-4" disabled={session && (!authenticated || insufficient)}>
                  {!session ? '🔒 Login to Play' : `Find Opponent (${side === 'heads' ? '🔵 Heads' : '⚪ Tails'})`}
                </GlowButton>
              )}
              {isDiamonds && (
                <GlowButton onClick={() => playVsBot(false)} variant="primary" size="lg" className="w-full text-lg py-4" disabled={session && (!authenticated || insufficient)}>
                  {!session ? '🔒 Login to Play' : `🤖 Bet vs Bot — ${fmtFee(entryFee)} 💎`}
                </GlowButton>
              )}
              <GlowButton onClick={() => playVsBot(true)} variant="ghost" size="lg" className="w-full text-lg py-4 border border-border hover:border-accent" disabled={session && !authenticated}>
                {!session ? '🔒 Login to Play' : '🎮 Play Free vs Bot'}
              </GlowButton>
              {!isDiamonds && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => setPrivateMode(privateMode === 'create' ? null : 'create')}
                      className={`py-4 rounded-xl text-base font-semibold border transition-all ${privateMode === 'create' ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted hover:border-primary hover:text-white bg-surface'}`}>
                      🔒 Create Room
                    </button>
                    <button onClick={() => setPrivateMode(privateMode === 'join' ? null : 'join')}
                      className={`py-4 rounded-xl text-base font-semibold border transition-all ${privateMode === 'join' ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted hover:border-primary hover:text-white bg-surface'}`}>
                      🔗 Join Room
                    </button>
                  </div>
                  {privateMode === 'create' && (
                    <div className="bg-surface border border-border rounded-xl p-3">
                      <p className="text-xs text-muted mb-3">Create a private room — share the code with a friend.</p>
                      <div className="flex gap-2">
                        <GlowButton onClick={() => { setPrivateMode(null); createPrivate(); }} variant="primary" className="flex-1" disabled={!authenticated}>Create &amp; Get Code</GlowButton>
                        <button onClick={() => setPrivateMode(null)} className="px-4 rounded-lg border border-border text-muted hover:text-white text-xs transition-all">Cancel</button>
                      </div>
                    </div>
                  )}
                  {privateMode === 'join' && (
                    <div className="bg-surface border border-border rounded-xl p-3">
                      <p className="text-xs text-muted mb-3">Enter the 6-character room code your friend shared.</p>
                      <div className="flex gap-2">
                        <input value={joinCode}
                          onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                          placeholder="ABC123"
                          className="flex-1 bg-surfaceLight border border-border rounded-lg px-3 py-2 text-white font-mono text-base tracking-[0.2em] focus:outline-none focus:border-primary text-center" />
                        <GlowButton onClick={() => { joinPrivate(joinCode); setPrivateMode(null); setJoinCode(''); }} variant="primary" className="px-4" disabled={!authenticated || joinCode.length < 4}>Join</GlowButton>
                        <button onClick={() => { setPrivateMode(null); setJoinCode(''); }} className="px-3 rounded-lg border border-border text-muted hover:text-white text-xs">✕</button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {isDiamonds && <p className="text-center text-xs text-muted">Diamond Coin Flip is vs bot only</p>}
            </div>
          </>
        )}

        {/* Private waiting */}
        {phase === 'private_waiting' && (
          <div className="text-center animate-fade-in">
            <div className="text-5xl mb-4">🔒</div>
            <h2 className="text-2xl font-black text-white mb-2">Private Room</h2>
            <p className="text-muted mb-4 text-sm">Share this code with your friend</p>
            <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 inline-block min-w-[200px]">
              <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary">{privateCode}</div>
            </div>
            <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
            <button onClick={cancelPrivate} className="text-sm text-danger hover:text-red-400 transition-colors">Cancel</button>
          </div>
        )}

        {statusMsg && phase === 'lobby' && (
          <p className="text-center text-sm text-warning mt-3">{statusMsg}</p>
        )}
      </div>
    </div>
  );
}
