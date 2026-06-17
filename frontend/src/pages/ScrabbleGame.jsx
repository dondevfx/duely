import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import ResultScreen from '../components/ResultScreen';
import { usePageReady } from '../hooks/usePageReady';

const COIN_FEES    = [1, 5, 10];
const DIAMOND_FEES = [100, 500];

const BOARD_SIZE = 6;

const PREMIUM = {
  '0,0': 'TW', '0,5': 'TW', '5,0': 'TW', '5,5': 'TW',
  '1,1': 'DW', '1,4': 'DW', '4,1': 'DW', '4,4': 'DW',
  '0,2': 'TL', '0,3': 'TL', '2,0': 'TL', '3,0': 'TL',
  '2,5': 'TL', '3,5': 'TL', '5,2': 'TL', '5,3': 'TL',
  '2,2': '★',
  '2,3': 'DL', '3,2': 'DL', '3,3': 'DL',
};

const LETTER_VALUES = {
  A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,
  N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'?':0,
};

// Subdued, easy-on-the-eyes premium colors
const PREMIUM_COLORS = {
  'TW': { bg: '#3d1212', border: '#922',   label: 'TW', textColor: '#e88' },
  'DW': { bg: '#3a1e0a', border: '#964',   label: 'DW', textColor: '#daa' },
  'TL': { bg: '#0c1f38', border: '#336',   label: 'TL', textColor: '#79a' },
  'DL': { bg: '#0c1a2a', border: '#245',   label: 'DL', textColor: '#68a' },
  '★':  { bg: '#1a1500', border: '#665520', label: '★',  textColor: '#bb9' },
};

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// ── Turn timer bar (matches the style of other game pages) ────────────────────
function TurnTimerBar({ seconds, total = 60 }) {
  const pct = Math.max(0, seconds / total);
  const color = pct > 0.4 ? '#22c55e' : pct > 0.15 ? '#f59e0b' : '#ef4444';
  return (
    <div className="w-full h-1.5 bg-surfaceLight rounded-full overflow-hidden mb-3">
      <div
        className="h-full rounded-full transition-all duration-1000"
        style={{ width: `${pct * 100}%`, background: color, boxShadow: `0 0 6px ${color}88` }}
      />
    </div>
  );
}

function TileButton({ letter, selected, onClick, onDragStart, onDragEnd, dragging, onTouchStart }) {
  const val = LETTER_VALUES[letter] ?? 0;
  const isBlank = letter === '?';
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onTouchStart={onTouchStart}
      className="relative flex-shrink-0 flex items-center justify-center select-none transition-all"
      style={{
        width: CELL_SIZE - 8, height: CELL_SIZE - 8,
        borderRadius: 8,
        background: isBlank ? '#7c6a44' : '#e8d5a8',
        border: selected ? '2.5px solid #1E90FF' : '2px solid #b8985a',
        boxShadow: selected
          ? '0 0 16px rgba(30,144,255,0.8), 0 3px 6px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.3)'
          : '0 3px 6px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -2px 0 rgba(0,0,0,0.2)',
        color: isBlank ? '#f5e6c8' : '#2c1a00',
        fontSize: 26,
        fontWeight: 900,
        opacity: dragging ? 0.35 : 1,
        transform: selected ? 'translateY(-3px)' : 'none',
      }}
    >
      {isBlank ? '?' : letter}
      <span style={{
        position: 'absolute', bottom: 2, right: 4,
        fontSize: 9, fontWeight: 700,
        color: isBlank ? 'rgba(245,230,200,0.7)' : 'rgba(80,50,10,0.6)',
        lineHeight: 1,
      }}>
        {val > 0 ? val : ''}
      </span>
    </button>
  );
}

// Responsive cell size
// Mobile: fit within screen width (max 52px) so board never overflows
// Desktop: allow larger cells (max 72px)
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
const CELL_SIZE = typeof window !== 'undefined'
  ? isMobile
    ? Math.min(52, Math.floor((window.innerWidth - 24) / 6))
    : Math.min(72, Math.floor((Math.min(window.innerWidth, 520) - 32) / 6))
  : 60;

function BoardCell({ row, col, cell, pending, myTurn, onClick, onRemove, onDragOver, onDrop }) {
  const prem      = PREMIUM[`${row},${col}`];
  const premStyle = prem ? PREMIUM_COLORS[prem] : null;
  const hasPending = pending != null;

  const bg = hasPending
    ? '#e8d5a8'
    : cell
      ? '#e8d5a8'
      : premStyle
        ? premStyle.bg
        : '#162032';

  const borderCol = hasPending
    ? '#1E90FF'
    : cell
      ? '#b8985a'
      : premStyle
        ? premStyle.border
        : '#1e3050';

  return (
    <div
      onClick={onClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-row={row}
      data-col={col}
      style={{
        width: CELL_SIZE, height: CELL_SIZE,
        borderRadius: 6,
        background: bg,
        border: `${hasPending ? 2.5 : 1.5}px solid ${borderCol}`,
        boxShadow: hasPending
          ? '0 0 10px rgba(30,144,255,0.6), inset 0 1px 0 rgba(255,255,255,0.25)'
          : cell
            ? '0 2px 4px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2), inset 0 -2px 0 rgba(0,0,0,0.15)'
            : premStyle
              ? `0 0 6px ${premStyle.border}55`
              : 'inset 0 1px 0 rgba(255,255,255,0.03)',
        cursor: hasPending ? 'pointer' : cell ? 'default' : myTurn ? 'pointer' : 'default',
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        transition: 'box-shadow 0.1s',
      }}
    >
      {cell ? (
        <>
          <span style={{ fontSize: 26, fontWeight: 900, color: '#2c1a00', lineHeight: 1 }}>
            {cell.letter}
          </span>
          <span style={{ position: 'absolute', bottom: 2, right: 3, fontSize: 9, fontWeight: 700, color: 'rgba(80,50,10,0.6)', lineHeight: 1 }}>
            {LETTER_VALUES[cell.letter] || ''}
          </span>
        </>
      ) : hasPending ? (
        <>
          <span style={{ fontSize: 26, fontWeight: 900, color: '#1E90FF', lineHeight: 1 }}>
            {pending.displayLetter || pending.letter}
          </span>
          <span style={{ position: 'absolute', bottom: 2, right: 3, fontSize: 9, fontWeight: 700, color: 'rgba(30,144,255,0.6)', lineHeight: 1 }}>
            {LETTER_VALUES[pending.letter] || ''}
          </span>
          <div style={{ position: 'absolute', top: -4, right: -4, width: 10, height: 10, borderRadius: '50%', background: '#1E90FF', border: '1.5px solid #0d1929' }} />
        </>
      ) : premStyle ? (
        <span style={{ fontSize: 13, color: premStyle.textColor, fontWeight: 900, letterSpacing: '-0.02em', textAlign: 'center', lineHeight: 1.1, userSelect: 'none' }}>
          {premStyle.label}
        </span>
      ) : null}
    </div>
  );
}

function BlankPicker({ onPick, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-surfaceLight rounded-2xl p-6 max-w-xs w-full">
        <div className="text-white font-black text-lg mb-1 text-center">Choose a letter for your blank</div>
        <div className="text-muted text-xs text-center mb-4">Blank tiles are worth 0 points</div>
        <div className="grid grid-cols-7 gap-1.5">
          {ALPHA.map(l => (
            <button key={l} onClick={() => onPick(l)}
              className="py-2 rounded-lg bg-surfaceLight text-white text-sm font-black hover:bg-primary transition-all border border-border hover:border-primary">
              {l}
            </button>
          ))}
        </div>
        <button onClick={onCancel} className="w-full mt-4 py-2 rounded-xl text-sm text-muted hover:text-white border border-border transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function ScrabbleGame() {
  const ready = usePageReady();
  const { profile, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const location = useLocation();
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();

  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line

  const [phase, _setPhase]         = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const [privateCode, setPrivateCode] = useState('');
  const [entryFee, setEntryFee]   = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [opponent, setOpponent]   = useState(null);
  const [roomId, setRoomId]       = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [result, setResult]       = useState(null);
  const [statusMsg, setStatusMsg] = useState('');

  // Game state
  const [board, setBoard]         = useState(() => Array.from({length:BOARD_SIZE},()=>Array(BOARD_SIZE).fill(null)));
  const [myHand, setMyHand]       = useState([]);
  const [scores, setScores]       = useState({});
  const [myTurn, setMyTurn]       = useState(false);
  const [bagCount, setBagCount]   = useState(0);
  const [turnSeconds, setTurnSeconds] = useState(0);
  const [lastWords, setLastWords] = useState([]);
  const [lastScore, setLastScore] = useState(null);
  const [mySkips, setMySkips]     = useState(0); // track personal skips (max 1)

  // Placement state — pending holds tiles removed from hand but not yet on board permanently
  const [selectedHandIdx, setSelectedHandIdx] = useState(null);
  const [draggingIdx, setDraggingIdx]         = useState(null); // index being dragged
  const [pending, setPending]       = useState({});
  const [blankPick, setBlankPick]   = useState(null);
  const [submitting, setSubmitting] = useState(false); // disable Play Word while waiting

  // Touch drag state
  const [touchDragPos, setTouchDragPos]   = useState(null); // { x, y } for ghost
  const touchDragIdxRef = useRef(null);  // which tile is being touch-dragged

  // Exchange mode
  const [exchangeMode, setExchangeMode] = useState(false);
  const [exchangeSel, setExchangeSel]   = useState(new Set());

  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const phaseRef     = useRef(location.state?.autoQueue ? 'queue' : 'lobby');
  function setPhase(p) { phaseRef.current = p; _setPhase(p); }
  const gameOverRef  = useRef(false); // true once result/forfeit received — blocks stale game events
  const eloBeforeRef = useRef(null);
  const timerRef     = useRef(null);
  // Keep a snapshot of the hand BEFORE placing tiles (so we can restore on error)
  const handBeforeRef = useRef([]);
  const socketRef        = useRef(socket);
  const inActiveMatchRef = useRef(false);
  const refreshProfileRef = useRef(refreshProfile);

  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { roomIdRef.current  = roomId;  }, [roomId]);
  useEffect(() => { socketRef.current  = socket;  }, [socket]);
  useEffect(() => { refreshProfileRef.current = refreshProfile; }, [refreshProfile]);

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

  // Lock scroll during active game on mobile
  useEffect(() => {
    if (phase === 'playing') {
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
      return () => {
        document.body.style.overflow = '';
        document.body.style.touchAction = '';
      };
    }
  }, [phase]);

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const balance      = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && balance < entryFee;
  const isWinner     = result && result.winnerId === profile?.id;

  // These hooks must be declared before any early return (Rules of Hooks)
  const _autoFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _autoFired.current || !authenticated || !socket) return;
    _autoFired.current = true;
    joinQueue();
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps



  // Touch drag-and-drop for tile placement (mobile iOS/Android)
  function handleTileTouchStart(idx, e) {
    if (!myTurn || phase !== 'game' || submitting || exchangeMode) return;
    e.preventDefault();
    touchDragIdxRef.current = idx;
    setDraggingIdx(idx);
    const t = e.touches[0];
    setTouchDragPos({ x: t.clientX, y: t.clientY });
  }

  useEffect(() => {
    function onTouchMove(e) {
      if (touchDragIdxRef.current === null) return;
      e.preventDefault();
      const t = e.touches[0];
      setTouchDragPos({ x: t.clientX, y: t.clientY });
    }
    function onTouchEnd(e) {
      if (touchDragIdxRef.current === null) return;
      const idx = touchDragIdxRef.current;
      touchDragIdxRef.current = null;
      setDraggingIdx(null);
      setTouchDragPos(null);

      // Find the element under the final touch point
      const t = e.changedTouches[0];
      // Temporarily hide the ghost so it doesn't block elementFromPoint
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (!el) return;

      // Walk up the DOM to find a board cell with data-row/data-col
      let target = el;
      for (let i = 0; i < 6; i++) {
        if (!target) break;
        const row = target.dataset?.row;
        const col = target.dataset?.col;
        if (row !== undefined && col !== undefined) {
          // Simulate a drop on this cell
          handleCellDropByTouch(parseInt(row), parseInt(col), idx);
          return;
        }
        target = target.parentElement;
      }
    }
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [myTurn, phase, submitting, exchangeMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn timer countdown
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (turnSeconds > 0 && phase === 'game' && myTurn) {
      timerRef.current = setInterval(() => setTurnSeconds(s => Math.max(0, s - 1)), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [turnSeconds, phase, myTurn]);

  // ── Socket events ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    socket.on('scrabble_match_found', ({ roomId: rid, opponent: opp, entryFee: fee, currency: cur }) => {
      eloBeforeRef.current = profileRef.current?.elo ?? null;
      inActiveMatchRef.current = true; // mark active from match_found so forfeit fires during countdown too
      gameOverRef.current = false; // reset for new match
      setRoomId(rid); setOpponent(opp); setPhase('countdown'); setCountdown(3);
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

    socket.on('scrabble_countdown', ({ count }) => setCountdown(count));

    socket.on('scrabble_start', ({ board: b, scores: sc, bagCount: bc, firstTurnSocketId }) => {
      if (gameOverRef.current) return; // opponent already left — don't overwrite result screen
      inActiveMatchRef.current = true;
      setBoard(b.map(r => r.map(c => c)));
      setScores(sc); setBagCount(bc);
      setMyTurn(firstTurnSocketId === socket.id);
      setPhase('game');
      setStatusMsg('');  // clear any queue/lobby messages
      setLastWords([]); setLastScore(null);
      setPending({}); setSelectedHandIdx(null);
      setExchangeMode(false); setExchangeSel(new Set());
      setMySkips(0); setSubmitting(false);
    });

    socket.on('scrabble_your_hand', ({ hand }) => {
      if (gameOverRef.current) return;
      setMyHand(hand);
      handBeforeRef.current = hand;
    });

    socket.on('scrabble_word_played', ({ board: b, scores: sc, bagCount: bc, nextTurn, words, score }) => {
      if (gameOverRef.current) return;
      setBoard(b.map(r => r.map(c => c)));
      setScores(sc); setBagCount(bc);
      setMyTurn(nextTurn === socket.id);
      setLastWords(words || []); setLastScore(score);
      setPending({}); setSelectedHandIdx(null);
      setSubmitting(false);
      setTurnSeconds(0);
    });

    socket.on('scrabble_new_tiles', ({ hand }) => {
      if (gameOverRef.current) return;
      setMyHand(hand);
      handBeforeRef.current = hand;
    });

    socket.on('scrabble_skipped', ({ nextTurn }) => {
      if (gameOverRef.current) return;
      setMyTurn(nextTurn === socket.id);
      setLastWords([]); setLastScore(null);
      setTurnSeconds(0);
    });

    socket.on('scrabble_exchanged', ({ nextTurn, bagCount: bc }) => {
      if (gameOverRef.current) return;
      setMyTurn(nextTurn === socket.id);
      setBagCount(bc);
      setExchangeMode(false); setExchangeSel(new Set());
      setTurnSeconds(0);
    });

    socket.on('scrabble_turn', ({ socketId: sid, timeLimit }) => {
      if (gameOverRef.current) return; // block after game over — prevents stale turn timer restart
      if (sid === socket.id) setTurnSeconds(timeLimit);
      else setTurnSeconds(0);
    });

    // On error: RESTORE tiles from pending back to hand — don't lose them
    socket.on('scrabble_error', ({ error }) => {
      setStatusMsg(error);
      setSubmitting(false);
      // Restore the hand + pending back to what it was before submit
      // (hand before placing tiles is stored in handBeforeRef before any placement)
      // The simplest restore: add pending tiles back to the current hand
      setPending(prev => {
        // These tiles are still in pending — just keep them there (user can recall)
        return prev;
      });
      setTimeout(() => setStatusMsg(''), 3500);
    });

    socket.on('scrabble_result', (res) => {
      if (!inActiveMatchRef.current) return; // stale event after leaving — ignore
      inActiveMatchRef.current = false;
      gameOverRef.current = true;
      const myId = profileRef.current?.id;
      const isWin = res.winnerId === myId;
      const payout = res.balanceChange?.winnerPayout ?? res.winnerPayout;
      const isDiamonds = res.currency === 'diamonds';
      if (payout != null && isWin) {
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) + payout) }
          : { c_coins:  Math.max(0, (profileRef.current?.c_coins  ?? 0) + payout) }
        );
      }
      setResult(res); setPhase('result'); refreshProfile();
    });

    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code); setPhase('private_waiting');
    });

    socket.on('private_room_error', ({ message }) => {
      setStatusMsg(message); setPhase('lobby');
    });

    socket.on('opponent_disconnected', (data = {}) => {
      if (!inActiveMatchRef.current) return; // stale event after leaving — ignore
      inActiveMatchRef.current = false;
      gameOverRef.current = true;
      const myId = profileRef.current?.id;
      const isWin = data.winnerId === myId;
      const payout = data.winnerPayout ?? null;
      const isDiamonds = data.currency === 'diamonds';
      if (payout != null && isWin) {
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) + payout) }
          : { c_coins:  Math.max(0, (profileRef.current?.c_coins  ?? 0) + payout) }
        );
      }
      if (data.newWinnerElo != null) eloBeforeRef.current = isWin ? data.newWinnerElo - 25 : data.newLoserElo + 25;
      setResult({
        winnerId: data.winnerId || myId,
        loserId: data.loserId,
        winnerUsername: isWin ? profileRef.current?.username : opponent?.username,
        loserUsername: isWin ? opponent?.username : profileRef.current?.username,
        disconnected: true,
        balanceChange: payout != null ? { winnerPayout: isWin ? payout : 0 } : undefined,
        entryFee:     data.entryFee,
        currency: data.currency,
        newWinnerElo: data.newWinnerElo,
        newLoserElo:  data.newLoserElo,
      });
      setPhase('result'); refreshProfile();
    });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      socket.off('scrabble_match_found');
      socket.off('match_cancelled');
      socket.off('scrabble_countdown');
      socket.off('scrabble_start');
      socket.off('scrabble_your_hand');
      socket.off('scrabble_word_played');
      socket.off('scrabble_new_tiles');
      socket.off('scrabble_skipped');
      socket.off('scrabble_exchanged');
      socket.off('scrabble_turn');
      socket.off('scrabble_error');
      socket.off('scrabble_result');
      socket.off('private_room_created');
      socket.off('private_room_error');
      socket.off('opponent_disconnected');
    };
  }, [socket, opponent]);

  // ── Actions ────────────────────────────────────────────────────────────────
  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_scrabble_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent…');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_scrabble_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match…');
  }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'scrabble', entryFee: fee, currency: cur });
  }

  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'scrabble', code });
  }

  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_scrabble_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting bot match…');
  }

  function leaveQueue() {
    socket.emit('leave_scrabble_queue');
    setPhase('lobby'); setStatusMsg('');
  }

  function backToLobby() {
    setPhase('lobby'); setResult(null); setOpponent(null); setRoomId(null);
    setBoard(Array.from({length:BOARD_SIZE},()=>Array(BOARD_SIZE).fill(null)));
    setMyHand([]); setScores({}); setMyTurn(false); setPending({});
    setSelectedHandIdx(null); setLastWords([]); setLastScore(null);
    setExchangeMode(false); setExchangeSel(new Set());
    setMySkips(0); setSubmitting(false); setTurnSeconds(0);
  }

  // ── Placement ─────────────────────────────────────────────────────────────
  function handleHandClick(idx) {
    if (!myTurn || phase !== 'game') return;
    if (exchangeMode) {
      setExchangeSel(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
      return;
    }
    setSelectedHandIdx(prev => prev === idx ? null : idx);
  }

  function handleCellClick(row, col) {
    if (!myTurn || phase !== 'game' || submitting) return;
    const key = `${row},${col}`;
    // Clicking a pending tile returns it to the hand
    if (pending[key]) { removePending(row, col); return; }
    if (board[row][col]) return;
    if (selectedHandIdx === null) return;
    const tile = myHand[selectedHandIdx];
    if (!tile) return;
    if (tile === '?') { setBlankPick({ row, col }); return; }
    placeTile(row, col, tile, tile, false);
  }

  function placeTile(row, col, letter, displayLetter, isBlank) {
    // Save hand snapshot before first placement
    if (Object.keys(pending).length === 0) {
      handBeforeRef.current = [...myHand];
    }
    const key = `${row},${col}`;
    const newHand = myHand.filter((_, i) => i !== selectedHandIdx);
    setMyHand(newHand);
    setPending(prev => ({ ...prev, [key]: { letter, displayLetter, isBlank } }));
    setSelectedHandIdx(null);
  }

  function removePending(row, col) {
    const key = `${row},${col}`;
    const tile = pending[key];
    if (!tile) return;
    setMyHand(prev => [...prev, tile.isBlank ? '?' : tile.letter]);
    setPending(prev => { const n = { ...prev }; delete n[key]; return n; });
  }

  function recallAll() {
    const returned = Object.values(pending).map(t => t.isBlank ? '?' : t.letter);
    setMyHand(prev => [...prev, ...returned]);
    setPending({});
    setSelectedHandIdx(null);
  }

  function submitWord() {
    if (!myTurn || !roomId || !socket || submitting) return;
    const placements = Object.entries(pending).map(([key, tile]) => {
      const [r, c] = key.split(',').map(Number);
      return { row: r, col: c, letter: tile.letter, displayLetter: tile.displayLetter, isBlank: tile.isBlank };
    });
    if (placements.length === 0) {
      setStatusMsg('Place at least one tile first');
      setTimeout(() => setStatusMsg(''), 2000);
      return;
    }
    setSubmitting(true);
    socket.emit('scrabble_play_word', { roomId, placements });
    // Do NOT clear pending here — wait for server confirmation.
    // If error, pending stays so user can fix/recall. If success, cleared in scrabble_word_played handler.
  }

  function skipTurn() {
    if (!myTurn || !roomId || !socket) return;
    if (mySkips >= 1) {
      setStatusMsg('You can only skip once per game');
      setTimeout(() => setStatusMsg(''), 2500);
      return;
    }
    recallAll();
    setMySkips(s => s + 1);
    socket.emit('scrabble_skip', { roomId });
  }

  function submitExchange() {
    if (!myTurn || !roomId || !socket) return;
    const letters = [...exchangeSel].map(i => myHand[i]);
    if (letters.length === 0) { setExchangeMode(false); return; }
    socket.emit('scrabble_exchange', { roomId, letters });
  }

  function onBlankPick(letter) {
    if (!blankPick) return;
    placeTile(blankPick.row, blankPick.col, letter, letter, true);
    setBlankPick(null);
  }

  // ── Drag-and-drop from hand to board ────────────────────────────────────────
  function handleTileDragStart(idx) {
    setDraggingIdx(idx);
    setSelectedHandIdx(idx);
  }

  function handleTileDragEnd() {
    setDraggingIdx(null);
  }

  function handleCellDrop(row, col) {
    if (!myTurn || phase !== 'game' || submitting) return;
    const key = `${row},${col}`;
    if (pending[key] || board[row][col]) return;
    const idx = draggingIdx ?? selectedHandIdx;
    if (idx === null) return;
    const tile = myHand[idx];
    if (!tile) return;
    setDraggingIdx(null);
    setSelectedHandIdx(idx);
    if (tile === '?') {
      setBlankPick({ row, col });
    } else {
      placeTile(row, col, tile, tile, false);
    }
  }

  // Touch drag drop — called from touch event handler with explicit idx
  function handleCellDropByTouch(row, col, idx) {
    if (!myTurn || phase !== 'game' || submitting) return;
    const key = `${row},${col}`;
    if (pending[key] || board[row][col]) return;
    const tile = myHand[idx];
    if (!tile) return;
    setSelectedHandIdx(idx);
    if (tile === '?') {
      setBlankPick({ row, col });
    } else {
      placeTile(row, col, tile, tile, false);
    }
  }

  // Scores
  const mySocketId = socket?.id;
  const myScore    = mySocketId ? (scores[mySocketId] || 0) : 0;
  const oppSockets = Object.keys(scores).filter(k => k !== mySocketId);
  const oppScore   = oppSockets.length > 0 ? (scores[oppSockets[0]] || 0) : 0;

  return (
    <div
      className={`bg-bg flex flex-col items-center px-2 ${phase === 'game' ? 'justify-center' : 'justify-center min-h-[calc(100vh-56px)]'}`}
      style={{
        opacity: ready ? 1 : 0,
        transition: 'opacity 0.35s ease',
        paddingBottom: 'env(safe-area-inset-bottom, 8px)',
        paddingTop: 8,
        // On mobile during game: lock to exact viewport, no scrolling
        ...(phase === 'game' ? {
          height: 'calc(100vh - 56px)',
          overflow: 'hidden',
        } : {}),
      }}
    >
      {blankPick && <BlankPicker onPick={onBlankPick} onCancel={() => setBlankPick(null)} />}

      {/* Touch drag ghost */}
      {touchDragPos && draggingIdx !== null && myHand[draggingIdx] && (
        <div style={{
          position: 'fixed',
          left: touchDragPos.x - (CELL_SIZE - 8) / 2,
          top: touchDragPos.y - (CELL_SIZE - 8) / 2,
          zIndex: 9999,
          pointerEvents: 'none',
          width: CELL_SIZE - 8, height: CELL_SIZE - 8,
          borderRadius: 8,
          background: '#e8d5a8',
          border: '2.5px solid #1E90FF',
          boxShadow: '0 0 16px rgba(30,144,255,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 900, color: '#2c1a00',
          opacity: 0.9,
        }}>
          {myHand[draggingIdx] === '?' ? '?' : myHand[draggingIdx]}
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 z-50 bg-bg flex items-center justify-center overflow-y-auto p-4">
          <ResultScreen
            isWinner={isWinner}
            winnerUsername={result.winnerUsername}
            loserUsername={result.loserUsername}
            newWinnerElo={result.newWinnerElo}
            newLoserElo={result.newLoserElo}
            eloBeforeRef={eloBeforeRef}
            balanceChange={result.balanceChange}
            currency={result.currency || betCurrency}
            entryFee={entryFee}
            disconnected={result.disconnected}
            profile={profile}
            gameLabel="🔤 Word VS"
            extraRows={[
              { label: 'Score', value: `${result.winnerScore ?? 0} — ${result.loserScore ?? 0}` },
              ...(!result.disconnected ? [{ label: 'Reason', value:
                  result.reason === 'consecutive_passes' ? 'Both passed' :
                  result.reason === 'tiles_out' ? 'All tiles placed' :
                  result.reason === 'board_full' ? 'Board filled' : 'Game over' }] : []),
            ]}
            onRematch={null}
            onPlayAgain={backToLobby}
            onBackToLobby={backToLobby}
          />
        </div>
      )}

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🔤 Word VS"
          description="Place words on the 6×6 board to outscore your opponent. Any word goes — no filters. First word must be placed in the middle area. 60s per turn. One skip allowed."
          controls="Click a tile → click a board cell to place · Play Word to submit · Recall to take tiles back"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={balance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          botLabel="🎮 Play Free vs Bot"
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
          gameType="scrabble"
          liveCount={playerCounts?.scrabble ?? 0}
        />
      )}

      {/* PRIVATE WAITING */}
      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-white mb-2">Private Room Created</h2>
          <p className="text-muted mb-6 text-sm">Share this code with a friend</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 shadow-glow inline-block min-w-[200px]">
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary" style={{ textShadow: '0 0 20px rgba(30,144,255,0.5)' }}>
              {privateCode}
            </div>
          </div>
          <div className="flex justify-center">
            <GlowButton variant="ghost" onClick={cancelPrivate}>Cancel</GlowButton>
          </div>
        </div>
      )}

      {/* QUEUE */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching...</h2>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* COUNTDOWN */}
      {phase === 'countdown' && (
        <div className="text-center animate-fade-in">
          <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1E90FF' }}>
            {countdown ?? '…'}
          </div>
          <p className="text-muted">Get ready…</p>
          {opponent && <p className="text-xs text-muted mt-2">vs {opponent.username}</p>}
        </div>
      )}

      {/* GAME */}
      {phase === 'game' && (
        <div className="w-full animate-fade-in px-1 flex flex-col items-center mx-auto" style={{ maxWidth: 660 }}>

          {/* Turn timer bar */}
          {myTurn && turnSeconds > 0 && (
            <TurnTimerBar seconds={turnSeconds} total={60} />
          )}

          {/* Scores header */}
          <div className="flex items-center justify-between mb-3 px-1 w-full">
            <div className="text-center">
              <div className="text-2xl font-black text-success font-mono">{myScore}</div>
              <div className="text-xs text-muted">{profile?.username}</div>
            </div>

            <div className="text-center">
              <div className={`text-sm font-black px-3 py-1 rounded-full ${
                myTurn
                  ? 'bg-primary/20 border border-primary/50 text-primary'
                  : 'bg-surfaceLight border border-border text-muted'
              }`}>
                {myTurn
                  ? (turnSeconds > 0 ? `Your Turn · ${turnSeconds}s` : 'Your Turn')
                  : "Opponent's Turn"}
              </div>
              <div className="text-xs text-muted mt-1">{bagCount} in bag</div>
            </div>

            <div className="text-center">
              <div className="text-2xl font-black text-danger font-mono">{oppScore}</div>
              <div className="text-xs text-muted">{opponent?.username ?? 'Bot'}</div>
            </div>
          </div>

          {/* Last word played */}
          {lastWords.length > 0 && (
            <div className="text-center mb-2 text-xs text-muted">
              <span className="text-white font-bold">{lastWords.join(', ')}</span>
              {lastScore != null && <span className="text-success font-bold ml-1">+{lastScore} pts</span>}
            </div>
          )}

          {/* Error message */}
          {statusMsg && (
            <div className="text-center mb-2 text-sm text-danger font-bold">{statusMsg}</div>
          )}

          {/* Board */}
          <div
            className="mx-auto mb-4"
            style={{
              display: 'inline-grid',
              gridTemplateColumns: `repeat(${BOARD_SIZE}, ${CELL_SIZE}px)`,
              gap: 4,
              background: '#6b4c2a',
              padding: 8,
              borderRadius: 12,
              border: '3px solid #4a3018',
              boxShadow: '0 4px 24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)',
            }}
          >
            {Array.from({length:BOARD_SIZE},(_,r) =>
              Array.from({length:BOARD_SIZE},(_,c) => {
                const key = `${r},${c}`;
                return (
                  <BoardCell
                    key={key}
                    row={r} col={c}
                    cell={board[r]?.[c]}
                    pending={pending[key]}
                    myTurn={myTurn && phase === 'game' && !submitting}
                    onClick={() => handleCellClick(r, c)}
                    onRemove={() => removePending(r, c)}
                    onDragOver={e => { if (myTurn && !board[r]?.[c] && !pending[key]) e.preventDefault(); }}
                    onDrop={e => { e.preventDefault(); handleCellDrop(r, c); }}
                  />
                );
              })
            )}
          </div>

          {/* Hand — horizontally scrollable on mobile */}
          <div className="mb-3 w-full">
            <div className="flex items-center justify-center gap-3 mb-2">
              <span className="text-xs text-muted font-semibold uppercase tracking-wider">
                Your Tiles {exchangeMode && <span className="text-warning"> — tap to select for exchange</span>}
              </span>
              {!exchangeMode && (
                <button
                  onClick={() => setMyHand(h => [...h].sort(() => Math.random() - 0.5))}
                  className="text-xs text-muted hover:text-white border border-border hover:border-primary px-2 py-0.5 rounded-lg transition-all font-semibold"
                  title="Shuffle your tiles"
                >🔀 Shuffle</button>
              )}
            </div>
            <div className="overflow-x-auto overflow-y-visible pb-1 pt-2" style={{ touchAction: 'pan-x' }}>
              <div className="flex justify-center gap-2 min-w-max mx-auto px-2" style={{ touchAction: 'none' }}>
                {myHand.map((letter, i) => (
                  <TileButton
                    key={`${letter}-${i}`}
                    letter={letter}
                    selected={exchangeMode ? exchangeSel.has(i) : selectedHandIdx === i}
                    dragging={draggingIdx === i}
                    onClick={() => handleHandClick(i)}
                    onDragStart={() => handleTileDragStart(i)}
                    onDragEnd={handleTileDragEnd}
                    onTouchStart={(e) => handleTileTouchStart(i, e)}
                  />
                ))}
                {myHand.length === 0 && <span className="text-muted text-sm py-3">No tiles</span>}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          {myTurn && (
            <div className="flex flex-wrap gap-2 justify-center px-1">
              {!exchangeMode ? (
                <>
                  <button
                    onClick={submitWord}
                    disabled={Object.keys(pending).length === 0 || submitting}
                    className="px-5 py-2.5 rounded-xl bg-success text-white font-black text-sm disabled:opacity-40 hover:bg-green-500 transition-all"
                    style={{ boxShadow: Object.keys(pending).length > 0 && !submitting ? '0 0 14px rgba(34,197,94,0.4)' : 'none' }}
                  >
                    {submitting ? '…' : '✓ Play Word'}
                  </button>
                  {Object.keys(pending).length > 0 && (
                    <button
                      onClick={recallAll}
                      disabled={submitting}
                      className="px-5 py-2.5 rounded-xl bg-surfaceLight text-white font-bold text-sm hover:bg-border transition-all border border-border disabled:opacity-40"
                    >
                      ↩ Recall
                    </button>
                  )}
                  <button
                    onClick={skipTurn}
                    disabled={mySkips >= 1}
                    title={mySkips >= 1 ? 'You already used your skip' : 'Skip your turn (once per game)'}
                    className="px-5 py-2.5 rounded-xl border border-border text-muted font-bold text-sm hover:text-white hover:border-surfaceLight transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Skip {mySkips >= 1 ? '(used)' : ''}
                  </button>
                  {bagCount >= 2 && (
                    <button
                      onClick={() => { setExchangeMode(true); setExchangeSel(new Set()); recallAll(); }}
                      className="px-5 py-2.5 rounded-xl border border-[#4a3a1a] text-[#daa060] font-bold text-sm hover:bg-[#2a1f0a] transition-all"
                    >
                      🔄 Exchange
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    onClick={submitExchange}
                    disabled={exchangeSel.size === 0}
                    className="px-5 py-2.5 rounded-xl bg-warning/20 border border-warning text-warning font-black text-sm disabled:opacity-40 hover:bg-warning/30 transition-all"
                  >
                    Exchange {exchangeSel.size > 0 ? `(${exchangeSel.size})` : ''}
                  </button>
                  <button
                    onClick={() => { setExchangeMode(false); setExchangeSel(new Set()); }}
                    className="px-5 py-2.5 rounded-xl border border-border text-muted font-bold text-sm hover:text-white transition-all"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}

          {/* Premium legend */}
          <div className="flex justify-center gap-3 mt-4 flex-wrap">
            {[['★','Center DW'],['TW','Triple Word'],['DW','Double Word'],['TL','Triple Letter'],['DL','Double Letter']].map(([k,v]) => {
              const s = PREMIUM_COLORS[k];
              return (
                <div key={k} className="flex items-center gap-1 text-[10px]">
                  <div className="w-5 h-5 rounded flex items-center justify-center text-[8px] font-black"
                    style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.textColor }}>{k}</div>
                  <span className="text-muted">{v}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
