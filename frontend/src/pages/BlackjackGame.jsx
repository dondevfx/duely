import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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

const RED_SUITS = new Set(['♥', '♦']);

// Mirror of the backend hand-scoring logic
function calcScore(hand) {
  if (!hand || !hand.length) return 0;
  let score = 0, aces = 0;
  for (const c of hand) {
    if (['J','Q','K'].includes(c.value)) score += 10;
    else if (c.value === 'A') { score += 11; aces++; }
    else score += parseInt(c.value);
  }
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}

// Responsive card size — bigger on desktop, compact on mobile
const CARD_W = typeof window !== 'undefined' ? Math.min(90, Math.floor((window.innerWidth - 48) / 4)) : 90;
const CARD_H = Math.round(CARD_W * 1.44);

const CARD_DEAL_CSS = `
@keyframes dealIn {
  from { opacity: 0; transform: translateY(-60px) scale(0.7) rotate(-8deg); }
  to   { opacity: 1; transform: translateY(0)    scale(1)   rotate(0deg);  }
}
.bj-hit-btn:not(:disabled):hover {
  box-shadow: 0 0 0 2px rgba(30,144,255,0.6), 0 6px 24px rgba(30,144,255,0.55) !important;
  filter: brightness(1.12);
}
.bj-stand-btn:not(:disabled):hover {
  border-color: rgba(255,255,255,0.7) !important;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.25), 0 4px 20px rgba(255,255,255,0.18) !important;
  color: #fff !important;
}
.bj-split-btn:not(:disabled):hover {
  box-shadow: 0 0 0 2px rgba(245,158,11,0.6), 0 6px 24px rgba(245,158,11,0.5) !important;
  filter: brightness(1.12);
}
`;

function CardFace({ card, faceDown = false }) {
  if (faceDown) {
    return (
      <div style={{
        width: CARD_W, height: CARD_H, borderRadius: 13,
        background: 'linear-gradient(140deg, #1e3a7a 0%, #0d2050 100%)',
        border: '2px solid rgba(255,255,255,0.15)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: 62, height: 90, borderRadius: 6,
          border: '1.5px solid rgba(255,255,255,0.2)',
          background: 'repeating-linear-gradient(45deg,rgba(255,255,255,0.05) 0,rgba(255,255,255,0.05) 3px,transparent 3px,transparent 10px)',
        }} />
      </div>
    );
  }
  if (!card) return null;
  const isRed = RED_SUITS.has(card.suit);
  const color = isRed ? '#dc2626' : '#111';
  return (
    <div style={{
      width: CARD_W, height: CARD_H, borderRadius: 13,
      background: '#ffffff', border: '1.5px solid #bbb',
      boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
      display: 'flex', flexDirection: 'column',
      padding: '6px 8px', fontFamily: 'Georgia, serif',
      userSelect: 'none', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
        <span style={{ color, fontWeight: 900, fontSize: card.value.length > 1 ? Math.round(CARD_W*0.17) : Math.round(CARD_W*0.21), letterSpacing: card.value.length > 1 ? -1 : 0 }}>{card.value}</span>
        <span style={{ color, fontSize: Math.round(CARD_W*0.18) }}>{card.suit}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color, fontSize: Math.round(CARD_W*0.32), opacity: 0.75 }}>{card.suit}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05, alignSelf: 'flex-end', transform: 'rotate(180deg)' }}>
        <span style={{ color, fontWeight: 900, fontSize: card.value.length > 1 ? Math.round(CARD_W*0.17) : Math.round(CARD_W*0.21), letterSpacing: card.value.length > 1 ? -1 : 0 }}>{card.value}</span>
        <span style={{ color, fontSize: Math.round(CARD_W*0.18) }}>{card.suit}</span>
      </div>
    </div>
  );
}

// Wrapper that adds deal-in animation
function Card({ card, faceDown = false, dealIndex = null }) {
  const anim = dealIndex !== null
    ? { animation: `dealIn 0.38s ${dealIndex * 0.13}s cubic-bezier(0.22,1,0.36,1) both` }
    : {};
  return (
    <div style={{ flexShrink: 0, ...anim }}>
      <CardFace card={card} faceDown={faceDown} />
    </div>
  );
}

// Card that flips from face-down to face-up
function FlipCard({ card, flipped, flipDelay = 0 }) {
  return (
    <div style={{ width: CARD_W, height: CARD_H, perspective: 700, flexShrink: 0 }}>
      <div style={{
        width: '100%', height: '100%',
        transformStyle: 'preserve-3d',
        transition: `transform 0.55s ${flipDelay}s ease`,
        transform: flipped ? 'rotateY(0deg)' : 'rotateY(180deg)',
      }}>
        {/* Front face (face-up) */}
        <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden' }}>
          <CardFace card={card} />
        </div>
        {/* Back face (face-down) */}
        <div style={{ position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
          <CardFace faceDown />
        </div>
      </div>
    </div>
  );
}

function ScoreBadge({ score, bust, stood, isLight = false }) {
  if (score == null) return null;
  const isBust = bust || score > 21;
  const is21 = score === 21;
  const neutralBg = isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.1)';
  const neutralColor = isLight ? '#111' : '#fff';
  const neutralBorder = isLight ? '1px solid rgba(0,0,0,0.15)' : '1px solid rgba(255,255,255,0.15)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '5px 14px', borderRadius: 20,
      fontWeight: 900, fontSize: 20,
      background: isBust ? 'rgba(239,68,68,0.2)' : is21 ? 'rgba(251,191,36,0.2)' : neutralBg,
      color: isBust ? '#f87171' : is21 ? '#fbbf24' : neutralColor,
      border: isBust ? '1px solid rgba(239,68,68,0.4)' : is21 ? '1px solid rgba(251,191,36,0.4)' : neutralBorder,
      textShadow: isBust ? '0 0 10px rgba(239,68,68,0.5)' : is21 ? '0 0 10px rgba(251,191,36,0.5)' : 'none',
    }}>
      {isBust ? `Bust (${score})` : stood ? `${score} — Stood` : score}
    </span>
  );
}

export default function BlackjackGame() {
  const ready = usePageReady();
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, session, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, playerCounts, betCounts } = useSocket();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const eloBeforeRef    = useRef(profile?.elo ?? 1000);
  const lastModeRef     = useRef(null); // 'pvp' | 'bot_free' | 'bot_paid'
  const lastSettingsRef = useRef({ entryFee: 0, currency: 'coins' });
  const socketRef         = useRef(socket);
  const profileRef        = useRef(profile);
  const refreshProfileRef = useRef(refreshProfile);
  const pendingStartRef   = useRef(null); // buffers bj_start data until countdown finishes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { refreshProfileRef.current = refreshProfile; }, [refreshProfile]);

  const [phase, _setPhase] = useState('lobby');
  const phaseRef = useRef('lobby');
  function setPhase(p) { phaseRef.current = p; _setPhase(p); }

  // Tracks whether we are in an active room (set on match_found, cleared on result/reset)
  const roomIdRef = useRef(null);

  // Forfeit on unmount and on page refresh/close; also refresh balance so leaver sees updated balance
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (socketRef.current?.connected) socketRef.current.emit('player_forfeit');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
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
  const [privateCode, setPrivateCode] = useState('');
  const [privateMode, setPrivateMode] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [entryFee, setEntryFee] = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [statusMsg, setStatusMsg] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [countdown, setCountdown] = useState(0); // visual countdown only — does not change phase

  const [opponentUsername, setOpponentUsername] = useState('');
  const [myHand, setMyHand] = useState([]);
  const [myScore, setMyScore] = useState(0);
  const [opponentHandSize, setOpponentHandSize] = useState(2);
  const [oppHand, setOppHand] = useState([]);      // opponent's visible cards (initial + unlocked hits)
  const myHitCountRef  = useRef(0);                // how many times I have hit
  const oppBufferedRef = useRef([]);               // opponent hit cards received but not yet revealed
  const oppRevealedRef = useRef(0);                // how many buffered opp cards have been shown
  const [stood, setStood] = useState(false);
  const [bust, setBust] = useState(false);
  const [timeLeft, setTimeLeft] = useState(20);
  const [resultData, setResultData] = useState(null);
  const [revealData, setRevealData] = useState(null);
  const timerRef = useRef(null);

  // Split state
  const [splitData, setSplitData] = useState(null);
  // splitData: { hand1: cards[], score1: n, hand2: cards[], score2: n, activeHand: 1|2 } | null
  const [oppHasSplit, setOppHasSplit] = useState(false);

  // Animation state
  const [dealRevision, setDealRevision] = useState(0); // bumped on each deal event — triggers deal animation
  const [newCardIdx, setNewCardIdx] = useState(null);  // index of just-hit card
  const [flippingOpp, setFlippingOpp] = useState(false); // triggers FlipCard flip
  const prevHandLenRef = useRef(0);

  // Countdown tick — when it hits 0, apply any buffered bj_start and go to 'playing'
  useEffect(() => {
    if (countdown <= 0) {
      if (pendingStartRef.current && phaseRef.current !== 'result') {
        const d = pendingStartRef.current;
        pendingStartRef.current = null;
        prevHandLenRef.current = 0;
        myHitCountRef.current  = 0;
        oppBufferedRef.current = [];
        oppRevealedRef.current = 0;
        setMyHand(d.hand);
        setMyScore(d.handScore);
        setOpponentHandSize(d.oppSz);
        setOppHand(d.opponentHand ?? []);
        setStood(false); setBust(false); setFlippingOpp(false);
        setNewCardIdx(null); setSplitData(null); setOppHasSplit(false);
        setDealRevision(r => r + 1);
        prevHandLenRef.current = d.hand.length;
        setPhase('playing');
        setTimeLeft(d.timeLimit || 20);
      }
      return;
    }
    const id = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDiamonds = betCurrency === 'diamonds';
  const fees = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const sliderIdx = Math.max(0, fees.indexOf(entryFee));

  const payoutAmt = isDiamonds
    ? `${(entryFee * 2).toLocaleString()}`
    : `${(entryFee * 2 * 0.95) % 1 === 0 ? (entryFee * 2 * 0.95).toLocaleString() : (entryFee * 2 * 0.95).toFixed(2)}`;
  const payout = <span className="inline-flex items-center gap-1">{payoutAmt} {currLabel}</span>;

  function switchCurrency(cur) {
    setBetCurrency(cur);
    const newFees = cur === 'diamonds' ? DIAMOND_FEES : COIN_FEES;
    setEntryFee(newFees[0]);
  }

  useEffect(() => {
    if (!socket) return;

    socket.on('bj_queue_joined', () => {
      setPhase('queue');
      setStatusMsg('Waiting for opponent…');
    });

    socket.on('bj_match_found', ({ roomId: rid, opponent, entryFee: fee, currency: cur }) => {
      roomIdRef.current = rid;
      pendingStartRef.current = null;
      setRoomId(rid);
      setOpponentUsername(opponent.username);
      setCountdown(3); // triggers countdown → game starts when countdown hits 0
      if ((fee ?? 0) > 0) {
        const isDiamonds = (cur ?? 'coins') === 'diamonds';
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) - fee) }
          : { c_coins: Math.max(0, (profileRef.current?.c_coins ?? 0) - fee) }
        );
        refreshProfile();
      }
    });

    socket.on('match_cancelled', ({ message }) => {
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled. Please try again.');
    });

    socket.on('bj_start', ({ hand, handScore, opponentHand, opponentHandSize: oppSz, timeLimit }) => {
      // Buffer the start data — countdown useEffect will apply it when it reaches 0
      pendingStartRef.current = { hand, handScore, opponentHand, oppSz, timeLimit };
    });

    socket.on('bj_opp_card', ({ card }) => {
      oppBufferedRef.current.push(card);
      // Reveal immediately only if I've already hit at least as many times
      if (myHitCountRef.current >= oppBufferedRef.current.length) {
        oppRevealedRef.current = oppBufferedRef.current.length;
        setOppHand(prev => [...prev, card]);
      }
    });

    socket.on('bj_card', ({ hand, score }) => {
      myHitCountRef.current++;
      // Reveal one buffered opponent card if available
      if (oppBufferedRef.current.length > oppRevealedRef.current) {
        const cardToReveal = oppBufferedRef.current[oppRevealedRef.current];
        oppRevealedRef.current++;
        setOppHand(prev => [...prev, cardToReveal]);
      }
      setNewCardIdx(hand.length - 1);
      setMyHand(hand);
      setMyScore(score);
      prevHandLenRef.current = hand.length;
      // Also update split tracking if active
      setSplitData(d => {
        if (!d) return d;
        if (d.activeHand === 1) return { ...d, hand1: hand, score1: score };
        return { ...d, hand2: hand, score2: score };
      });
      setTimeout(() => setNewCardIdx(null), 600);
    });

    socket.on('bj_bust', ({ score } = {}) => {
      setBust(true);
      // If no split active or on final hand, mark stood to stop timer
      // If on split hand1, bj_split_hand2 will arrive and reset bust/stood
      setSplitData(cur => {
        const onHand1WithSplit = cur && cur.activeHand === 1;
        if (!onHand1WithSplit) setStood(true);
        return cur;
      });
    });

    socket.on('bj_stood', () => {
      setStood(true);
    });

    // Split events
    socket.on('bj_split', ({ hand1, score1, hand2, score2 }) => {
      setSplitData({ hand1, score1, hand2, score2, activeHand: 1 });
      setMyHand(hand1);
      setMyScore(score1);
      setBust(false);
      setStood(false);
      setNewCardIdx(null);
    });

    socket.on('bj_split_hand2', ({ hand, score }) => {
      setSplitData(d => d ? { ...d, hand2: hand, score2: score, activeHand: 2 } : d);
      setMyHand(hand);
      setMyScore(score);
      setBust(false);
      setStood(false);
      setNewCardIdx(null);
    });

    socket.on('bj_opp_split', () => {
      setOppHasSplit(true);
    });

    socket.on('bj_result', (data) => {
      if (!roomIdRef.current) return; // stale event after leaving — ignore
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setRevealData(data);
      setPhase('reveal');
      const myId = profileRef.current?.id;
      const isWin = data.winnerId === myId;
      const payout = data.balanceChange?.winnerPayout ?? data.winnerPayout;
      if (payout != null && isWin) {
        const isDiamonds = data.currency === 'diamonds';
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) + payout) }
          : { c_coins: Math.max(0, (profileRef.current?.c_coins ?? 0) + payout) }
        );
      }
      refreshProfile();
      // Brief pause then flip opponent cards
      setTimeout(() => setFlippingOpp(true), 150);
      setTimeout(() => {
        roomIdRef.current = null;
        setResultData(data);
        setPhase('result');
      }, 3500);
    });

    socket.on('opponent_disconnected', (data = {}) => {
      if (!roomIdRef.current) return; // stale event after leaving — ignore
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      pendingStartRef.current = null; // cancel any buffered start so countdown doesn't overwrite result
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
        winnerUsername: isWin ? profile?.username : data.winnerUsername,
        loserUsername:  isWin ? data.loserUsername : profile?.username,
        disconnected:   true,
        balanceChange:  payout != null ? { winnerPayout: isWin ? payout : 0 } : undefined,
        entryFee:       data.entryFee,
        currency:       data.currency,
        newWinnerElo:   data.newWinnerElo,
        newLoserElo:    data.newLoserElo,
      });
      roomIdRef.current = null;
      setPhase('result');
      refreshProfile();
    });

    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code); setPhase('private_waiting');
    });

    socket.on('private_room_error', ({ message }) => {
      setStatusMsg(message); setPhase('lobby');
    });

    socket.on('error', ({ message }) => {
      setStatusMsg(message); setPhase('lobby');
    });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      socket.off('bj_queue_joined'); socket.off('bj_match_found'); socket.off('match_cancelled');
      socket.off('bj_start'); socket.off('bj_card'); socket.off('bj_opp_card');
      socket.off('bj_bust'); socket.off('bj_stood');
      socket.off('bj_split'); socket.off('bj_split_hand2'); socket.off('bj_opp_split');
      socket.off('bj_result');
      socket.off('opponent_disconnected');
      socket.off('private_room_created'); socket.off('private_room_error');
      socket.off('error');
    };
  }, [socket]);

  useEffect(() => {
    if (phase !== 'playing' || stood) return;
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { clearInterval(timerRef.current); timerRef.current = null; return 0; }
        return t - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, stood]);

  // Auto-queue when navigated here from Quick Match
  useEffect(() => {
    if (!location.state?.autoQueue) return;
    if (!socket || !authenticated || !session) return;
    if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency);
    setTimeout(() => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      lastModeRef.current = 'pvp';
      const fee = location.state?.entryFee ?? entryFee;
      const cur = location.state?.betCurrency ?? betCurrency;
      lastSettingsRef.current = { entryFee: fee, currency: cur };
      socket.emit('join_bj_queue', { entryFee: fee, currency: cur });
      setPhase('queue');
    }, 300);
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  function joinQueue() {
    if (!session) { navigate('/login'); return; }
    if (!authenticated || insufficient) return;
    eloBeforeRef.current = profile?.elo ?? 1000;
    lastModeRef.current = 'pvp';
    lastSettingsRef.current = { entryFee, currency: betCurrency };
    setPhase('queue'); // go to queue phase immediately so countdown renders as soon as match_found fires
    socket.emit('join_bj_queue', { entryFee, currency: betCurrency });
  }

  function playVsBot(free = false) {
    if (!session) { navigate('/login'); return; }
    if (!authenticated) return;
    if (phaseRef.current !== 'lobby') return; // prevent double-click / multiple games
    eloBeforeRef.current = profile?.elo ?? 1000;
    const fee = free ? 0 : entryFee;
    const cur = free ? 'coins' : betCurrency;
    lastModeRef.current = free ? 'bot_free' : 'bot_paid';
    lastSettingsRef.current = { entryFee: fee, currency: cur };
    pendingStartRef.current = null;
    setOpponentUsername('Duely Bot');
    setCountdown(3); // countdown will apply buffered bj_start data when it hits 0
    setPhase('queue');
    socket.emit('play_bj_vs_bot', { entryFee: fee, currency: cur });
  }

  function leaveQueue() {
    socket?.emit('leave_bj_queue');
    setPhase('lobby'); setStatusMsg('');
  }

  function createPrivate() {
    if (!session) { navigate('/login'); return; }
    socket.emit('create_private_room', { gameType: 'blackjack', entryFee, currency: betCurrency });
  }

  function joinPrivate(code) {
    if (!session) { navigate('/login'); return; }
    socket.emit('join_private_room', { gameType: 'blackjack', code });
  }

  function cancelPrivate() {
    socket?.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }

  function hit() { if (stood || !roomId) return; socket?.emit('bj_hit', { roomId }); }
  function stand() { if (stood || !roomId) return; socket?.emit('bj_stand', { roomId }); }
  function split() { if (stood || !roomId) return; socket?.emit('bj_split', { roomId }); }

  const canSplit = !stood && !bust && !splitData &&
    myHand.length === 2 && myHand[0]?.value === myHand[1]?.value;

  function _resetGame() {
    setResultData(null); setRevealData(null);
    setStatusMsg(''); setMyHand([]); setMyScore(0); setOpponentUsername('');
    setOppHand([]);
    setStood(false); setBust(false); setTimeLeft(20);
    setFlippingOpp(false); setNewCardIdx(null);
    setSplitData(null); setOppHasSplit(false);
    prevHandLenRef.current = 0;
    myHitCountRef.current  = 0;
    oppBufferedRef.current = [];
    oppRevealedRef.current = 0;
  }

  function playAgain() {
    _resetGame();
    const mode = lastModeRef.current;
    const s = lastSettingsRef.current;
    eloBeforeRef.current = profile?.elo ?? 1000;

    if (mode === 'pvp') {
      socket.emit('join_bj_queue', { entryFee: s.entryFee, currency: s.currency });
      setPhase('queue');
      setStatusMsg('Waiting for opponent…');
    } else if (mode === 'bot_free' || mode === 'bot_paid') {
      pendingStartRef.current = null;
      setOpponentUsername('Duely Bot');
      setCountdown(3);
      setPhase('queue');
      socket.emit('play_bj_vs_bot', { entryFee: s.entryFee, currency: s.currency });
    } else {
      setPhase('lobby');
    }
  }

  // ── Result screen ──
  if (phase === 'result' && resultData) {
    const isWinner = resultData.winnerId === profile?.id;
    const myResult = resultData.hands?.[profile?.id];
    const oppId = Object.keys(resultData.hands || {}).find(id => id !== profile?.id);
    const oppResult = oppId ? resultData.hands[oppId] : null;
    return (
      <div className="min-h-[calc(100vh-56px)] bg-bg flex items-center justify-center px-4">
        <ResultScreen
          isWinner={isWinner}
          isDraw={resultData.isDraw}
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
          gameLabel="🃏 Blackjack"
          extraRows={[
            myResult && { label: myResult.splitHand ? 'Your Hand 2 (Active)' : 'Your Hand', value: myResult.score > 21 ? `Bust (${myResult.score})` : myResult.score },
            myResult?.splitHand && { label: 'Your Hand 1', value: myResult.splitScore > 21 ? `Bust (${myResult.splitScore})` : myResult.splitScore },
            oppResult && { label: oppResult.splitHand ? 'Opp Hand 2 (Active)' : 'Opponent Hand', value: oppResult.score > 21 ? `Bust (${oppResult.score})` : oppResult.score },
            oppResult?.splitHand && { label: 'Opp Hand 1', value: oppResult.splitScore > 21 ? `Bust (${oppResult.splitScore})` : oppResult.splitScore },
            resultData.dealerScore != null && { label: 'Dealer', value: resultData.dealerScore > 21 ? `Bust (${resultData.dealerScore})` : resultData.dealerScore },
          ].filter(Boolean)}
          onPlayAgain={playAgain}
          onBackToLobby={() => { _resetGame(); setPhase('lobby'); }}
        />
      </div>
    );
  }

  // ── Playing / Reveal ──
  if (phase === 'playing' || phase === 'reveal') {
    const rd = phase === 'reveal' ? revealData : null;
    const oppId = rd ? Object.keys(rd.hands || {}).find(id => id !== profile?.id) : null;
    const oppReveal = rd && oppId ? rd.hands[oppId] : null;
    const myReveal = rd ? rd.hands?.[profile?.id] : null;

    const timerPct = (timeLeft / 20) * 100;
    const timerColor = timeLeft <= 5 ? '#ef4444' : timeLeft <= 10 ? '#f97316' : '#22c55e';

    const isLight = document.documentElement.classList.contains('light');
    const gameBg = isLight ? '#ffffff' : '#000000';
    const textPrimary = isLight ? '#111111' : '#ffffff';
    const textMuted = isLight ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.4)';
    const textDim = isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)';
    const divider = isLight ? '1px solid rgba(0,0,0,0.1)' : '1px solid rgba(255,255,255,0.07)';
    const timerTrack = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';

    return (
      <div style={{
        minHeight: 'calc(100vh - 56px)',
        background: gameBg,
        display: 'flex', flexDirection: 'column',
        opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease',
      }}>
        <style>{CARD_DEAL_CSS}</style>

        {/* Top bar */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px',
          borderBottom: divider,
        }}>
          <span style={{ fontWeight: 900, fontSize: 16, color: textPrimary, letterSpacing: 0.5 }}>🃏 Blackjack</span>
          {phase === 'playing' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 120, height: 6, background: timerTrack, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${timerPct}%`, background: timerColor, transition: 'width 1s linear', borderRadius: 3 }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 900, color: timerColor, minWidth: 30 }}>{timeLeft}s</span>
            </div>
          )}
          {phase === 'reveal' && (
            <span style={{ fontSize: 13, color: textMuted, fontWeight: 600 }}>Revealing…</span>
          )}
        </div>

        {/* Opponent section */}
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '12px 12px 10px',
          borderBottom: divider,
          position: 'relative',
        }}>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 900, color: '#fff',
            }}>
              {(opponentUsername || 'Bot')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15, color: textPrimary }}>
                {opponentUsername || 'Duely Bot'}
                {rd && rd.winnerId === oppId && <span style={{ marginLeft: 6, fontSize: 14 }}>👑</span>}
              </div>
              {/* Score: reveal-phase uses server data; playing phase uses live visible cards (no bust until reveal) */}
              {oppReveal
                ? <ScoreBadge score={oppReveal.score} bust={oppReveal.score > 21} isLight={isLight} />
                : oppHand.length > 0
                  ? (() => { const s = calcScore(oppHand); return s <= 21 ? <ScoreBadge score={s} isLight={isLight} /> : null; })()
                  : <span style={{ fontSize: 12, color: textMuted }}>{oppHasSplit ? '✂️ Split · ' : ''}{opponentHandSize} cards</span>
              }
              {!oppReveal && oppBufferedRef.current.length > oppRevealedRef.current && (
                <span style={{ fontSize: 11, color: textDim, marginLeft: 4 }}>
                  +{oppBufferedRef.current.length - oppRevealedRef.current} hidden
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'nowrap', overflowX: 'auto', maxWidth: '100%', paddingBottom: 4, justifyContent: 'center' }}>
            {oppReveal
              ? oppReveal.hand.map((c, i) => (
                  <FlipCard key={i} card={c} flipped={flippingOpp} flipDelay={i * 0.18} />
                ))
              : oppHand.length > 0
                ? oppHand.map((c, i) => (
                    <Card key={`opp-${dealRevision}-${i}`} card={c}
                      dealIndex={dealRevision > 0 && i < 2 ? i : (i >= 2 ? 0 : null)} />
                  ))
                : Array.from({ length: opponentHandSize }).map((_, i) => (
                    <Card key={i} faceDown dealIndex={dealRevision > 0 ? i : null} />
                  ))
            }
          </div>
        </div>

        {/* Your section */}
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '10px 12px 12px',
          overflowY: 'auto',
        }}>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'linear-gradient(135deg, #1E90FF, #0066cc)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 900, color: '#fff',
            }}>
              {(profile?.username || 'Y')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15, color: textPrimary }}>
                {profile?.username || 'You'}
                {rd && rd.winnerId === profile?.id && <span style={{ marginLeft: 6, fontSize: 14 }}>👑</span>}
              </div>
              <ScoreBadge
                score={rd ? (myReveal?.score ?? myScore) : myScore}
                bust={bust || (rd && myReveal?.score > 21)}
                stood={stood}
                isLight={isLight}
              />
            </div>
          </div>
          {/* Split hand display — hand1 (completed/pending) shown above active hand */}
          {splitData && (
            <div style={{ marginBottom: 14, width: '100%', maxWidth: 480 }}>
              {/* Hand 1 (completed when on hand 2) or pending hand 2 label */}
              {splitData.activeHand === 2 ? (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                    Hand 1 — Completed
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', opacity: 0.55 }}>
                    {splitData.hand1.map((c, i) => (
                      <div key={i} style={{ transform: 'scale(0.72)', transformOrigin: 'top center', marginBottom: -30 }}>
                        <CardFace card={c} />
                      </div>
                    ))}
                  </div>
                  <div style={{ textAlign: 'center', marginTop: 6, fontSize: 12, color: textMuted, fontWeight: 700 }}>
                    {splitData.score1 > 21 ? `Bust (${splitData.score1})` : splitData.score1}
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                    Hand 2 — Waiting
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', opacity: 0.45 }}>
                    {splitData.hand2.map((c, i) => (
                      <div key={i} style={{ transform: 'scale(0.72)', transformOrigin: 'top center', marginBottom: -30 }}>
                        <CardFace card={c} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center', marginBottom: 4, marginTop: 10 }}>
                Hand {splitData.activeHand} — Active
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'nowrap', overflowX: 'auto', maxWidth: '100%', paddingBottom: 4, justifyContent: 'center', marginBottom: 16 }}>
            {(rd ? (myReveal?.hand ?? myHand) : myHand).map((c, i) => (
              <Card
                key={`${dealRevision}-${i}`}
                card={c}
                dealIndex={dealRevision > 0 && i < 2 ? i : (i === newCardIdx ? 0 : null)}
              />
            ))}
          </div>

          {/* Draw result banner */}
          {phase === 'reveal' && rd?.isDraw && (
            <div style={{ marginBottom: 16, fontSize: 18, fontWeight: 900, color: '#fbbf24' }}>🤝 Draw!</div>
          )}

          {/* HIT / STAND / SPLIT */}
          {phase === 'playing' && (
            <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button
                  className="bj-hit-btn"
                  onClick={hit}
                  disabled={stood || bust}
                  style={{
                    padding: '16px 0', borderRadius: 14, border: 'none',
                    cursor: stood || bust ? 'not-allowed' : 'pointer',
                    background: stood || bust
                      ? (isLight ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.07)')
                      : 'linear-gradient(135deg, #1E90FF 0%, #0055bb 100%)',
                    color: stood || bust ? (isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)') : '#fff',
                    fontSize: 18, fontWeight: 900, letterSpacing: 1,
                    boxShadow: stood || bust ? 'none' : '0 4px 16px rgba(30,144,255,0.35)',
                    transition: 'all 0.15s',
                  }}
                >
                  HIT
                </button>
                <button
                  className="bj-stand-btn"
                  onClick={stand}
                  disabled={stood || bust}
                  style={{
                    padding: '16px 0', borderRadius: 14,
                    cursor: stood || bust ? 'not-allowed' : 'pointer',
                    background: 'transparent',
                    border: stood || bust
                      ? `2px solid ${isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.07)'}`
                      : `2px solid ${isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)'}`,
                    color: stood || bust ? (isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)') : textPrimary,
                    fontSize: 18, fontWeight: 900, letterSpacing: 1,
                    transition: 'all 0.15s',
                  }}
                >
                  STAND
                </button>
              </div>
              {/* SPLIT button — only shown when eligible */}
              {canSplit && (
                <button
                  className="bj-split-btn"
                  onClick={split}
                  style={{
                    padding: '13px 0', borderRadius: 14, border: 'none',
                    cursor: 'pointer',
                    background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                    color: '#fff',
                    fontSize: 16, fontWeight: 900, letterSpacing: 1,
                    boxShadow: '0 4px 16px rgba(245,158,11,0.35)',
                    transition: 'all 0.15s',
                  }}
                >
                  ✂️ SPLIT
                </button>
              )}
            </div>
          )}

          {/* Waiting status */}
          {phase === 'playing' && stood && !bust && (
            <p style={{ marginTop: 14, fontSize: 13, color: textMuted, fontWeight: 600 }}>
              ✅ Stood — waiting for opponent…
            </p>
          )}
          {phase === 'playing' && bust && !splitData && (
            <p style={{ marginTop: 14, fontSize: 13, color: '#f87171', fontWeight: 700 }}>
              💥 Bust — waiting for opponent…
            </p>
          )}
          {phase === 'playing' && bust && splitData && (
            <p style={{ marginTop: 14, fontSize: 13, color: '#f97316', fontWeight: 700 }}>
              💥 Bust on Hand {splitData.activeHand === 1 ? '1' : '2'} — moving to {splitData.activeHand === 1 ? 'Hand 2' : 'next'}…
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Queue / Countdown ──
  if (phase === 'queue') {
    // Show countdown when active (PvP after match_found, or bot immediately)
    if (countdown > 0) {
      return (
        <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4">
          <div className="text-center animate-fade-in">
            <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1E90FF' }}>
              {countdown}
            </div>
            <p className="text-muted">Get ready...</p>
            <p className="text-xs text-muted mt-2">vs {opponentUsername}</p>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching...</h2>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      </div>
    );
  }

  // ── Private waiting ──
  if (phase === 'private_waiting') {
    return (
      <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-md text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-black text-white mb-2">Private Room</h2>
          <p className="text-muted mb-4 text-sm">Share this code with your friend</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 inline-block min-w-[200px]">
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary">
              {privateCode}
            </div>
          </div>
          <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
          <button onClick={cancelPrivate} className="text-sm text-danger hover:text-red-400 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }

  // ── Lobby ──
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
      <div className="w-full max-w-md animate-slide-up">

        <div className="text-center mb-6">
          <h1 className="text-5xl font-black text-white mb-2">🃏 Blackjack</h1>
          <p className="text-muted text-base">Get closer to 21 than your opponent</p>
        </div>

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
          {(playerCounts?.blackjack ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 mt-3">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80' }} />
              <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 600 }}>{playerCounts.blackjack} playing</span>
            </div>
          )}
          {(() => { const n = betCounts?.[`blackjack:${entryFee}:${betCurrency}`] || 0; return n > 0 ? (
            <div className="flex items-center gap-1.5 mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80' }} />
              <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 600 }}>{n} at this bet</span>
            </div>
          ) : null; })()}
          {insufficient && <p className="text-danger text-sm mt-2 text-center font-semibold">Insufficient balance.</p>}
        </div>

        <div className="flex flex-col gap-3">
          {!isDiamonds && (
            <GlowButton onClick={session ? joinQueue : () => navigate('/login')} variant="primary" size="lg" className="w-full text-lg py-4" disabled={session && (!authenticated || insufficient)}>
              {!session ? '🔒 Login to Play' : 'Find Opponent'}
            </GlowButton>
          )}

          {isDiamonds && (
            <GlowButton onClick={session ? joinQueue : () => navigate('/login')} variant="primary" size="lg" className="w-full text-lg py-4" disabled={session && (!authenticated || insufficient)}>
              {!session ? '🔒 Login to Play' : 'Find Opponent'}
            </GlowButton>
          )}

          {isDiamonds && (
            <GlowButton onClick={session ? () => playVsBot(false) : () => navigate('/login')} variant="ghost" size="lg" className="w-full text-lg py-4 border border-border hover:border-primary" disabled={session && (!authenticated || insufficient)}>
              {!session ? '🔒 Login to Play' : `🤖 Bet vs Bot — ${fmtFee(entryFee)} 💎`}
            </GlowButton>
          )}

          <GlowButton onClick={session ? () => playVsBot(true) : () => navigate('/login')} variant="ghost" size="lg" className="w-full text-lg py-4 border border-border hover:border-accent" disabled={session && !authenticated}>
            {!session ? '🔒 Login to Play' : '🎮 Play Free vs Bot'}
          </GlowButton>

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

        </div>

        {statusMsg && <p className="text-center text-sm text-warning mt-3">{statusMsg}</p>}
      </div>
    </div>
  );
}
