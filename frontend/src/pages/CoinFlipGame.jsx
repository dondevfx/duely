import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { playMatchFound, playCountdown, playGo, playCoinFlip, playCoinLand, stopAllSounds } from '../utils/sound';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import { COIN_FEES, DIAMOND_FEES } from '../components/GameLobby';
import BetSlider from '../components/BetSlider';
import ResultScreen from '../components/ResultScreen';
import GlowButton from '../components/GlowButton';
import CreateRoomModal from '../components/CreateRoomModal';
import JoinRoomModal from '../components/JoinRoomModal';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
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
// Decorative engraving for a coin face — just a reeded (milled) rim right at
// the edge of the coin. tickColor lets the blue Heads face and the light Tails
// face use a contrasting tint.
function CoinDetail({ tickColor }) {
  const rimMask = 'radial-gradient(circle closest-side, transparent 0 84%, #000 88%, #000 100%)';
  return (
    <div style={{ position:'absolute', inset:4, borderRadius:'50%',
      background:`repeating-conic-gradient(${tickColor} 0deg 2deg, transparent 2deg 5deg)`,
      WebkitMask: rimMask, mask: rimMask, opacity:0.65, pointerEvents:'none' }} />
  );
}

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
          0%,100% { filter: drop-shadow(0 0 16px rgba(18,80,180,0.65)) drop-shadow(0 10px 30px rgba(0,0,0,0.8)); }
          50%      { filter: drop-shadow(0 0 34px rgba(18,80,180,1.0))  drop-shadow(0 12px 38px rgba(0,0,0,0.9)); }
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
            background: 'radial-gradient(circle at 38% 32%, #a0d8ff 0%, #1250B4 42%, #0050bb 72%, #003088 100%)',
            border: '4px solid #0066dd',
            boxShadow: 'inset 0 -10px 22px rgba(0,0,0,0.35), inset 0 8px 18px rgba(160,216,255,0.4)',
            transform: `translateZ(${COIN_T / 2}px)`,
          }}>
            <CoinDetail tickColor="rgba(195,228,255,0.9)" />
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
            <CoinDetail tickColor="rgba(105,150,210,0.75)" />
            <div style={{ position:'absolute', inset:0, borderRadius:'50%',
              background:'radial-gradient(circle at 36% 28%, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.25) 36%, transparent 62%)',
              pointerEvents:'none' }} />
            <div style={{ position:'absolute', inset:6, borderRadius:'50%',
              border:'1.5px solid rgba(255,255,255,0.65)', pointerEvents:'none' }} />
            <span style={{
              fontSize: 66, fontWeight: 900, color: '#1250B4', lineHeight: 1,
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
  const location = useLocation();
  const { profile, session, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, playerCounts, betCounts } = useSocket();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const eloBeforeRef    = useRef(profile?.elo ?? 1000);
  const lastModeRef     = useRef(null); // 'pvp' | 'bot_free' | 'bot_paid'
  const lastSettingsRef = useRef({ entryFee: 0, currency: 'coins', side: 'heads' });
  const socketRef        = useRef(socket);
  const inActiveMatchRef = useRef(false);
  const fxTimersRef      = useRef([]); // countdown / result timers, so we can cancel on leave

  // Cancel any pending countdown/result timers and silence any scheduled sounds.
  function stopCoinFx() {
    fxTimersRef.current.forEach(clearTimeout);
    fxTimersRef.current = [];
    stopAllSounds();
  }
  const refreshProfileRef = useRef(refreshProfile);
  const profileRef        = useRef(profile);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { refreshProfileRef.current = refreshProfile; }, [refreshProfile]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  // Forfeit on unmount and on page refresh/close; also refresh balance so leaver sees updated balance
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Cancel pending countdown/flip timers and silence any scheduled sounds
      stopCoinFx();
      // Always emit on SPA navigation (logo click, sidebar links, etc.)
      // Server is a no-op if no active room exists for this socket
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
      // Refresh balance after 2.5s so the leaver sees the deducted/settled balance
      setTimeout(() => refreshProfileRef.current?.(), 2500);
    };
  }, []);
  // Refresh balance on mount; delayed second call catches server settle that races with reload
  useEffect(() => {
    refreshProfile();
    const t = setTimeout(refreshProfile, 2500);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [phase, setPhase] = useState('lobby');
  const [countdown, setCountdown] = useState(0);
  const [side, setSide] = useState('heads');
  const [privateCode, setPrivateCode] = useState('');
  const [privateMode, setPrivateMode] = useState(null);
  const [invitedFriend, setInvitedFriend] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [entryFee, setEntryFee] = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
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
      playCoinFlip({ duration: 4.2, totalDegrees: toFace + 12 * 360 });
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
  const currLabel = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const sliderIdx = Math.max(0, fees.indexOf(entryFee));

  function switchCurrency(cur) {
    setBetCurrency(cur);
    setEntryFee((cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES)[0]);
  }

  const payoutAmt = isDiamonds
    ? `${(entryFee * 2).toLocaleString()}`
    : `${(entryFee * 2 * 0.98) % 1 === 0 ? (entryFee * 2 * 0.98).toLocaleString() : (entryFee * 2 * 0.98).toFixed(2)}`;
  const payout = <span className="inline-flex items-center gap-1">{payoutAmt} {currLabel}</span>;

  useEffect(() => {
    if (!socket) return;

    socket.on('coin_flip_queue_joined', ({ side: s }) => {
      setPhase('queue');
      setStatusMsg(`Waiting for someone to pick ${s === 'heads' ? 'Tails' : 'Heads'}…`);
    });

    socket.on('coin_flip_match_found', ({ opponent, entryFee: fee, currency: cur }) => {
      inActiveMatchRef.current = true;
      setFlipResult(null);
      setResultLanded(false);
      rotRef.current = 0;
      setStatusMsg(`vs ${opponent.username}`);
      setCountdown(3);
      playMatchFound();
      setPhase('countdown');
      if ((fee ?? 0) > 0) {
        const isDiamonds = (cur ?? 'coins') === 'diamonds';
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) - fee) }
          : { c_coins: Math.max(0, (profileRef.current?.c_coins ?? 0) - fee) }
        );
        refreshProfile();
      }
      fxTimersRef.current.push(
        setTimeout(() => { setCountdown(2); playCountdown(); }, 1000),
        setTimeout(() => { setCountdown(1); playCountdown(); }, 2000),
        setTimeout(() => { setCountdown(0); playGo(); setPhase('flipping'); }, 3000),
      );
    });

    socket.on('match_cancelled', ({ message }) => {
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled. Please try again.');
    });

    socket.on('coin_flip_result', (data) => {
      if (!inActiveMatchRef.current) return; // stale event after leaving — ignore
      inActiveMatchRef.current = false;
      pendingResultRef.current = data;
      setFlipResult(data.result);
      landCoin(data.result);

      // After transition completes show label for 2s, then result screen
      fxTimersRef.current.push(setTimeout(() => { setResultLanded(true); playCoinLand(); }, 4200));
      fxTimersRef.current.push(setTimeout(() => {
        const res = pendingResultRef.current;
        const myId = profileRef.current?.id;
        const isWin = res.winnerId === myId;
        const payout = res.balanceChange?.winnerPayout;
        if (payout != null && isWin) {
          const isDiamonds = res.currency === 'diamonds';
          updateProfile(isDiamonds
            ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) + payout) }
            : { c_coins: Math.max(0, (profileRef.current?.c_coins ?? 0) + payout) }
          );
        }
        setResultData(res);
        setPhase('result');
        refreshProfile();
      }, 6200));
    });

    socket.on('opponent_disconnected', (data = {}) => {
      if (!inActiveMatchRef.current) return; // stale event — ignore
      inActiveMatchRef.current = false;
      const myId = profileRef.current?.id;
      const isWin = data.winnerId === myId;
      const payout = data.winnerPayout ?? null;
      if (payout != null && isWin) {
        const isDiamonds = data.currency === 'diamonds';
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) + payout) }
          : { c_coins: Math.max(0, (profileRef.current?.c_coins ?? 0) + payout) }
        );
      }
      // Use server-provided ELO values to compute accurate delta (avoids stale eloBeforeRef)
      if (data.newWinnerElo != null) eloBeforeRef.current = isWin ? data.newWinnerElo - 25 : data.newLoserElo + 25;
      setResultData({
        winnerId:       data.winnerId,
        loserId:        data.loserId,
        winnerUsername: isWin ? profileRef.current?.username : data.winnerUsername,
        loserUsername:  isWin ? data.loserUsername : profileRef.current?.username,
        disconnected:   true,
        balanceChange:  payout != null ? { winnerPayout: isWin ? payout : 0 } : undefined,
        entryFee:       data.entryFee,
        currency:       data.currency,
        newWinnerElo:   data.newWinnerElo,
        newLoserElo:    data.newLoserElo,
      });
      setPhase('result');
      refreshProfile();
    });

    socket.on('invite_sent', ({ friendUsername }) => {
      setPrivateCode(''); setInvitedFriend(friendUsername || 'your friend'); setPrivateMode(null); setStatusMsg(''); setPhase('private_waiting');
    });
    socket.on('invite_declined', ({ byUsername }) => {
      setInvitedFriend(null); setStatusMsg(`${byUsername || 'They'} declined your invite.`); setPhase('lobby');
    });
    socket.on('invite_expired', () => {
      setInvitedFriend(null); setStatusMsg('Invite expired — no response.'); setPhase('lobby');
    });
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code); setInvitedFriend(null); setPhase('private_waiting');
    });
    socket.on('private_room_error', ({ message }) => { setStatusMsg(message); setPhase('lobby'); });
    socket.on('error', ({ message }) => { setStatusMsg(message); setPhase('lobby'); });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      socket.off('coin_flip_queue_joined');
      socket.off('coin_flip_match_found');
      socket.off('match_cancelled');
      socket.off('coin_flip_result');
      socket.off('opponent_disconnected');
      socket.off('private_room_created');
      socket.off('private_room_error');
      socket.off('invite_sent'); socket.off('invite_declined'); socket.off('invite_expired');
      socket.off('error');
    };
  }, [socket, landCoin, refreshProfile]);

  // Auto-queue when navigated here from Quick Match
  useEffect(() => {
    if (!location.state?.autoQueue) return;
    if (!socket || !authenticated || !session) return;
    if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency);
    setTimeout(() => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      lastModeRef.current = 'pvp';
      const fee = location.state?.entryFee ?? entryFee;
      lastSettingsRef.current = { entryFee: fee, currency: betCurrency, side };
      socket.emit('join_coin_flip_queue', { entryFee: fee, currency: betCurrency === 'diamonds' ? 'diamonds' : 'coins', side });
      setPhase('queue');
    }, 300);
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-join a private room from an accepted friend invite.
  useEffect(() => {
    if (!location.state?.autoJoin || !location.state?.joinCode) return;
    if (!socket || !authenticated || !session) return;
    const code = location.state.joinCode;
    window.history.replaceState({}, '');
    setTimeout(() => joinPrivate(code), 300);
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  function joinQueue() {
    if (!session) { navigate('/login'); return; }
    if (!authenticated || insufficient) return;
    eloBeforeRef.current = profile?.elo ?? 1000;
    lastModeRef.current = 'pvp';
    lastSettingsRef.current = { entryFee, currency: betCurrency, side };
    socket.emit('join_coin_flip_queue', { entryFee, currency: betCurrency === 'diamonds' ? 'diamonds' : 'coins', side });
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
    setStatusMsg('vs Duely Bot');
    // Show countdown — coin_flip_match_found will transition to 'flipping' after 3s
    setCountdown(3);
    setPhase('countdown');
  }

  function leaveQueue() {
    socket?.emit('leave_coin_flip_queue');
    stopCoinFx();
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
    setPhase('lobby'); setPrivateCode(''); setInvitedFriend(null); setStatusMsg('');
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

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>

      {/* ── RESULT ── */}
      {phase === 'result' && resultData && (() => {
        const isWinner = resultData.winnerId === profile?.id;
        return (
          <div className="w-full flex items-center justify-center" style={{ minHeight: 'calc(100vh - 56px)' }}>
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
              disconnected={resultData.disconnected}
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
      })()}

      <div className="w-full max-w-md animate-slide-up">

        {phase === 'lobby' && (
          <div className="text-center mb-6">
            <h1 className="text-5xl font-black text-white mb-2">🟡 Coin Flip</h1>
            <p className="text-muted text-base">Pick a side — get matched with the opposite</p>
          </div>
        )}

        {/* Countdown phase */}
        {phase === 'countdown' && (
          <div className="text-center animate-fade-in mb-6">
            <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>
              {countdown}
            </div>
            <p className="text-muted">Get ready…</p>
            {statusMsg && <p className="text-xs text-muted mt-2">{statusMsg}</p>}
          </div>
        )}

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
                style={{ textShadow: '0 0 20px rgba(18,80,180,0.9)', animation: 'none' }}
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
          <div className="text-center animate-fade-in">
            <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
            <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
            <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
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
              <BetSlider fees={fees} entryFee={entryFee} setEntryFee={setEntryFee} currLabel={currLabel} isDiamonds={isDiamonds} payoutMult={0.98} />
              {(playerCounts?.['coin-flip'] ?? 0) > 0 && (
                <div className="flex items-center gap-1.5 mt-3">
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4' }} />
                  <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{playerCounts['coin-flip']} playing</span>
                </div>
              )}
              {(() => { const n = betCounts?.[`coin-flip:${entryFee}:${betCurrency}`] || 0; return n > 0 ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4' }} />
                  <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{n} at this bet</span>
                </div>
              ) : null; })()}
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
              {!session ? (
                <GlowButton onClick={() => navigate('/login')} variant="primary" size="lg" className="w-full text-lg py-4">
                  🔒 Login to Play
                </GlowButton>
              ) : (
              <>
              <GlowButton onClick={joinQueue} variant="primary" size="lg" className="w-full text-lg py-4" disabled={session && (!authenticated || insufficient)}>
                {!session ? '🔒 Login to Play' : `Find Opponent (${side === 'heads' ? '🔵 Heads' : '⚪ Tails'})`}
              </GlowButton>
              <GlowButton onClick={() => setPrivateMode('create')} variant="ghost" size="lg" className="w-full text-lg py-4 border border-border hover:border-primary">
                🎮 Challenge a Friend
              </GlowButton>
              <>
                  {/* Secondary options as quiet text links — no button clutter */}
                  <div className="flex items-center justify-center gap-3 text-sm text-muted pt-1">
                    {isDiamonds && (
                      <>
                        <button onClick={() => playVsBot(false)} disabled={!authenticated || insufficient} className="hover:text-white transition-colors disabled:opacity-40">
                          Bet vs Bot — {fmtFee(entryFee)} 💎
                        </button>
                        <span className="opacity-40">·</span>
                      </>
                    )}
                    <button onClick={() => playVsBot(true)} disabled={!authenticated} className="hover:text-white transition-colors disabled:opacity-40">
                      Play vs Bot
                    </button>
                    <span className="opacity-40">·</span>
                    <button onClick={() => setPrivateMode('join')} className="hover:text-white transition-colors">
                      Have a code?
                    </button>
                  </div>
                  <CreateRoomModal
                    open={privateMode === 'create'}
                    onClose={() => setPrivateMode(null)}
                    gameType="coin-flip"
                    entryFee={entryFee}
                    currency={betCurrency}
                    onCreateCode={createPrivate}
                  />
                  <JoinRoomModal
                    open={privateMode === 'join'}
                    onClose={() => setPrivateMode(null)}
                    onJoin={(code) => joinPrivate(code)}
                    authenticated={authenticated}
                  />
                </>
              </>
              )}
            </div>
          </>
        )}

        {/* Private waiting */}
        {phase === 'private_waiting' && (
          <div className="text-center animate-fade-in">
            <div className="text-5xl mb-4">🔒</div>
            {invitedFriend ? (
              <>
                <h2 className="text-2xl font-black text-white mb-2">Invite Sent</h2>
                <div className="w-14 h-14 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto my-6" />
                <p className="text-muted text-sm mb-6">Waiting for <span className="text-white font-bold">{invitedFriend}</span> to accept…</p>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-black text-white mb-2">Challenge Ready</h2>
                <ChallengeLinkBox code={privateCode} gameType="coin-flip" />
                <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
              </>
            )}
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
