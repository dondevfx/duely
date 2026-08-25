import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { playMatchFound, playCountdown, playGo, playCoinFlip, playCoinLand, stopAllSounds } from '../utils/sound';
import { holdBalance } from '../utils/balanceHold';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import { COIN_FEES, DIAMOND_FEES, SMALL_BTN } from '../components/GameLobby';
import BetSlider from '../components/BetSlider';
import ResultScreen from '../components/ResultScreen';
import GameHelp from '../components/GameHelp';
import GlowButton from '../components/GlowButton';
import { topUpRoute, topUpLabel } from '../utils/topUpRoute';
import CreateRoomModal from '../components/CreateRoomModal';
import JoinRoomModal from '../components/JoinRoomModal';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
import PrivateWaiting from '../components/PrivateWaiting';
import { usePageReady } from '../hooks/usePageReady';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { useGameScrollLock } from '../hooks/useGameScrollLock';
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
  // Forfeit on every way out of the page — refresh, tab close, in-app
  // navigation — but NOT on an app switch. See useLeaveGuard.
  useLeaveGuard(socket);

  useEffect(() => () => {
    stopCoinFx();   // no scheduled sound outlives the page
    setTimeout(() => refreshProfileRef.current?.(), 2500);
  }, []);
  // Refresh balance on mount; delayed second call catches server settle that races with reload
  useEffect(() => {
    refreshProfile();
    const t = setTimeout(refreshProfile, 2500);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [phase, setPhase] = useState('lobby');
  // Pin the page for the countdown and the match itself: start at the top,
  // and no scrolling the board off-screen while it is being played.
  useGameScrollLock(phase === 'countdown' || phase === 'flipping');
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
  const releaseBalanceRef = useRef(null);

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
  // Falls back to 0, silently, when entryFee is not actually one of this
  // currency's fees — which only clamps what the SLIDER shows. Nothing here
  // corrected entryFee itself, so the Bet-vs-Bot label a few lines down
  // (which reads entryFee directly, not fees[sliderIdx]) could show a number
  // the slider disagreed with — "1 💎" was a leftover coin-tier value from
  // location.state, initialised once on mount, never re-checked against the
  // currency actually in effect. betCurrency is read from CurrencyContext,
  // shared across every game, so it can already have changed by the time
  // this page mounts, or change later from a source this page never asked
  // for. GameLobby.jsx guards this exact case for its own bot button; this
  // page has the identical button rendered separately and needs the same
  // guard, not a shared one, since neither page uses the other's copy.
  const sliderIdx = Math.max(0, fees.indexOf(entryFee));

  // Corrects entryFee itself, not just where the slider points — on mount
  // (location.state can seed a fee from the wrong currency's tier list) and
  // whenever betCurrency changes for any reason, including one this page did
  // not initiate itself.
  useEffect(() => {
    if (!fees.includes(entryFee)) setEntryFee(fees[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betCurrency]);

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
        setTimeout(() => {
          setCountdown(0); playGo(); setPhase('flipping');
          // Hold from the moment the coin leaves the hand.
          //
          // The hold used to start when coin_flip_result arrived — but the
          // server settles the match BEFORE it emits that, and settling fires
          // balance_changed first. So the refresh that gives the result away
          // was already in flight before anything was holding it back. Taking
          // the hold as the flip begins closes that window.
          releaseBalanceRef.current?.();
          releaseBalanceRef.current = holdBalance();
        }, 3000),
      );
    });

    socket.on('match_cancelled', ({ message }) => {
      // The entry fee is deducted optimistically when a match is found, but a
      // cancellation means it was never actually taken — pull the real balance
      // so the player is not left looking at money that did not move.
      refreshProfile();
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled. Please try again.');
    });

    socket.on('coin_flip_result', (data) => {
      if (!inActiveMatchRef.current) return; // stale event after leaving — ignore
      inActiveMatchRef.current = false;
      pendingResultRef.current = data;
      setFlipResult(data.result);
      landCoin(data.result);

      // The server has already settled the money. Hold only the DISPLAY until
      // the coin lands, or the navbar balance changes mid-spin and gives the
      // result away before the animation does.
      //
      // Normally the flip already took a hold (see the countdown above); this
      // re-takes it so a result arriving without one — a rejoin, or a flip that
      // resolves before the countdown finishes — is still covered.
      if (!releaseBalanceRef.current) releaseBalanceRef.current = holdBalance();

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
        releaseBalanceRef.current?.();
        releaseBalanceRef.current = null;
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
      // Pre-match ELO comes from the profile snapshot taken when the match
      // started, not from the result. ELO changes are a random 20-23 on a win
      // and 17-20 on a loss, so subtracting a fixed 25 here would report a
      // delta that never matches what actually happened.
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
      // Leaving mid-flip must not strand the hold, or the displayed balance
      // stops updating everywhere until the safety timer expires.
      releaseBalanceRef.current?.();
      releaseBalanceRef.current = null;
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

  // Redeem an accepted invite.
  //
  // Keyed on the CODE and on location.key, not on a fire-once ref with only
  // [socket, authenticated] deps. Accepting an invite while already sitting on
  // that game's page is a route update, not a remount — neither dep changes, so
  // the effect never re-ran and the code was never redeemed. It looked like the
  // Accept button did nothing, and it was most visible on whichever game you
  // happened to be viewing when the invite arrived.
  const _lastJoinCode = useRef(null);
  useEffect(() => {
    const code = location.state?.joinCode;
    if (!location.state?.autoJoin || !code) return;
    if (!socket || !authenticated) return;
    if (_lastJoinCode.current === code) return;
    _lastJoinCode.current = code;
    window.history.replaceState({}, '');   // don't re-join on refresh
    setTimeout(() => joinPrivate(code), 300);
  }, [socket, authenticated, location.key]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // This path skips the countdown and starts spinning immediately, so it
      // takes its own hold — a bot flip settles and gives the result away just
      // as readily as a PvP one.
      releaseBalanceRef.current?.();
      releaseBalanceRef.current = holdBalance();
      setStatusMsg('vs Duely Bot');
    } else {
      setPhase('lobby');
    }
  }

  return (
    <div className="relative min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-3 sm:px-4 py-0 sm:py-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>

      {/* The help button belongs to the PAGE, not to the flipping block. Nested
          inside that block it anchored to a box a few hundred pixels wide in
          the middle of the screen, and floated there next to the coin. */}
      {phase === 'flipping' && <GameHelp gameType="coin-flip" placement="top-left" />}

      {/* ── RESULT ── */}
      {phase === 'result' && resultData && (() => {
        const isWinner = resultData.winnerId === profile?.id;
        return (
          <div className="w-full flex items-center justify-center" style={{ minHeight: 'calc(100vh - 56px)' }}>
            <ResultScreen
              vsBot={!!resultData?.vsBot}
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
          <div className="text-center mb-1 sm:mb-6">
            <h1 className="text-4xl sm:text-6xl font-black text-white mb-0.5 sm:mb-2 leading-tight">🟡 Coin Flip</h1>
            <p className="text-center text-muted text-sm sm:text-base leading-snug sm:leading-relaxed px-2">Pick heads or tails — you get matched with someone on the opposite side. One flip decides it.</p>
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
          <div className="relative mb-6 text-center">
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
            <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl p-2.5 sm:p-5">
              <div className="flex items-center justify-between mb-1.5 sm:mb-4">
                <span className="text-base font-bold text-white">Entry Fee</span>
                <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
                  <button onClick={() => switchCurrency('coins')} className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}><CoinIcon size="0.85em" /> Coins</button>
                  <button onClick={() => switchCurrency('diamonds')} className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}>💎 Diamonds</button>
                </div>
              </div>
              <BetSlider fees={fees} entryFee={entryFee} setEntryFee={setEntryFee} currLabel={currLabel} isDiamonds={isDiamonds} payoutMult={0.98} />
              {(playerCounts?.['coin-flip'] ?? 0) > 0 && (
                <div className="flex items-center gap-1.5 mt-1 sm:mt-3">
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4' }} />
                  <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{playerCounts['coin-flip']} playing</span>
                </div>
              )}
              {(() => { const n = betCounts?.[`coin-flip:${entryFee}:${betCurrency}`] || 0; return n > 0 ? (
                <div className="flex items-center gap-1.5 mt-0.5 sm:mt-1">
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4' }} />
                  <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{n} at this bet</span>
                </div>
              ) : null; })()}
            </div>

            {/* Desktop values are trimmed so the whole betting screen clears a
                1080p viewport without scrolling. Only the sm: side moves —
                mobile spacing is unchanged. */}
            <div className="mb-1.5 sm:mb-3 bg-surface border border-border rounded-2xl p-2 sm:p-3">
              <p className="hidden sm:block text-sm font-bold text-white mb-2">Pick Your Side</p>
              <div className="grid grid-cols-2 gap-1.5 sm:gap-2.5">
                {['heads', 'tails'].map(s => (
                  <button key={s} onClick={() => setSide(s)}
                    className={`py-4 sm:py-3 rounded-xl text-center font-black border-2 transition-all ${
                      side === s ? 'border-primary bg-primary/20 text-white' : 'border-border text-muted hover:border-primary/50 hover:text-white'
                    }`}>
                    {/* Mobile sizes only. The sm: values stay where they were
                        tuned to fit the lobby on a 1080p viewport. */}
                    <div className="text-xl sm:text-xl mb-0.5 sm:mb-0.5">{s === 'heads' ? '🔵' : '⚪'}</div>
                    <div className="capitalize text-[13px] sm:text-sm leading-none">{s}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:gap-3">
              {!session ? (
                <GlowButton onClick={() => navigate('/login')} variant="primary" size="lg" className="w-full text-lg py-4 border border-transparent">
                  🔒 Login to Play
                </GlowButton>
              ) : (
              <>
              <GlowButton onClick={insufficient ? () => navigate(topUpRoute(betCurrency)) : joinQueue} variant="primary" size="lg" className="w-full text-lg py-4 border border-transparent" disabled={session && !authenticated}>
                {!session ? '🔒 Login to Play'
                  : insufficient ? topUpLabel(betCurrency)
                  : `Find Opponent (${side === 'heads' ? '🔵 Heads' : '⚪ Tails'})`}
              </GlowButton>
              <>
                  {/* Secondary options — small buttons, still visible but not competing.
                      Challenge a Friend is one of them: it starts a match the
                      same way the others do, so it is sized like them rather
                      than like the one primary action above. */}
                  <div className="flex flex-col gap-2 pt-1">
                    <button onClick={() => setPrivateMode('create')} className={SMALL_BTN}>
                      🎮 Challenge a Friend
                    </button>
                    {/* Diamond bet-vs-bot gets its own full-width row — too long to share */}
                    {isDiamonds && (
                      <button onClick={() => playVsBot(false)} disabled={!authenticated || insufficient} className={SMALL_BTN}>
                        Bet vs Bot — {fmtFee(entryFee)} 💎
                      </button>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => playVsBot(true)} disabled={!authenticated} className={SMALL_BTN}>
                        Play vs Bot
                      </button>
                      <button onClick={() => setPrivateMode('join')} className={SMALL_BTN}>
                        Join Game
                      </button>
                    </div>
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
          <PrivateWaiting
            inline
            invitedFriend={invitedFriend}
            code={privateCode}
            gameType="coin-flip"
            onCancel={cancelPrivate}
          />
        )}

        {statusMsg && phase === 'lobby' && (
          <p className="text-center text-sm text-warning mt-3">{statusMsg}</p>
        )}
      </div>
    </div>
  );
}
