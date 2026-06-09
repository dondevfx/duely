import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 500, 1000, 5000];
const DIAMOND_FEES = [50, 100, 250, 500, 1000, 10000];
const COLORS       = ['red', 'green', 'blue', 'yellow'];

// ── Card helpers ──────────────────────────────────────────────────────────────

const COLOR_DOT  = { red: '🔴', green: '🟢', blue: '🔵', yellow: '🟡' };
const COLOR_FELT = { red: '#7f1d1d', green: '#14532d', blue: '#1e3a8a', yellow: '#713f12', wild: '#1e1b4b' };

const VALUE_DISPLAY = { skip: '⊘', reverse: '↺', draw2: '+2', wild: '★', wild4: '+4', surge: '⚡+2' };
function displayValue(v) { return VALUE_DISPLAY[v] ?? v; }

const CARD_COLORS = {
  red:    { bg0: '#dc2020', bg1: '#991010', border: '#f87171', text: '#7f1d1d' },
  green:  { bg0: '#16a34a', bg1: '#0e5a21', border: '#4ade80', text: '#14532d' },
  blue:   { bg0: '#2563eb', bg1: '#1540b0', border: '#60a5fa', text: '#1e3a8a' },
  yellow: { bg0: '#ca8a04', bg1: '#92400e', border: '#fcd34d', text: '#78350f' },
  wild:   { bg0: '#1e1b4b', bg1: '#0f172a', border: 'rgba(255,255,255,0.5)', text: '#1e1b4b' },
  surge:  { bg0: '#6d28d9', bg1: '#3b0764', border: '#c4b5fd', text: '#3b0764' },
};

// size variants: 'large' (player hand 80×120), 'medium' (discard/draw 100×150), 'opponent' (50×75), default (66×100)
function UnoCard({ card, onClick, disabled, glow, small, opponentCard, large, medium, faceDown, animIn }) {
  const w = medium ? 100 : large ? 80 : opponentCard ? 50 : small ? 40 : 66;
  const h = medium ? 150 : large ? 120 : opponentCard ? 75 : small ? 56 : 100;
  const br = medium ? 14 : large ? 12 : opponentCard ? 8 : small ? 8 : 14;
  const labelSize = medium ? 13 : large ? 12 : 11;
  const innerW = medium ? 72 : large ? 56 : 48;
  const innerH = medium ? 102 : large ? 82 : 68;
  const innerFontSize = (dv) => medium ? (dv.length > 1 ? 22 : 34) : large ? (dv.length > 1 ? 19 : 28) : (dv.length > 1 ? 17 : 26);

  if (faceDown) {
    return (
      <div style={{
        width: w, height: h,
        borderRadius: br,
        border: '3px solid rgba(255,255,255,0.2)',
        background: 'linear-gradient(135deg, #1e1040 0%, #3b0f7a 50%, #1e1040 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, position: 'relative', overflow: 'hidden',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      }}>
        <div style={{ position:'absolute', inset:0, backgroundImage:'repeating-linear-gradient(45deg,rgba(255,255,255,0.04) 0px,rgba(255,255,255,0.04) 2px,transparent 2px,transparent 10px)' }} />
        <span style={{ fontSize: opponentCard ? 6 : small ? 7 : 10, fontWeight:900, color:'rgba(255,255,255,0.22)', letterSpacing:'0.12em', position:'relative', zIndex:1, textAlign:'center', lineHeight:1.3 }}>CARD{'\n'}RUSH</span>
      </div>
    );
  }

  const isSurge = card.value === 'surge';
  const cs  = isSurge ? CARD_COLORS.surge : (CARD_COLORS[card.color] ?? CARD_COLORS.wild);
  const dv  = displayValue(card.value);
  const isW = card.color === 'wild' && !isSurge;
  const showDetail = !small && !opponentCard;

  const cardStyle = {
    width: w, height: h,
    borderRadius: br,
    border: `3px solid ${cs.border}`,
    background: isSurge
      ? `linear-gradient(155deg,${cs.bg0} 0%,${cs.bg1} 100%)`
      : isW
        ? 'conic-gradient(from 45deg,#dc2020 0deg,#dc2020 90deg,#ca8a04 90deg,#ca8a04 180deg,#16a34a 180deg,#16a34a 270deg,#2563eb 270deg,#2563eb 360deg)'
        : `linear-gradient(155deg,${cs.bg0} 0%,${cs.bg1} 100%)`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative', overflow: 'hidden', flexShrink: 0,
    boxShadow: glow ? `0 0 22px ${cs.border},0 6px 18px rgba(0,0,0,0.55)` : '0 4px 10px rgba(0,0,0,0.45)',
    cursor: !disabled && onClick ? 'pointer' : 'default',
    transition: 'transform 0.15s ease,box-shadow 0.15s ease,opacity 0.15s ease',
    transform: glow ? 'translateY(-12px) scale(1.12)' : 'none',
    opacity: disabled && !glow ? 0.5 : 1,
    animation: animIn ? 'unoCardIn 0.32s cubic-bezier(0.34,1.56,0.64,1) both' : 'none',
  };

  return (
    <button onClick={onClick} disabled={disabled} style={cardStyle}
      onMouseEnter={e => { if (!disabled && onClick) { e.currentTarget.style.transform='translateY(-14px) scale(1.13)'; e.currentTarget.style.boxShadow=`0 0 26px ${cs.border},0 8px 22px rgba(0,0,0,0.55)`; }}}
      onMouseLeave={e => { e.currentTarget.style.transform=glow?'translateY(-12px) scale(1.12)':'none'; e.currentTarget.style.boxShadow=glow?`0 0 22px ${cs.border},0 6px 18px rgba(0,0,0,0.55)`:'0 4px 10px rgba(0,0,0,0.45)'; }}
    >
      {showDetail && <span style={{ position:'absolute', top:5, left:6, fontSize:labelSize, fontWeight:900, color:'rgba(255,255,255,0.88)', lineHeight:1, textShadow:'0 1px 3px rgba(0,0,0,0.6)' }}>{dv}</span>}
      {showDetail ? (
        <div style={{ width:innerW,height:innerH,borderRadius:'50%',background:'rgba(255,255,255,0.93)',display:'flex',alignItems:'center',justifyContent:'center',transform:'rotate(-25deg)',boxShadow:'0 2px 8px rgba(0,0,0,0.2)', overflow:'hidden' }}>
          <span style={{ fontSize:innerFontSize(dv),fontWeight:900,color:cs.text,transform:'rotate(25deg)',lineHeight:1 }}>{dv}</span>
        </div>
      ) : (
        <span style={{ fontSize: opponentCard ? 11 : 14,fontWeight:900,color:'white',textShadow:'0 1px 4px rgba(0,0,0,0.7)' }}>{dv}</span>
      )}
      {showDetail && <span style={{ position:'absolute', bottom:5, right:6, fontSize:labelSize, fontWeight:900, color:'rgba(255,255,255,0.88)', lineHeight:1, transform:'rotate(180deg)', textShadow:'0 1px 3px rgba(0,0,0,0.6)' }}>{dv}</span>}
    </button>
  );
}

function ColorPicker({ onPick }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-surface border border-surfaceLight rounded-2xl p-6 text-center shadow-2xl">
        <p className="text-white font-bold text-lg mb-4">Choose a color</p>
        <div className="grid grid-cols-2 gap-3">
          {COLORS.map(c => {
            const cs = CARD_COLORS[c];
            return (
              <button key={c} onClick={() => onPick(c)}
                style={{ background:`linear-gradient(135deg,${cs.bg0},${cs.bg1})`, border:`3px solid ${cs.border}`, width:88, height:88, borderRadius:14, fontSize:32, transition:'transform 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.transform='scale(1.1)'}
                onMouseLeave={e => e.currentTarget.style.transform='none'}
              >
                {COLOR_DOT[c]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function UnoGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]               = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]         = useState(location.state?.entryFee ?? 1);
  const [statusMsg, setStatusMsg]       = useState('');
  const [privateCode, setPrivateCode]   = useState('');
  const [opponent, setOpponent]         = useState(null);
  const [roomId, setRoomId]             = useState(null);
  const [vsBot, setVsBot]               = useState(false);
  const [result, setResult]             = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [botWins, setBotWins]           = useState(0);
  const [botLosses, setBotLosses]       = useState(0);

  // Game state
  const [myHand, setMyHand]                       = useState([]);
  const [topCard, setTopCard]                     = useState(null);
  const [currentColor, setCurrentColor]           = useState('red');
  const [currentTurn, setCurrentTurn]             = useState(null);
  const [opponentCardCount, setOpponentCardCount] = useState(0);
  const [deckCount, setDeckCount]                 = useState(108);
  const [drawnThisTurn, setDrawnThisTurn]         = useState(false);
  const [drawnCard, setDrawnCard]                 = useState(null);
  const [lastAction, setLastAction]               = useState(null);
  const [wildPicker, setWildPicker]               = useState(null);
  const [animCardIdx, setAnimCardIdx]             = useState(null);
  const [timerEndsAt, setTimerEndsAt]             = useState(null);
  const [timeLeft, setTimeLeft]                   = useState(null);
  const [rushState, setRushState]                 = useState(null);     // null | 'pending' | 'called' | 'missed'
  const [rushCountdown, setRushCountdown]         = useState(5);
  const [jumpInWindow, setJumpInWindow]           = useState(null);     // { card: {color, value}, expiresAt: timestamp } | null
  const [jumpInTick, setJumpInTick]               = useState(0);        // increments every 100ms to force re-render of countdown bar
  const [hoveredCardIdx, setHoveredCardIdx]       = useState(null);
  const rushTimerRef    = useRef(null);
  const jumpInTimerRef  = useRef(null);
  const jumpInTickRef   = useRef(null);
  const prevHandLen     = useRef(0);

  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);
  const myUserIdRef  = useRef(null);
  roomIdRef.current  = roomId;
  profileRef.current = profile;

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? '💎' : '🪙';
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const isMyTurn     = currentTurn === profile?.id;
  const isWinner     = result && result.winnerId === profile?.id;

  const { RejoinOverlay } = useGamePageRejoin('uno', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('game'); },
    () => setPhase('lobby'),
  );
  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  // ── Apply state update ─────────────────────────────────────────────────────
  function applyState(data) {
    if (data.myHand !== undefined) {
      if (data.myHand.length > prevHandLen.current) {
        setAnimCardIdx(data.myHand.length - 1);
        setTimeout(() => setAnimCardIdx(null), 400);
      }
      prevHandLen.current = data.myHand.length;
      setMyHand(data.myHand);
    }
    if (data.topCard !== undefined)           setTopCard(data.topCard);
    if (data.currentColor !== undefined)      setCurrentColor(data.currentColor);
    if (data.currentTurn !== undefined) {
      setCurrentTurn(data.currentTurn);
      if (data.currentTurn !== myUserIdRef.current) setTimerEndsAt(null);
    }
    if (data.opponentCardCount !== undefined) setOpponentCardCount(data.opponentCardCount);
    if (data.deckCount !== undefined)         setDeckCount(data.deckCount);
    if (data.drawnThisTurn !== undefined)     setDrawnThisTurn(data.drawnThisTurn);
    if (data.lastAction !== undefined)        setLastAction(data.lastAction);
  }

  // ── Jump-In mechanic ──────────────────────────────────────────────────────
  function canBeJumpedIn(card) {
    return card && card.value !== 'wild' && card.value !== 'wild4' && card.value !== 'surge';
  }

  function openJumpInWindow(card) {
    if (!canBeJumpedIn(card)) return;
    if (jumpInTimerRef.current) clearTimeout(jumpInTimerRef.current);
    if (jumpInTickRef.current) clearInterval(jumpInTickRef.current);
    setJumpInWindow({ card, expiresAt: Date.now() + 2000 });
    jumpInTimerRef.current = setTimeout(() => {
      setJumpInWindow(null);
      if (jumpInTickRef.current) clearInterval(jumpInTickRef.current);
    }, 2000);
    jumpInTickRef.current = setInterval(() => setJumpInTick(t => t + 1), 100);
  }

  function handleJumpIn(cardIndex) {
    if (!jumpInWindow) return;
    const card = myHand[cardIndex];
    if (!card) return;
    if (card.color !== jumpInWindow.card.color || card.value !== jumpInWindow.card.value) return;
    // Clear jump-in window immediately
    if (jumpInTimerRef.current) clearTimeout(jumpInTimerRef.current);
    if (jumpInTickRef.current) clearInterval(jumpInTickRef.current);
    setJumpInWindow(null);
    // Play the card as a jump-in (reuse normal play — server handles turn order)
    if (card.value === 'wild' || card.value === 'wild4' || card.value === 'surge') {
      setWildPicker(cardIndex);
    } else {
      socket.emit('uno_play_card', { roomId: roomIdRef.current, cardIndex, jumpIn: true });
    }
  }

  function isJumpInMatch(card) {
    if (!jumpInWindow) return false;
    return card.color === jumpInWindow.card.color && card.value === jumpInWindow.card.value;
  }

  // ── Socket events ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    function onMatchFound(data) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      myUserIdRef.current  = profileRef.current?.id;
      setRoomId(data.roomId);
      setOpponent(data.opponent);
      if (data.entryFee !== undefined) setEntryFee(data.entryFee);
      setVsBot(!!data.vsBot);
      setResult(null);
      setDrawnCard(null);
      setLastAction(null);
      setStatusMsg('');
      applyState(data);
      setPhase('game');
    }

    function onStateUpdate(data) {
      applyState(data);
      if (data.currentTurn && data.currentTurn !== profileRef.current?.id) {
        setDrawnCard(null);
      }
      // Open jump-in window whenever a card is played (lastAction.type === 'play')
      if (data.lastAction?.type === 'play' && data.lastAction?.byPlayer !== profileRef.current?.id) {
        openJumpInWindow(data.lastAction.card);
      }
    }

    function onDrawResult(data) { setDrawnCard(data); }

    function onResult(data) {
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      if (vsBot) {
        const myId = profileRef.current?.id;
        if (!data.draw && data.winnerId === myId) setBotWins(w => w + 1);
        else if (!data.draw) setBotLosses(l => l + 1);
      }
      setPhase('result');
      refreshProfile();
    }

    function onDisconnect(data = {}) {
      const myId = profileRef.current?.id;
      const payout = data.winnerPayout ?? null;
      setResult({
        winnerId: data.winnerId || myId,
        loserId: data.loserId,
        disconnected: true,
        balanceChange: payout != null ? { winnerPayout: payout } : undefined,
        currency: data.currency,
      });
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      refreshProfile();
    }
    function onError({ message }) { setStatusMsg(message); }

    socket.on('uno_timer', ({ endsAt, currentTurn }) => {
      if (currentTurn === myUserIdRef.current) setTimerEndsAt(endsAt);
      else setTimerEndsAt(null);
    });
    socket.on('uno_match_found',        onMatchFound);
    socket.on('uno_state_update',       onStateUpdate);
    socket.on('uno_draw_result',        onDrawResult);
    socket.on('uno_result',             onResult);
    socket.on('uno_rematch_requested',  () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('opponent_disconnected',  onDisconnect);
    socket.on('error',                  onError);
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      socket.off('uno_timer');
      socket.off('uno_match_found',       onMatchFound);
      socket.off('uno_state_update',      onStateUpdate);
      socket.off('uno_draw_result',       onDrawResult);
      socket.off('uno_result',            onResult);
      socket.off('uno_rematch_requested');
      socket.off('opponent_disconnected', onDisconnect);
      socket.off('error',                 onError);
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Turn timer countdown ───────────────────────────────────────────────────
  useEffect(() => {
    if (!timerEndsAt) { setTimeLeft(null); return; }
    const tick = () => {
      const left = Math.ceil((timerEndsAt - Date.now()) / 1000);
      setTimeLeft(Math.max(0, left));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [timerEndsAt]);

  // Clear timer display when result arrives or phase changes
  useEffect(() => {
    if (phase !== 'game') {
      setTimerEndsAt(null);
      setTimeLeft(null);
      if (jumpInTimerRef.current) clearTimeout(jumpInTimerRef.current);
      if (jumpInTickRef.current) clearInterval(jumpInTickRef.current);
      setJumpInWindow(null);
    }
  }, [phase]);

  // ── Rush Call arm/disarm ───────────────────────────────────────────────────
  useEffect(() => {
    if (myHand.length === 1 && rushState === null) {
      // Arm the rush call
      setRushState('pending');
      setRushCountdown(5);
      let count = 5;
      rushTimerRef.current = setInterval(() => {
        count--;
        setRushCountdown(count);
        if (count <= 0) {
          clearInterval(rushTimerRef.current);
          setRushState('missed');
        }
      }, 1000);
    } else if (myHand.length !== 1) {
      // Disarm — hand changed
      clearInterval(rushTimerRef.current);
      setRushState(null);
      setRushCountdown(5);
    }
    return () => clearInterval(rushTimerRef.current);
  }, [myHand.length]); // only watch hand length

  // ── Actions ────────────────────────────────────────────────────────────────
  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_uno_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_uno_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_uno_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_uno_queue');
    setPhase('lobby'); setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'uno', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'uno', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function handleCardClick(cardIndex) {
    const card = myHand[cardIndex];
    if (!card) return;
    // Jump-in takes priority — available even when it's not your turn
    if (!isMyTurn && jumpInWindow && isJumpInMatch(card)) {
      handleJumpIn(cardIndex);
      return;
    }
    if (!isMyTurn || phase !== 'game') return;
    if (card.value === 'wild' || card.value === 'wild4' || card.value === 'surge') {
      setWildPicker(cardIndex);
    } else {
      socket.emit('uno_play_card', { roomId: roomIdRef.current, cardIndex });
    }
  }

  function handleWildPick(color) {
    if (wildPicker === null) return;
    socket.emit('uno_play_card', { roomId: roomIdRef.current, cardIndex: wildPicker, chosenColor: color });
    setWildPicker(null);
  }

  function handleDraw() {
    if (!isMyTurn || drawnThisTurn) return;
    socket.emit('uno_draw_card', { roomId: roomIdRef.current });
  }

  function handlePass() {
    if (!isMyTurn || !drawnThisTurn) return;
    socket.emit('uno_pass_turn', { roomId: roomIdRef.current });
    setDrawnCard(null);
  }

  function claimRush() {
    clearInterval(rushTimerRef.current);
    setRushState('called');
  }

  function resign() { socket.emit('uno_resign', { roomId: roomIdRef.current }); }

  function requestRematch() {
    socket.emit('uno_rematch_request', { roomId: roomIdRef.current });
    setStatusMsg('Rematch requested...');
  }

  function playAgainVsBot() {
    socket.emit('play_uno_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }

  function backToLobby() {
    setPhase('lobby'); setResult(null); setOpponent(null);
    setVsBot(false); setBotWins(0); setBotLosses(0); setStatusMsg('');
    clearInterval(rushTimerRef.current);
    setRushState(null);
    setRushCountdown(5);
    if (jumpInTimerRef.current) clearTimeout(jumpInTimerRef.current);
    if (jumpInTickRef.current) clearInterval(jumpInTickRef.current);
    setJumpInWindow(null);
  }

  // ── Card playability ───────────────────────────────────────────────────────
  function isCardPlayable(card) {
    if (!topCard) return false;
    if (card.value === 'wild' || card.value === 'wild4') return true;
    if (card.color === currentColor) return true;
    if (card.value === topCard.value) return true;
    return false;
  }

  // ── Last action message ────────────────────────────────────────────────────
  function actionMsg() {
    if (!lastAction) return null;
    const byMe = lastAction.byPlayer === profile?.id;
    const who  = byMe ? 'You' : (lastAction.byBot ? 'Duely Bot' : (opponent?.username ?? 'Opponent'));
    if (lastAction.type === 'play') {
      const card = lastAction.card;
      const dv   = displayValue(card.value);
      let msg = `${who} played ${dv} ${card.color !== 'wild' ? card.color : ''}`.trim();
      if (lastAction.chosenColor && (card.value === 'wild' || card.value === 'wild4' || card.value === 'surge'))
        msg += ` → ${lastAction.chosenColor}`;
      return msg;
    }
    if (lastAction.type === 'draw')      return `${who} drew a card`;
    if (lastAction.type === 'pass')      return `${who} passed their turn`;
    if (lastAction.type === 'draw_pass') return `${who} drew and passed`;
    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-2 py-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {RejoinOverlay}

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="🃏 Card Rush"
          description="Match colors and numbers, play action cards, shout Card Rush!"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
        />
      )}

      {/* ── PRIVATE WAITING ── */}
      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-white mb-2">Private Room Created</h2>
          <p className="text-muted mb-6 text-sm">Share this code with a friend to invite them</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 shadow-glow inline-block min-w-[200px]">
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary" style={{ textShadow: '0 0 20px rgba(30,144,255,0.5)' }}>
              {privateCode}
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(privateCode)}
              className="text-xs text-muted hover:text-primary mt-3 block mx-auto transition-colors"
            >
              📋 Copy to clipboard
            </button>
          </div>
          <p className="text-muted text-sm animate-pulse mb-6">Waiting for opponent to join...</p>
          <GlowButton variant="ghost" onClick={cancelPrivate} className="border border-border">Cancel</GlowButton>
        </div>
      )}

      {/* ── QUEUE ── */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* ── GAME ── */}
      {phase === 'game' && topCard && (
        <>
        <style>{`
          @keyframes unoCardIn {
            0%   { transform: rotateY(90deg) translateY(20px) scale(0.8); opacity: 0; }
            60%  { transform: rotateY(-8deg) translateY(-4px) scale(1.05); opacity: 1; }
            100% { transform: rotateY(0deg) translateY(0) scale(1); opacity: 1; }
          }
          @keyframes unoCardPlay {
            0%   { transform: translateY(0) scale(1); opacity: 1; }
            40%  { transform: translateY(-30px) scale(1.15) rotateZ(8deg); opacity: 0.8; }
            100% { transform: translateY(-80px) scale(0.7) rotateZ(15deg); opacity: 0; }
          }
          @keyframes jumpInPulse {
            0%   { opacity: 0.7; box-shadow: 0 0 8px rgba(251,191,36,0.5); }
            100% { opacity: 1;   box-shadow: 0 0 22px rgba(251,191,36,1); }
          }
          .uno-hand-scroll::-webkit-scrollbar { height: 4px; }
          .uno-hand-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 2px; }
          .uno-hand-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
        `}</style>
        <div className="w-full max-w-3xl flex flex-col gap-2 animate-fade-in">

          {/* Top bar */}
          <div className="flex items-center justify-between px-1">
            <button onClick={backToLobby} className="text-muted hover:text-white text-sm transition-colors">← Back</button>
            <span className="text-white font-bold tracking-wide">🃏 Card Rush</span>
            <button onClick={resign} className="text-danger hover:text-red-400 text-sm transition-colors font-semibold">Resign</button>
          </div>

          {/* ── Main table ── */}
          <div style={{
            background: 'radial-gradient(ellipse at center, #2a5a3a 0%, #1a4a2a 45%, #0f2a1a 100%)',
            borderRadius: 16,
            padding: '20px 16px 24px',
            minHeight: 520,
            position: 'relative',
            boxShadow: 'inset 0 2px 32px rgba(0,0,0,0.5), 0 8px 32px rgba(0,0,0,0.6)',
          }}>

            {/* ── Opponent area (top) ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              {/* Opponent name label */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: '50%',
                  background: `linear-gradient(135deg,${CARD_COLORS[currentColor]?.bg0 ?? '#444'},${CARD_COLORS[currentColor]?.bg1 ?? '#222'})`,
                  border: `2px solid ${CARD_COLORS[currentColor]?.border ?? '#888'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 900, color: 'white', flexShrink: 0,
                }}>
                  {(opponent?.username?.[0] ?? 'O').toUpperCase()}
                </div>
                <span style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 600, fontSize: 14 }}>{opponent?.username ?? 'Opponent'}</span>
                <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>{opponentCardCount} card{opponentCardCount !== 1 ? 's' : ''}</span>
                {opponentCardCount === 1 && (
                  <span style={{ fontSize: 11, background: 'rgba(220,50,50,0.3)', color: '#fca5a5', border: '1px solid rgba(220,50,50,0.5)', padding: '1px 8px', borderRadius: 20, fontWeight: 900 }} className="animate-pulse">Card Rush!</span>
                )}
                {!isMyTurn && opponentCardCount !== 1 && (
                  <span style={{ fontSize: 11, background: 'rgba(251,191,36,0.15)', color: '#fcd34d', border: '1px solid rgba(251,191,36,0.3)', padding: '1px 8px', borderRadius: 20, fontWeight: 700 }} className="animate-pulse">their turn</span>
                )}
              </div>

              {/* Opponent face-down cards — fanned arc */}
              <div style={{
                perspective: '600px',
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                minHeight: 90,
                paddingTop: 20,
              }}>
                {opponentCardCount === 0 && <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>No cards</span>}
                {Array.from({ length: Math.min(opponentCardCount, 16) }).map((_, i) => {
                  const N      = Math.min(opponentCardCount, 16);
                  const center = (N - 1) / 2;
                  const offset = i - center;
                  const rot    = offset * 4;
                  const dip    = Math.abs(offset) * 5;
                  return (
                    <div key={i} style={{
                      flexShrink: 0,
                      marginLeft: i === 0 ? 0 : -28,
                      transform: `rotate(${rot}deg) translateY(${dip}px)`,
                      transformOrigin: 'bottom center',
                      zIndex: i,
                    }}>
                      <UnoCard faceDown opponentCard />
                    </div>
                  );
                })}
                {opponentCardCount > 16 && (
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, alignSelf: 'center', marginLeft: 6 }}>+{opponentCardCount - 16}</span>
                )}
              </div>
            </div>

            {/* ── Center: Draw pile + Discard + Color indicator ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 16 }}>

              {/* Draw pile */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={handleDraw}
                  disabled={!isMyTurn || drawnThisTurn}
                  style={{
                    width: 100, height: 150, borderRadius: 14,
                    border: '3px solid rgba(255,255,255,0.2)',
                    background: 'linear-gradient(135deg,#1e1040 0%,#3b0f7a 50%,#1e1040 100%)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    cursor: isMyTurn && !drawnThisTurn ? 'pointer' : 'default',
                    opacity: isMyTurn && !drawnThisTurn ? 1 : 0.45,
                    transition: 'transform 0.15s, box-shadow 0.15s',
                    boxShadow: isMyTurn && !drawnThisTurn
                      ? '0 0 20px rgba(120,60,255,0.55), 0 6px 16px rgba(0,0,0,0.6)'
                      : '0 6px 16px rgba(0,0,0,0.5)',
                    position: 'relative', overflow: 'hidden',
                  }}
                  onMouseEnter={e => { if (isMyTurn && !drawnThisTurn) { e.currentTarget.style.transform = 'scale(1.06) translateY(-4px)'; }}}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(45deg,rgba(255,255,255,0.04) 0px,rgba(255,255,255,0.04) 2px,transparent 2px,transparent 10px)' }} />
                  <span style={{ fontSize: 11, fontWeight: 900, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.12em', zIndex: 1, marginBottom: 4 }}>DRAW</span>
                  <span style={{ fontSize: 26, fontWeight: 900, color: 'rgba(255,255,255,0.88)', zIndex: 1, lineHeight: 1 }}>{deckCount}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.3)', zIndex: 1, marginTop: 4, letterSpacing: '0.1em' }}>CARDS LEFT</span>
                </button>
                <span style={{ color: 'rgba(134,239,172,0.65)', fontSize: 11, fontWeight: 600 }}>Draw Pile</span>
              </div>

              {/* Discard pile — large top card */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{ position: 'relative' }}>
                  {/* Stacked shadow cards behind */}
                  <div style={{ position: 'absolute', top: 6, left: 5, width: 100, height: 150, borderRadius: 14, background: 'rgba(0,0,0,0.35)', zIndex: 0, transform: 'rotate(2deg)' }} />
                  <div style={{ position: 'absolute', top: 3, left: 2, width: 100, height: 150, borderRadius: 14, background: 'rgba(0,0,0,0.25)', zIndex: 0, transform: 'rotate(-1deg)' }} />
                  <div style={{ position: 'relative', zIndex: 1, filter: 'drop-shadow(0 8px 20px rgba(0,0,0,0.6))', transform: 'rotate(-2deg)' }}>
                    <UnoCard card={topCard} medium />
                  </div>
                </div>
                <span style={{ color: 'rgba(134,239,172,0.65)', fontSize: 11, fontWeight: 600 }}>Discard</span>
              </div>

              {/* Active color indicator */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 100, height: 150, borderRadius: 14,
                  background: `linear-gradient(155deg,${CARD_COLORS[currentColor]?.bg0 ?? '#444'},${CARD_COLORS[currentColor]?.bg1 ?? '#222'})`,
                  border: `3px solid ${CARD_COLORS[currentColor]?.border ?? '#888'}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                  boxShadow: `0 0 20px ${CARD_COLORS[currentColor]?.border ?? '#888'}55, 0 6px 16px rgba(0,0,0,0.5)`,
                }}>
                  <span style={{ fontSize: 38 }}>{COLOR_DOT[currentColor] ?? '⚪'}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{currentColor}</span>
                </div>
                <span style={{ color: 'rgba(134,239,172,0.65)', fontSize: 11, fontWeight: 600 }}>Active Color</span>
              </div>
            </div>

            {/* Timer bar */}
            {timeLeft !== null && (
              <div style={{ marginBottom: 8, padding: '0 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: timeLeft <= 5 ? '#f87171' : timeLeft <= 10 ? '#fbbf24' : '#4ade80' }}>
                    ⏱ Your turn: {timeLeft}s
                  </span>
                </div>
                <div style={{ width: '100%', borderRadius: 9999, overflow: 'hidden', height: 5, background: 'rgba(255,255,255,0.1)' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.max(0, (timeLeft / 20) * 100)}%`,
                    background: timeLeft <= 5 ? '#f87171' : timeLeft <= 10 ? '#fbbf24' : '#4ade80',
                    transition: 'width 0.25s linear, background 0.5s',
                  }} />
                </div>
              </div>
            )}

            {/* Status / action message */}
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              {isMyTurn ? (
                <span style={{ color: '#86efac', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>✦ Your Turn</span>
              ) : (
                <span style={{ color: 'rgba(134,239,172,0.4)', fontSize: 13 }}>Waiting for opponent…</span>
              )}
              {actionMsg() && <p style={{ color: 'rgba(134,239,172,0.35)', fontSize: 11, marginTop: 3 }}>{actionMsg()}</p>}
            </div>

            {/* Pass turn button */}
            {isMyTurn && drawnThisTurn && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, gap: 10 }}>
                {drawnCard?.canPlay && (
                  <span style={{ color: '#86efac', fontSize: 12, alignSelf: 'center', fontWeight: 600 }}>Playable — or pass:</span>
                )}
                <button onClick={handlePass}
                  style={{ padding: '7px 20px', borderRadius: 12, background: 'rgba(20,83,45,0.7)', color: '#86efac', fontSize: 13, fontWeight: 700, border: '1px solid rgba(34,197,94,0.4)', cursor: 'pointer', transition: 'background 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,83,45,0.95)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(20,83,45,0.7)'}
                >
                  Pass Turn
                </button>
              </div>
            )}

            {/* Rush Call mechanic */}
            {myHand.length === 1 && rushState === 'pending' && (
              <button
                onClick={claimRush}
                style={{
                  width: '100%', borderRadius: 16, fontWeight: 900, fontSize: 22, padding: '13px 0',
                  background: 'linear-gradient(135deg,#dc2020 0%,#ca8a04 100%)',
                  boxShadow: `0 0 ${10 + rushCountdown * 4}px rgba(220,50,50,0.7), 0 4px 16px rgba(0,0,0,0.4)`,
                  border: '2px solid rgba(255,255,255,0.3)',
                  color: 'white', cursor: 'pointer',
                  animation: 'unoCardIn 0.3s ease both',
                  letterSpacing: '0.06em',
                  marginBottom: 8,
                  userSelect: 'none',
                }}
              >
                🚨 RUSH! ({rushCountdown}s)
              </button>
            )}

            {rushState === 'called' && (
              <div style={{ width: '100%', borderRadius: 14, padding: '10px 0', textAlign: 'center', fontWeight: 900, fontSize: 18, background: 'rgba(34,197,94,0.15)', border: '2px solid rgba(34,197,94,0.5)', color: '#4ade80', letterSpacing: '0.05em', marginBottom: 8 }}>
                ✅ RUSH! Called!
              </div>
            )}

            {rushState === 'missed' && (
              <div style={{ width: '100%', borderRadius: 14, padding: '10px 0', textAlign: 'center', fontWeight: 900, fontSize: 16, background: 'rgba(239,68,68,0.12)', border: '2px solid rgba(239,68,68,0.4)', color: '#f87171', marginBottom: 8 }}>
                ❌ Rush missed — call it faster next time!
              </div>
            )}

            {/* ── Player hand (bottom) ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, padding: '0 4px' }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                {profile?.username ?? 'You'} ({myHand.length})
              </span>
              {isMyTurn && myHand.length !== 1 && (
                <span style={{ color: '#4ade80', fontSize: 11, fontWeight: 700 }} className="animate-pulse">▶ Play a card</span>
              )}
              {myHand.length === 1 && (
                <span style={{ fontSize: 12, fontWeight: 900, color: rushState === 'called' ? '#4ade80' : rushState === 'missed' ? '#f87171' : '#fbbf24' }} className="animate-pulse">
                  {rushState === 'called' ? '✅ RUSH!' : rushState === 'missed' ? '❌ Missed' : '⚡ Last card!'}
                </span>
              )}
            </div>

            {/* Jump-in countdown bar */}
            {jumpInWindow && (() => {
              void jumpInTick;
              const msLeft = jumpInWindow.expiresAt - Date.now();
              const pct    = Math.max(0, Math.min(100, (msLeft / 2000) * 100));
              return (
                <div style={{ padding: '0 4px', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 900, color: '#fbbf24', letterSpacing: '0.06em' }}>⚡ JUMP IN! ({(msLeft / 1000).toFixed(1)}s)</span>
                  </div>
                  <div style={{ width: '100%', borderRadius: 9999, overflow: 'hidden', height: 4, background: 'rgba(255,255,255,0.1)' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#f59e0b,#fbbf24)', transition: 'width 0.1s linear', borderRadius: 9999 }} />
                  </div>
                </div>
              );
            })()}

            {/* Arc hand container — larger cards */}
            <div
              className="uno-hand-scroll"
              style={{
                perspective: '800px',
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                minHeight: 160,
                paddingTop: 40,
                paddingBottom: 4,
                paddingLeft: 16,
                paddingRight: 16,
                overflowX: myHand.length > 10 ? 'auto' : 'visible',
                overflowY: 'visible',
              }}
            >
              {myHand.length === 0 && <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, alignSelf: 'center' }}>No cards</span>}
              {myHand.map((card, i) => {
                const N         = myHand.length;
                const center    = (N - 1) / 2;
                const offset    = i - center;
                const rotation  = offset * 5;
                const dip       = Math.abs(offset) * 8;
                const isHovered = hoveredCardIdx === i;
                const playable  = isMyTurn && isCardPlayable(card);
                const isDrawn   = drawnCard && i === myHand.length - 1 && drawnThisTurn;
                const jumpMatch = isJumpInMatch(card);

                const baseTransform  = `rotate(${rotation}deg) translateY(${dip}px)`;
                const hoverTransform = `rotate(${rotation}deg) translateY(${dip - 25}px) scale(1.08)`;

                const isClickable = (playable) || (!isMyTurn && jumpMatch && jumpInWindow);

                return (
                  <div
                    key={`${i}-${card.color}-${card.value}`}
                    style={{
                      position: 'relative',
                      flexShrink: 0,
                      marginLeft: i === 0 ? 0 : -30,
                      zIndex: isHovered ? N + 10 : i,
                      transform: isHovered ? hoverTransform : baseTransform,
                      transformOrigin: 'bottom center',
                      transition: 'transform 0.2s ease, z-index 0s',
                    }}
                    onMouseEnter={() => setHoveredCardIdx(i)}
                    onMouseLeave={() => setHoveredCardIdx(null)}
                  >
                    {/* Jump-in label */}
                    {jumpMatch && jumpInWindow && (
                      <div style={{
                        position: 'absolute',
                        top: -22,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        background: 'linear-gradient(135deg,#b45309,#fbbf24)',
                        color: '#1a0a00',
                        fontSize: 9,
                        fontWeight: 900,
                        padding: '2px 6px',
                        borderRadius: 6,
                        whiteSpace: 'nowrap',
                        letterSpacing: '0.05em',
                        boxShadow: '0 0 8px rgba(251,191,36,0.8)',
                        animation: 'jumpInPulse 0.6s ease-in-out infinite alternate',
                        zIndex: 2,
                      }}>
                        JUMP IN!
                      </div>
                    )}
                    <UnoCard
                      card={card}
                      onClick={isClickable ? () => handleCardClick(i) : undefined}
                      disabled={!isClickable}
                      glow={playable || isDrawn || (jumpMatch && !!jumpInWindow)}
                      animIn={i === animCardIdx}
                      large
                    />
                    {/* Golden pulsing border overlay for jump-in */}
                    {jumpMatch && jumpInWindow && (
                      <div style={{
                        position: 'absolute',
                        inset: -3,
                        borderRadius: 15,
                        border: '3px solid #fbbf24',
                        boxShadow: '0 0 16px rgba(251,191,36,0.9), inset 0 0 8px rgba(251,191,36,0.3)',
                        animation: 'jumpInPulse 0.6s ease-in-out infinite alternate',
                        pointerEvents: 'none',
                        zIndex: 3,
                      }} />
                    )}
                  </div>
                );
              })}
            </div>

          </div>{/* end table */}

          {vsBot && (
            <div style={{ textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
              Bot session — Wins: {botWins} | Losses: {botLosses}
            </div>
          )}
        </div>
        </>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          {vsBot && (
            <p className="text-sm text-accent mb-3 font-bold">Bot session: {botWins}W — {botLosses}L</p>
          )}
          <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>
            {result.draw ? '🤝' : isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-2 ${result.draw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`}>
            {result.draw ? 'Draw!' : isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}
          {!result.disconnected && result.reason && <p className="text-sm text-muted mb-3 capitalize">{result.reason.replace(/_/g, ' ')}</p>}

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
            {!result.draw && (() => {
              const myNewElo = isWinner ? result.newWinnerElo : result.newLoserElo;
              const eloDelta = myNewElo - (eloBeforeRef.current ?? myNewElo);
              return (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted">Your ELO</span>
                    <span className="text-white font-bold">
                      {myNewElo}{' '}
                      <span className={eloDelta >= 0 ? 'text-success' : 'text-danger'}>
                        ({eloDelta >= 0 ? '+' : ''}{eloDelta})
                      </span>
                    </span>
                  </div>
                  {result.balanceChange && (
                    <div className="flex justify-between">
                      <span className="text-muted">{isWinner ? 'Payout' : 'Entry lost'}</span>
                      <span className={isWinner ? 'text-success font-bold' : 'text-danger font-bold'}>
                        {isWinner
                          ? `+${resultCurrency === 'diamonds' ? Math.round(result.balanceChange.winnerPayout) + ' 💎' : result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
                          : `-${entryFee} ${resultCurrency === 'diamonds' ? '💎' : '🪙'}`}
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          <div className="flex gap-3">
            <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
            {vsBot
              ? <GlowButton variant="primary" onClick={playAgainVsBot} className="flex-1">Play Again</GlowButton>
              : <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
            }
          </div>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
          {statusMsg && <p className="text-muted text-xs mt-3">{statusMsg}</p>}
        </div>
      </div>
      )}

      {/* Wild color picker */}
      {wildPicker !== null && <ColorPicker onPick={handleWildPick} />}
    </div>
  );
}


