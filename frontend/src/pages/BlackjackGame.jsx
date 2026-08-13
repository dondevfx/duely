import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { playMatchFound, playCard, playCountdown } from '../utils/sound';
import { useCurrency } from '../context/CurrencyContext';
import { COIN_FEES, DIAMOND_FEES, SMALL_BTN } from '../components/GameLobby';
import BetSlider from '../components/BetSlider';
import ResultScreen from '../components/ResultScreen';
import GameErrorBoundary from '../components/GameErrorBoundary';
import GlowButton from '../components/GlowButton';
import { topUpRoute, topUpLabel } from '../utils/topUpRoute';
import CreateRoomModal from '../components/CreateRoomModal';
import JoinRoomModal from '../components/JoinRoomModal';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
import { usePageReady } from '../hooks/usePageReady';
import { useGameScrollLock } from '../hooks/useGameScrollLock';
import { useResumeMatch } from '../hooks/useResumeMatch';
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

// Responsive card size — bigger on desktop, noticeably smaller on mobile so
// the hand + HIT/STAND buttons all fit on screen without scrolling.
const IS_MOBILE_SCREEN = typeof window !== 'undefined' && window.innerWidth < 768;
const CARD_W = typeof window !== 'undefined'
  ? Math.round(Math.min(98, Math.floor((window.innerWidth - 48) / 4)) * (IS_MOBILE_SCREEN ? 0.74 : 1))
  : 98;
const CARD_H = Math.round(CARD_W * 1.44);

const CARD_DEAL_CSS = `
@keyframes dealIn {
  from { opacity: 0; transform: translateY(-60px) scale(0.7) rotate(-8deg); }
  to   { opacity: 1; transform: translateY(0)    scale(1)   rotate(0deg);  }
}
.bj-action-btn {
  padding: 17px 0;
  border-radius: 12px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.5px;
  transition: all 0.15s ease;
}
.bj-hit-btn:not(:disabled):hover {
  background: rgba(18,80,180,0.16) !important;
  border-color: rgba(18,80,180,0.55) !important;
}
.bj-stand-btn:not(:disabled):hover {
  border-color: rgba(255,255,255,0.4) !important;
  background: rgba(255,255,255,0.06) !important;
}
.bj-split-btn:not(:disabled):hover {
  border-color: rgba(255,255,255,0.4) !important;
  background: rgba(255,255,255,0.06) !important;
}
@media (max-width: 767px) {
  .bj-action-btn { padding: 12px 0; font-size: 15px; border-radius: 10px; }
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

// Deals in face-down, then flips face-up when `flipped` becomes true.
function DealFlipCard({ card, flipped }) {
  return (
    <div style={{ flexShrink: 0, animation: 'dealIn 0.5s cubic-bezier(0.22,1,0.36,1) both' }}>
      <FlipCard card={card} flipped={flipped} flipDelay={0} />
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
        transition: `transform 0.4s ${flipDelay}s ease`,
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

function BlackjackGame() {
  const ready = usePageReady();
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, session, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, playerCounts, betCounts } = useSocket();
  // Only a live match re-claims itself after a reconnect; a refresh forfeits.
  useResumeMatch(socket, () => phaseRef.current === 'playing' || phaseRef.current === 'reveal');
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
    // pagehide as well as beforeunload: iOS Safari routinely skips
    // beforeunload when a tab is closed or the app is swiped away, which would
    // leave the forfeit relying solely on the socket dropping.
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
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
  const [invitedFriend, setInvitedFriend] = useState(null); // waiting on a friend invite
  const [joinCode, setJoinCode] = useState('');
  const [entryFee, setEntryFee] = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [statusMsg, setStatusMsg] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [countdown, setCountdown] = useState(0); // visual countdown only — does not change phase
  // Pin the page for the countdown and the match itself: start at the top,
  // and no scrolling the board off-screen while it is being played.
  // Placed after `countdown` is declared — referencing it above would hit
  // the temporal dead zone and throw on mount.
  useGameScrollLock(countdown > 0 || phase === 'playing' || phase === 'reveal');

  const [opponentUsername, setOpponentUsername] = useState('');
  const [myHand, setMyHand] = useState([]);
  const [myScore, setMyScore] = useState(0);
  const [opponentHandSize, setOpponentHandSize] = useState(2);
  const [oppHand, setOppHand] = useState([]);      // opponent's visible cards (initial + unlocked hits)
  const myHitCountRef  = useRef(0);                // how many times I have hit
  const oppBufferedRef = useRef([]);               // opponent hit cards received but not yet revealed
  const oppRevealedRef = useRef(0);                // how many buffered opp cards have been shown
  const [stood, setStood] = useState(false);
  const stoodRef = useRef(false);       // true once my turn is fully over (stand/bust)
  const splitDataRef = useRef(null);    // current split state, for use inside socket handlers
  const [oppFlippedHits, setOppFlippedHits] = useState(0); // opp hit cards that have flipped face-up
  const oppFlippedHitsRef = useRef(0);   // mirror for reading inside socket handlers
  useEffect(() => { oppFlippedHitsRef.current = oppFlippedHits; }, [oppFlippedHits]);
  // Count of opponent cards already face-up when the reveal phase begins — frozen
  // so cards shown during play don't re-flip when we switch to the reveal render.
  const [oppRevealBase, setOppRevealBase] = useState(0);
  const oppInitialCountRef = useRef(2);  // length of the opponent's initial (always-visible) hand
  const [bust, setBust] = useState(false);
  const [timeLeft, setTimeLeft] = useState(20);
  const [resultData, setResultData] = useState(null);
  const [revealData, setRevealData] = useState(null);
  const timerRef = useRef(null);

  // Split state
  const [splitData, setSplitData] = useState(null);
  useEffect(() => { splitDataRef.current = splitData; }, [splitData]);
  // True while hand 1's final outcome is on screen, before switching to hand 2.
  const [splitPending, setSplitPending] = useState(false);

  const revealTimersRef = useRef([]); // staggered opponent-card reveal timers

  // My turn is fully over (stand or bust): reveal the opponent's previously
  // hidden hit cards — dealt out one at a time (~1s each) so it isn't an
  // instant pop.
  function markStood() {
    setStood(true);
    stoodRef.current = true;
    const toReveal = oppBufferedRef.current.slice(oppRevealedRef.current);
    oppRevealedRef.current = oppBufferedRef.current.length;
    // For each hidden card: deal it in face-down, then ~1s later flip it over —
    // one card at a time (~2s each), like a dealer turning them up.
    toReveal.forEach((card, idx) => {
      const tDeal = setTimeout(() => setOppHand(prev => [...prev, card]), idx * 2000);
      const tFlip = setTimeout(() => setOppFlippedHits(f => f + 1), idx * 2000 + 1000);
      revealTimersRef.current.push(tDeal, tFlip);
    });
  }
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
        stoodRef.current = false;
        revealTimersRef.current.forEach(clearTimeout); revealTimersRef.current = [];
        oppInitialCountRef.current = (d.opponentHand ?? []).length || 2;
        setOppFlippedHits(0);
        oppFlippedHitsRef.current = 0;
        setOppRevealBase(0);
        setMyHand(d.hand);
        setMyScore(d.handScore);
        setOpponentHandSize(d.oppSz);
        setOppHand(d.opponentHand ?? []);
        setStood(false); setBust(false); setFlippingOpp(false);
        setNewCardIdx(null); setSplitData(null); setSplitPending(false); setOppHasSplit(false);
        setDealRevision(r => r + 1);
        prevHandLenRef.current = d.hand.length;
        setPhase('playing');
        setTimeLeft(d.timeLimit || 20);
        // Deal sound — one flick per card being dealt out.
        (d.hand || []).forEach((_, i) => setTimeout(playCard, i * 180));
      }
      return;
    }
    playCountdown(); // tick on each 3 · 2 · 1
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
      playMatchFound();
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
      // The entry fee is deducted optimistically when a match is found, but a
      // cancellation means it was never actually taken — pull the real balance
      // so the player is not left looking at money that did not move.
      refreshProfile();
      setPhase('lobby');
      setStatusMsg(message || 'Match cancelled. Please try again.');
    });

    socket.on('bj_start', ({ hand, handScore, opponentHand, opponentHandSize: oppSz, timeLimit }) => {
      // Buffer the start data — countdown useEffect will apply it when it reaches 0
      pendingStartRef.current = { hand, handScore, opponentHand, oppSz, timeLimit };
    });

    socket.on('bj_opp_card', ({ card }) => {
      playCard(); // opponent drew a card
      oppBufferedRef.current.push(card);
      // Keep opponent hit cards HIDDEN until I've finished my turn (stand/bust).
      // Once I've stood, deal each new hit in face-down, then flip it after ~1s.
      if (stoodRef.current) {
        oppRevealedRef.current = oppBufferedRef.current.length;
        setOppHand(prev => [...prev, card]);
        const tFlip = setTimeout(() => setOppFlippedHits(f => f + 1), 1000);
        revealTimersRef.current.push(tFlip);
      }
    });

    socket.on('bj_card', ({ hand, score }) => {
      myHitCountRef.current++;
      playCard(); // I drew a card
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
      // On hand1 of a split, hand2 continues — don't end the turn (or reveal) yet.
      const onHand1WithSplit = splitDataRef.current && splitDataRef.current.activeHand === 1;
      if (!onHand1WithSplit) markStood();
    });

    socket.on('bj_stood', () => {
      markStood();
    });

    // Split events
    socket.on('bj_split', ({ hand1, score1, hand2, score2 }) => {
      setSplitData({ hand1, score1, hand2, score2, activeHand: 1 });
      setMyHand(hand1);
      setMyScore(score1);
      setBust(false);
      setStood(false);
      stoodRef.current = false;
      setNewCardIdx(null);
    });

    socket.on('bj_split_hand2', ({ hand, score }) => {
      // Keep hand 1's final card/outcome on screen for a beat, then switch to
      // hand 2 — otherwise a hit that ends hand 1 (21 or bust) jumps away before
      // the player sees the result.
      setSplitPending(true);
      const t = setTimeout(() => {
        playCard();
        setSplitData(d => d ? { ...d, hand2: hand, score2: score, activeHand: 2 } : d);
        setMyHand(hand);
        setMyScore(score);
        setBust(false);
        setStood(false);
        stoodRef.current = false;
        setNewCardIdx(null);
        setSplitPending(false);
      }, 1200);
      revealTimersRef.current.push(t);
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
      // Cards already revealed during play must stay face-up — cancel any pending
      // during-play flip timers and freeze how many opp cards are already showing.
      revealTimersRef.current.forEach(clearTimeout); revealTimersRef.current = [];
      const base = oppInitialCountRef.current + oppFlippedHitsRef.current;
      setOppRevealBase(base);
      const oppCards = (() => {
        const oId = Object.keys(data.hands || {}).find(id => id !== profileRef.current?.id);
        return oId ? (data.hands[oId]?.hand?.length ?? 2) : 2;
      })();
      // Only the still-hidden cards (beyond `base`) need flipping now.
      const hits = Math.max(0, oppCards - base);
      // Brief pause then flip the remaining opponent cards, staggered ~1s each.
      if (hits > 0) setTimeout(() => setFlippingOpp(true), 150);
      // End 1s after the last card finishes flipping (150ms delay + stagger + 0.4s flip).
      const lastFlipDone = hits > 0 ? 150 + (hits - 1) * 1000 + 400 : 0;
      const revealMs = lastFlipDone + 1000;
      setTimeout(() => {
        roomIdRef.current = null;
        setResultData(data);
        setPhase('result');
      }, revealMs);
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
      // Pre-match ELO comes from the profile snapshot taken when the match
      // started, not from the result. ELO changes are a random 20-23 on a win
      // and 17-20 on a loss, so subtracting a fixed 25 here would report a
      // delta that never matches what actually happened.
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
      setPrivateCode(code); setInvitedFriend(null); setPhase('private_waiting');
    });

    // Friend invite sent → wait for them to accept.
    socket.on('invite_sent', ({ friendUsername }) => {
      setPrivateCode(''); setInvitedFriend(friendUsername || 'your friend'); setPrivateMode(null); setStatusMsg(''); setPhase('private_waiting');
    });
    socket.on('invite_declined', ({ byUsername }) => {
      setInvitedFriend(null); setStatusMsg(`${byUsername || 'They'} declined your invite.`); setPhase('lobby');
    });
    socket.on('invite_expired', () => {
      setInvitedFriend(null); setStatusMsg('Invite expired — no response.'); setPhase('lobby');
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
      socket.off('invite_sent'); socket.off('invite_declined'); socket.off('invite_expired');
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

  // Auto-join a private room when arriving from an accepted friend invite.
  useEffect(() => {
    if (!location.state?.autoJoin || !location.state?.joinCode) return;
    if (!socket || !authenticated || !session) return;
    const code = location.state.joinCode;
    window.history.replaceState({}, ''); // don't re-join on refresh/re-render
    setTimeout(() => joinPrivate(code), 300);
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
    setPhase('lobby'); setPrivateCode(''); setInvitedFriend(null); setStatusMsg('');
  }

  function hit() { if (stood || !roomId) return; socket?.emit('bj_hit', { roomId }); }
  function stand() { if (stood || !roomId) return; socket?.emit('bj_stand', { roomId }); }
  function split() { if (stood || !roomId) return; socket?.emit('bj_split', { roomId }); }

  // HIT / STAND button pair — reused for normal play and under the active split hand.
  // isLight/textPrimary are computed here (not read from the render block) so this
  // works no matter where it's called from.
  function actionButtons() {
    const off = stood || bust;
    const isLight = document.documentElement.classList.contains('light');
    const textPrimary = isLight ? '#111111' : '#ffffff';
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, width: '100%' }}>
        <button
          className="bj-action-btn bj-hit-btn"
          onClick={hit}
          disabled={off}
          style={{
            cursor: off ? 'not-allowed' : 'pointer',
            background: off ? (isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)') : 'rgba(18,80,180,0.10)',
            border: off ? `1.5px solid ${isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)'}` : '1.5px solid rgba(18,80,180,0.45)',
            color: off ? (isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)') : '#4DA3FF',
          }}
        >
          HIT
        </button>
        <button
          className="bj-action-btn bj-stand-btn"
          onClick={stand}
          disabled={off}
          style={{
            cursor: off ? 'not-allowed' : 'pointer',
            background: 'transparent',
            border: off ? `1.5px solid ${isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)'}` : `1.5px solid ${isLight ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.2)'}`,
            color: off ? (isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)') : textPrimary,
          }}
        >
          STAND
        </button>
      </div>
    );
  }

  const canSplit = !stood && !bust && !splitData &&
    myHand.length === 2 && myHand[0]?.value === myHand[1]?.value;

  function _resetGame() {
    setResultData(null); setRevealData(null);
    setStatusMsg(''); setMyHand([]); setMyScore(0); setOpponentUsername('');
    setOppHand([]);
    setStood(false); setBust(false); setTimeLeft(20);
    setFlippingOpp(false); setNewCardIdx(null);
    setSplitData(null); setSplitPending(false); setOppHasSplit(false);
    prevHandLenRef.current = 0;
    myHitCountRef.current  = 0;
    oppBufferedRef.current = [];
    oppRevealedRef.current = 0;
    stoodRef.current = false;
    setOppFlippedHits(0);
    oppFlippedHitsRef.current = 0;
    setOppRevealBase(0);
    revealTimersRef.current.forEach(clearTimeout); revealTimersRef.current = [];
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
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex items-center justify-center px-3 sm:px-4 py-0 sm:py-4">
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
        // dvh (not vh) so the layout shrinks when mobile Safari's bottom
        // toolbar is showing, instead of being sized for the toolbar-hidden
        // viewport and having the HIT/STAND buttons clipped underneath it.
        minHeight: 'calc(100dvh - 56px)',
        background: gameBg,
        display: 'flex', flexDirection: 'column',
        opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
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
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '100%', paddingBottom: 4, justifyContent: 'center' }}>
            {oppReveal
              ? oppReveal.hand.map((c, i) => (
                  // Cards already face-up during play stay static; only the still-hidden
                  // ones (beyond the frozen baseline) flip now.
                  i < oppRevealBase
                    ? <Card key={`oppr-${i}`} card={c} />
                    : <FlipCard key={`oppr-${i}`} card={c} flipped={flippingOpp} flipDelay={(i - oppRevealBase) * 1} />
                ))
              : oppHand.length > 0
                ? oppHand.map((c, i) => (
                    i < oppInitialCountRef.current
                      ? <Card key={`opp-${dealRevision}-${i}`} card={c}
                          dealIndex={dealRevision > 0 ? i : null} />
                      : <DealFlipCard key={`opp-hit-${i}`} card={c}
                          flipped={(i - oppInitialCountRef.current) < oppFlippedHits} />
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
          padding: '10px 12px 24px',
          overflowY: 'auto',
        }}>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'linear-gradient(135deg, #1250B4, #0066cc)',
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
              {/* Hidden during a split: each hand carries its own badge under
                  its cards, and this one has no hand to belong to. With a split
                  bust it rendered a second red "Bust" above the cards while the
                  hand's own badge said the same thing below them. */}
              {!splitData && (
                <ScoreBadge
                  score={rd ? (myReveal?.score ?? myScore) : myScore}
                  bust={bust || (rd && myReveal?.score > 21)}
                  stood={stood}
                  isLight={isLight}
                />
              )}
            </div>
          </div>
          {/* Player hand(s). When split: two hands side by side, same card style,
              active one highlighted — play one at a time. */}
          {splitData ? (
            <div style={{ display: 'flex', gap: IS_MOBILE_SCREEN ? 0 : 28, justifyContent: 'center', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16, width: '100%' }}>
              {[1, 2].map(hn => {
                const active = splitData.activeHand === hn;
                // Mobile: only show one hand at a time — the active hand. Hand 2
                // appears once the player finishes hand 1.
                if (IS_MOBILE_SCREEN && !active) return null;
                const hand   = hn === 1 ? splitData.hand1 : splitData.hand2;
                const score  = hn === 1 ? splitData.score1 : splitData.score2;
                const done   = hn < splitData.activeHand;
                return (
                  <div key={hn} style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                    opacity: (active || IS_MOBILE_SCREEN) ? 1 : 0.5,
                    transition: 'opacity 0.2s',
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: active ? '#22c55e' : textMuted }}>
                      Hand {hn}{active ? ' · Active' : done ? ' · Done' : ''}
                    </div>
                    {/* Full-size cards, same gap as a normal hand. They used to
                        be scaled to 0.82 and overlapped so two hands would sit
                        side by side on desktop — but mobile only ever renders
                        the active hand, so it paid that cost for nothing, and on
                        desktop the outer row already wraps. Wrapping to a second
                        row beats shrinking every card. */}
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', maxWidth: '100%' }}>
                      {(hand || []).map((c, i) => (
                        <CardFace key={i} card={c} />
                      ))}
                    </div>
                    {score != null && <ScoreBadge score={score} bust={score > 21} isLight={isLight} />}
                    {/* HIT / STAND live under the hand they act on */}
                    {active && phase === 'playing' && !splitPending && (
                      // Fixed width, not 100%. This column is a shrink-to-fit flex
                      // item sized by the cards above it, so `width: 100%`
                      // resolved to roughly the width of the hand and squashed
                      // HIT/STAND. 360 is the same max the non-split buttons use,
                      // so they come out identical in both modes rather than
                      // merely close.
                      <div style={{ width: 360, maxWidth: '100%', marginTop: 8 }}>
                        {actionButtons()}
                      </div>
                    )}
                    {active && phase === 'playing' && splitPending && (
                      // The badge directly above already states the score and
                      // whether it busted; repeating it here just said "Bust"
                      // twice in adjacent lines.
                      <p style={{ marginTop: 8, fontSize: 12, color: textMuted, fontWeight: 700 }}>
                        Moving to Hand 2…
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '100%', paddingBottom: 4, justifyContent: 'center', marginBottom: 16 }}>
              {(rd ? (myReveal?.hand ?? myHand) : myHand).map((c, i) => (
                <Card
                  key={`${dealRevision}-${i}`}
                  card={c}
                  dealIndex={dealRevision > 0 && i < 2 ? i : (i === newCardIdx ? 0 : null)}
                />
              ))}
            </div>
          )}

          {/* Draw result banner */}
          {phase === 'reveal' && rd?.isDraw && (
            <div style={{ marginBottom: 16, fontSize: 18, fontWeight: 900, color: '#fbbf24' }}>🤝 Draw!</div>
          )}

          {/* HIT / STAND / SPLIT — for normal (non-split) play. During a split the
              buttons live under the active hand instead. */}
          {phase === 'playing' && !splitData && (
            <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {actionButtons()}
              {/* SPLIT button — only shown when eligible */}
              {canSplit && (
                <button
                  className="bj-action-btn bj-split-btn"
                  onClick={split}
                  style={{
                    cursor: 'pointer',
                    background: 'transparent',
                    border: `1.5px solid ${isLight ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.2)'}`,
                    color: '#fff',
                  }}
                >
                  SPLIT
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
          {/* Suppressed while splitPending, because the hand column above is
              already showing its own "Bust — moving to Hand 2" line for that
              same 1.2s pause. Both rendered at once, which is where the two
              stacked bust messages came from. Busting on the LAST hand does not
              set splitPending, so that case still gets this banner. */}
          {phase === 'playing' && bust && splitData && !splitPending && (
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
        <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
          <div className="text-center animate-fade-in">
            <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>
              {countdown}
            </div>
            <p className="text-muted">Get ready...</p>
            <p className="text-xs text-muted mt-2">vs {opponentUsername}</p>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
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
      <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-md text-center animate-fade-in">
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
              <ChallengeLinkBox code={privateCode} gameType="blackjack" />
              <p className="text-muted text-sm mb-6">Waiting for opponent to join…</p>
            </>
          )}
          <button onClick={cancelPrivate} className="text-sm text-danger hover:text-red-400 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }

  // ── Lobby ──
  return (
    <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="w-full max-w-md animate-slide-up">

        <div className="text-center mb-1.5 sm:mb-6">
          <h1 className="text-4xl sm:text-6xl font-black text-white mb-0.5 sm:mb-2 leading-tight">🃏 Blackjack</h1>
          <p className="text-center text-muted text-xs sm:text-base leading-snug sm:leading-relaxed px-2 line-clamp-2 sm:line-clamp-none">Get closer to 21 than your opponent. Both players act at the same time — no waiting.</p>
        </div>

        <div className="mb-1.5 sm:mb-4 bg-surface border border-border rounded-2xl p-2.5 sm:p-5">
          <div className="flex items-center justify-between mb-1.5 sm:mb-4">
            <span className="text-base font-bold text-white">Entry Fee</span>
            <div className="flex items-center gap-0.5 bg-bg border border-border rounded-lg p-1">
              <button onClick={() => switchCurrency('coins')} className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${!isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}><CoinIcon size="0.85em" /> Coins</button>
              <button onClick={() => switchCurrency('diamonds')} className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm font-bold transition-all ${isDiamonds ? 'bg-primary text-white' : 'text-muted hover:text-white'}`}>💎 Diamonds</button>
            </div>
          </div>
          <BetSlider fees={fees} entryFee={entryFee} setEntryFee={setEntryFee} currLabel={currLabel} isDiamonds={isDiamonds} />
          {(playerCounts?.blackjack ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 mt-0 sm:mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4' }} />
              <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{playerCounts.blackjack} playing</span>
            </div>
          )}
          {(() => { const n = betCounts?.[`blackjack:${entryFee}:${betCurrency}`] || 0; return n > 0 ? (
            <div className="flex items-center gap-1.5 mt-0 sm:mt-1">
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1250B4', boxShadow: '0 0 6px #1250B4' }} />
              <span style={{ color: '#1250B4', fontSize: 12, fontWeight: 600 }}>{n} at this bet</span>
            </div>
          ) : null; })()}
        </div>

        <div className="flex flex-col gap-3">
          {!session ? (
            <GlowButton onClick={() => navigate('/login')} variant="primary" size="lg" className="w-full text-lg py-4 border border-transparent">
              🔒 Login to Play
            </GlowButton>
          ) : (
          <>
          {!isDiamonds && (
            <GlowButton onClick={!session ? () => navigate('/login') : insufficient ? () => navigate(topUpRoute(betCurrency)) : joinQueue} variant="primary" size="lg" className="w-full text-lg py-4 border border-transparent" disabled={session && !authenticated}>
              {!session ? '🔒 Login to Play' : insufficient ? topUpLabel(betCurrency) : 'Find Opponent'}
            </GlowButton>
          )}

          {isDiamonds && (
            <GlowButton onClick={!session ? () => navigate('/login') : insufficient ? () => navigate(topUpRoute(betCurrency)) : joinQueue} variant="primary" size="lg" className="w-full text-lg py-4 border border-transparent" disabled={session && !authenticated}>
              {!session ? '🔒 Login to Play' : insufficient ? topUpLabel(betCurrency) : 'Find Opponent'}
            </GlowButton>
          )}

          {session && (
            <GlowButton onClick={() => setPrivateMode('create')} variant="ghost" size="lg" className="w-full text-lg py-4 border border-border hover:border-primary">
              🎮 Challenge a Friend
            </GlowButton>
          )}

          {/* Secondary options — small buttons, still visible but not competing */}
          {session && (
            <div className="flex flex-col gap-2 pt-1">
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
          )}
          <CreateRoomModal
            open={privateMode === 'create'}
            onClose={() => setPrivateMode(null)}
            gameType="blackjack"
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
          )}
        </div>

        {statusMsg && <p className="text-center text-sm text-warning mt-3">{statusMsg}</p>}
      </div>
    </div>
  );
}

export default function BlackjackGameWithBoundary(props) {
  return (
    <GameErrorBoundary>
      <BlackjackGame {...props} />
    </GameErrorBoundary>
  );
}
