import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];
const SQ = 76; // square size px

// ── Board logic ───────────────────────────────────────────────────────────────
// Pieces: 'w' white man, 'W' white king, 'r' red man, 'R' red king, null empty
// Dark squares only (r+c) % 2 === 1
// White moves toward row 0, red moves toward row 7

function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        if (r < 3) b[r][c] = 'r';
        if (r > 4) b[r][c] = 'w';
      }
    }
  }
  return b;
}

function pieceColor(p) {
  if (!p) return null;
  return p === 'w' || p === 'W' ? 'w' : 'r';
}

function isKing(p) { return p === 'W' || p === 'R'; }

// Diagonal move directions for a piece
function dirs(p) {
  if (p === 'W' || p === 'R') return [[-1,-1],[-1,1],[1,-1],[1,1]];
  if (p === 'w') return [[-1,-1],[-1,1]]; // white moves up (decreasing row)
  if (p === 'r') return [[1,-1],[1,1]];   // red moves down (increasing row)
  return [];
}

function inB(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

// Get all simple moves (no jump) for a single piece
function simpleMoves(board, r, c) {
  const p = board[r][c];
  if (!p) return [];
  const res = [];
  for (const [dr, dc] of dirs(p)) {
    const nr = r + dr, nc = c + dc;
    if (inB(nr, nc) && !board[nr][nc]) res.push({ from: [r, c], to: [nr, nc], jumped: null });
  }
  return res;
}

// Get all jump moves from a position, optionally requiring to jump over jumpOver piece
function jumpMoves(board, r, c, alreadyJumped = []) {
  const p = board[r][c];
  if (!p) return [];
  const col = pieceColor(p);
  const opp = col === 'w' ? 'r' : 'w';
  const res = [];
  for (const [dr, dc] of dirs(p)) {
    const mr = r + dr, mc = c + dc;   // middle (jumped) square
    const tr = r + 2 * dr, tc = c + 2 * dc; // target square
    if (!inB(tr, tc)) continue;
    const mid = board[mr][mc];
    if (!mid) continue;
    if (pieceColor(mid) !== opp) continue;
    if (board[tr][tc] !== null) continue;
    // Not already jumped this piece in this chain
    if (alreadyJumped.some(([jr, jc]) => jr === mr && jc === mc)) continue;
    res.push({ from: [r, c], to: [tr, tc], jumped: [mr, mc] });
  }
  return res;
}

// Get all valid moves for a color (forced jumps if available)
function getValidMoves(board, color) {
  const allJumps = [];
  const allSimple = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] && pieceColor(board[r][c]) === color) {
        allJumps.push(...jumpMoves(board, r, c));
        allSimple.push(...simpleMoves(board, r, c));
      }
    }
  }
  return allJumps.length > 0 ? allJumps : allSimple;
}

// Get valid moves for a specific piece
function getValidMovesForPiece(board, r, c, chainJumped = []) {
  const p = board[r][c];
  if (!p) return [];
  const jumps = jumpMoves(board, r, c, chainJumped);
  if (chainJumped.length > 0) return jumps; // in a chain, only jumps
  const allJumps = [];
  const col = pieceColor(p);
  for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++)
    if (board[rr][cc] && pieceColor(board[rr][cc]) === col)
      allJumps.push(...jumpMoves(board, rr, cc));
  return allJumps.length > 0 ? jumpMoves(board, r, c) : simpleMoves(board, r, c);
}

function applyMove(board, from, to, jumped) {
  const nb = board.map(row => [...row]);
  const [fr, fc] = from, [tr, tc] = to;
  nb[tr][tc] = nb[fr][fc];
  nb[fr][fc] = null;
  if (jumped) nb[jumped[0]][jumped[1]] = null;
  // King promotion
  if (nb[tr][tc] === 'w' && tr === 0) nb[tr][tc] = 'W';
  if (nb[tr][tc] === 'r' && tr === 7) nb[tr][tc] = 'R';
  return nb;
}

function countPieces(board, color) {
  let n = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (board[r][c] && pieceColor(board[r][c]) === color) n++;
  return n;
}

function botMove(board, botColor) {
  const moves = getValidMoves(board, botColor);
  if (!moves.length) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CheckersGame() {
  const ready = usePageReady();
  const [boardZoom, setBoardZoom] = useState(1);
  useEffect(() => {
    const update = () => setBoardZoom(Math.min(1, (window.innerWidth - 24) / (8 * SQ + 8)));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]               = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]         = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent]         = useState(null);
  const [roomId, setRoomId]             = useState(null);
  const [countdown, setCountdown]       = useState(null);
  const [result, setResult]             = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]       = useState('');
  const [privateCode, setPrivateCode]   = useState('');
  const [vsBot, setVsBot]               = useState(false);
  const [botWins, setBotWins]           = useState(0);
  const [botLosses, setBotLosses]       = useState(0);
  const [timerEndsAt, setTimerEndsAt]   = useState(null);
  const [timeLeft, setTimeLeft]         = useState(null);

  // Game state
  const [board, setBoard]               = useState(initBoard);
  const [myColor, setMyColor]           = useState('w');
  const [currentTurn, setCurrentTurn]   = useState('w');
  const [selected, setSelected]         = useState(null);
  const [validForSel, setValidForSel]   = useState([]); // valid moves for selected piece
  const [chainJumped, setChainJumped]   = useState([]); // squares jumped this chain
  const [chainPiece, setChainPiece]     = useState(null); // piece locked in multi-jump
  const [lastMove, setLastMove]         = useState(null);

  // Refs for async safety
  const boardRef      = useRef(initBoard());
  const turnRef       = useRef('w');
  const myColorRef    = useRef('w');
  const vsBotRef      = useRef(false);
  const roomIdRef     = useRef(null);
  const profileRef    = useRef(profile);
  const phaseRef      = useRef('lobby');
  const doneRef       = useRef(false);
  const botTimerRef   = useRef(null);
  const eloBeforeRef  = useRef(profile?.elo ?? 1000);
  const chainRef      = useRef([]); // alreadyJumped for current chain
  const chainPieceRef = useRef(null);

  roomIdRef.current  = roomId;
  profileRef.current = profile;
  phaseRef.current   = phase;
  vsBotRef.current   = vsBot;
  myColorRef.current = myColor;

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const isWinner     = result && result.winnerId === profile?.id;

  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  const { RejoinOverlay } = useGamePageRejoin('checkers', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('game'); setStatusMsg('Reconnected!'); },
    () => { setPhase('lobby'); setStatusMsg(''); },
  );

  // Countdown effect
  useEffect(() => {
    if (phase !== 'countdown') return;
    let count = 3;
    setCountdown(count);
    const iv = setInterval(() => {
      count--;
      if (count > 0) setCountdown(count);
      else { clearInterval(iv); setCountdown(null); setPhase('game'); }
    }, 1000);
    return () => clearInterval(iv);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // After game starts, if bot goes first
  useEffect(() => {
    if (phase === 'game' && vsBotRef.current && turnRef.current !== myColorRef.current) {
      scheduleBotMove();
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetGame(colForMe = 'w') {
    const b = initBoard();
    boardRef.current  = b;
    turnRef.current   = 'w';
    doneRef.current   = false;
    chainRef.current  = [];
    chainPieceRef.current = null;
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
    setBoard(b);
    setMyColor(colForMe);
    myColorRef.current = colForMe;
    setCurrentTurn('w');
    setSelected(null);
    setValidForSel([]);
    setChainJumped([]);
    setChainPiece(null);
    setLastMove(null);
  }

  // Execute a single move step (may be one part of a multi-jump chain)
  function execStep(from, to, jumped, chainDone) {
    const b  = boardRef.current;
    const nb = applyMove(b, from, to, jumped);
    boardRef.current = nb;
    setBoard(nb.map(r => [...r]));
    setLastMove({ from, to });

    const [tr, tc] = to;

    if (jumped && !chainDone) {
      // Mid-chain: same player continues
      const newChain = [...chainRef.current, jumped];
      chainRef.current = newChain;
      chainPieceRef.current = to;
      setChainJumped(newChain);
      setChainPiece(to);
      setSelected(to);
      const nextMoves = jumpMoves(nb, tr, tc, newChain);
      setValidForSel(nextMoves.map(m => m.to));
      // If bot is in chain, continue automatically
      if (vsBotRef.current && turnRef.current !== myColorRef.current) {
        scheduleBotJumpContinue(nb, to, newChain);
      }
    } else {
      // Move complete — flip turn
      chainRef.current = [];
      chainPieceRef.current = null;
      setChainJumped([]);
      setChainPiece(null);
      setSelected(null);
      setValidForSel([]);

      const nextTurn = turnRef.current === 'w' ? 'r' : 'w';
      turnRef.current = nextTurn;
      setCurrentTurn(nextTurn);

      // Check win condition
      const oppColor  = myColorRef.current === 'w' ? 'r' : 'w';
      const myPcs     = countPieces(nb, myColorRef.current);
      const oppPcs    = countPieces(nb, oppColor);
      const nextMoves = getValidMoves(nb, nextTurn);
      const nextHasMoves = nextMoves.length > 0;

      if (!doneRef.current) {
        if (oppPcs === 0 || (nextTurn === oppColor && !nextHasMoves)) {
          doneRef.current = true;
          socket?.emit('checkers_game_over', { roomId: roomIdRef.current, winnerSocketId: socket?.id, reason: oppPcs === 0 ? 'no_pieces' : 'no_moves' });
        } else if (myPcs === 0 || (nextTurn === myColorRef.current && !nextHasMoves)) {
          doneRef.current = true;
          socket?.emit('checkers_game_over', { roomId: roomIdRef.current, winnerSocketId: null, reason: myPcs === 0 ? 'no_pieces' : 'no_moves' });
        } else if (vsBotRef.current && nextTurn !== myColorRef.current) {
          scheduleBotMove();
        } else if (vsBotRef.current && nextTurn === myColorRef.current) {
          // Bot just finished its turn — tell server so it restarts our timer
          socket?.emit('checkers_bot_done', { roomId: roomIdRef.current });
        }
      }
    }
  }

  function scheduleBotMove() {
    if (botTimerRef.current) clearTimeout(botTimerRef.current);
    botTimerRef.current = setTimeout(() => {
      if (phaseRef.current !== 'game' || !vsBotRef.current) return;
      const botColor = myColorRef.current === 'w' ? 'r' : 'w';
      const move = botMove(boardRef.current, botColor);
      if (!move) {
        if (!doneRef.current) {
          doneRef.current = true;
          socket?.emit('checkers_game_over', {
            roomId: roomIdRef.current,
            winnerSocketId: socket?.id,
            reason: 'no_moves',
          });
        }
        return;
      }
      const { from, to, jumped } = move;
      // Check if there are follow-up jumps
      const nb = applyMove(boardRef.current, from, to, jumped);
      const followUp = jumped ? jumpMoves(nb, to[0], to[1], [jumped]) : [];
      execStep(from, to, jumped, followUp.length === 0);
    }, 600 + Math.random() * 600);
  }

  function scheduleBotJumpContinue(board2, from, alreadyJumped) {
    if (botTimerRef.current) clearTimeout(botTimerRef.current);
    botTimerRef.current = setTimeout(() => {
      if (phaseRef.current !== 'game' || !vsBotRef.current) return;
      const jumps = jumpMoves(board2, from[0], from[1], alreadyJumped);
      if (!jumps.length) return; // chain already ended correctly via chainDone=true
      const move = jumps[Math.floor(Math.random() * jumps.length)];
      const nb = applyMove(board2, move.from, move.to, move.jumped);
      const followUp = jumpMoves(nb, move.to[0], move.to[1], [...alreadyJumped, move.jumped]);
      execStep(move.from, move.to, move.jumped, followUp.length === 0);
    }, 400 + Math.random() * 400);
  }

  // ── Square click ─────────────────────────────────────────────────────────────
  function handleClick(r, c) {
    if (phaseRef.current !== 'game') return;
    if (turnRef.current !== myColorRef.current) return;
    if (doneRef.current) return;

    const b = boardRef.current;
    const piece = b[r][c];

    // In a multi-jump chain, only the chain piece can move
    if (chainPieceRef.current) {
      const [cp_r, cp_c] = chainPieceRef.current;
      if (r === cp_r && c === cp_c) return; // clicked on self

      const chainMoves = jumpMoves(b, cp_r, cp_c, chainRef.current);
      const match = chainMoves.find(m => m.to[0] === r && m.to[1] === c);
      if (match) {
        const nb = applyMove(b, match.from, match.to, match.jumped);
        const followUp = jumpMoves(nb, r, c, [...chainRef.current, match.jumped]);
        const nb2 = applyMove(boardRef.current, match.from, match.to, match.jumped);
        socket?.emit('checkers_move', {
          roomId: roomIdRef.current,
          from: match.from, to: match.to,
          jumped: match.jumped,
          chainDone: followUp.length === 0,
          boardSnapshot: nb2,
        });
        execStep(match.from, match.to, match.jumped, followUp.length === 0);
      }
      return;
    }

    // Selecting a piece
    if (piece && pieceColor(piece) === myColorRef.current) {
      const movesForPiece = getValidMovesForPiece(b, r, c);
      setSelected([r, c]);
      setValidForSel(movesForPiece.map(m => m.to));
      return;
    }

    // Moving selected piece
    if (selected) {
      const [sr, sc] = selected;
      const movesForPiece = getValidMovesForPiece(b, sr, sc);
      const match = movesForPiece.find(m => m.to[0] === r && m.to[1] === c);
      if (match) {
        const nb = applyMove(b, match.from, match.to, match.jumped);
        const followUp = match.jumped ? jumpMoves(nb, r, c, match.jumped ? [match.jumped] : []) : [];
        socket?.emit('checkers_move', {
          roomId: roomIdRef.current,
          from: match.from, to: match.to,
          jumped: match.jumped,
          chainDone: followUp.length === 0,
          boardSnapshot: nb,
        });
        execStep(match.from, match.to, match.jumped, followUp.length === 0);
        return;
      }
    }

    // Deselect / select new piece
    if (piece && pieceColor(piece) === myColorRef.current) {
      const movesForPiece = getValidMovesForPiece(b, r, c);
      setSelected([r, c]);
      setValidForSel(movesForPiece.map(m => m.to));
    } else {
      setSelected(null);
      setValidForSel([]);
    }
  }

  // ── Socket events ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee, vsBot: bot, myColor: col }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      if (fee !== undefined) setEntryFee(fee);
      setVsBot(!!bot);
      setResult(null);
      setStatusMsg('');
      resetGame(col || 'w');
      setPhase('countdown');
    }

    function onOpponentMove({ from, to, jumped, nextTurn }) {
      if (vsBotRef.current) return; // bot moves handled client-side
      const nb = applyMove(boardRef.current, from, to, jumped);
      boardRef.current = nb;
      setBoard(nb.map(r => [...r]));
      setLastMove({ from, to });
      turnRef.current = nextTurn;
      setCurrentTurn(nextTurn);
      setSelected(null);
      setValidForSel([]);
      chainRef.current = [];
      chainPieceRef.current = null;
      setChainJumped([]);
      setChainPiece(null);
    }

    function onResult(data) {
      if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      if (vsBotRef.current) {
        const myId = profileRef.current?.id;
        const won  = !data.draw && data.winnerId === myId;
        if (won) setBotWins(w => w + 1);
        else if (!data.draw) setBotLosses(l => l + 1);
      }
      setPhase('result');
      refreshProfile();
    }

    function onDisconnect(data = {}) {
      const myId = profileRef.current?.id;
      const isWin = data.winnerId === myId;
      const payout = data.winnerPayout ?? null;
      setResult({
        winnerId:       data.winnerId || myId,
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
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      refreshProfile();
    }
    function onError({ message }) { setStatusMsg(message); }

    socket.on('checkers_timer', ({ endsAt, currentTurn }) => {
      if (currentTurn === myColorRef.current) setTimerEndsAt(endsAt);
      else setTimerEndsAt(null);
    });
    socket.on('checkers_turn_skipped', ({ nextTurn }) => {
      setCurrentTurn(nextTurn);
      setTimerEndsAt(null);
      // If it's now the bot's turn, kick off its move immediately
      if (vsBotRef.current && nextTurn !== myColorRef.current) scheduleBotMove();
    });
    socket.on('checkers_match_found',    onMatchFound);
    socket.on('checkers_opponent_move',  onOpponentMove);
    socket.on('checkers_result',         onResult);
    socket.on('opponent_disconnected',   onDisconnect);
    socket.on('error',                   onError);
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });
    socket.on('checkers_rejoin', ({ myColor: col, currentTurn: ct, boardSnapshot, opponent: opp, entryFee: fee }) => {
      if (boardSnapshot) {
        boardRef.current = boardSnapshot;
        setBoard(boardSnapshot.map(r => [...r]));
      }
      myColorRef.current = col || 'w';
      turnRef.current    = ct || 'w';
      setMyColor(col || 'w');
      setCurrentTurn(ct || 'w');
      chainRef.current = [];
      chainPieceRef.current = null;
      setChainJumped([]);
      setChainPiece(null);
      setSelected(null);
      setValidForSel([]);
      if (opp) setOpponent(opp);
      if (fee !== undefined) setEntryFee(fee);
      setPhase('game');
    });

    return () => {
      socket.off('checkers_timer');
      socket.off('checkers_turn_skipped');
      socket.off('checkers_match_found',    onMatchFound);
      socket.off('checkers_opponent_move',  onOpponentMove);
      socket.off('checkers_result',         onResult);
      socket.off('opponent_disconnected',   onDisconnect);
      socket.off('error',                   onError);
      socket.off('private_room_created');
      socket.off('checkers_rejoin');
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn timer countdown
  useEffect(() => {
    if (!timerEndsAt) { setTimeLeft(null); return; }
    const tick = () => setTimeLeft(Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [timerEndsAt]);

  useEffect(() => { if (phase !== 'game') { setTimerEndsAt(null); setTimeLeft(null); } }, [phase]);

  // ── Actions ───────────────────────────────────────────────────────────────────
  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_checkers_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_checkers_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_checkers_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting free match...');
  }
  function leaveQueue() { socket.emit('leave_checkers_queue'); setPhase('lobby'); setStatusMsg(''); }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'checkers', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'checkers', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function resign() {
    if (!doneRef.current) {
      doneRef.current = true;
      socket?.emit('checkers_resign', { roomId });
    }
  }

  function playAgainVsBot() {
    resetGame('w');
    setResult(null);
    socket.emit('play_checkers_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting next bot match...');
  }

  function requestRematch() {
    resetGame(myColor === 'w' ? 'r' : 'w');
    setResult(null);
    socket?.emit('checkers_rematch_request', { roomId });
    setPhase('queue'); setStatusMsg('Waiting for rematch...');
  }

  function backToLobby() {
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
    setVsBot(false); setBotWins(0); setBotLosses(0);
    setPhase('lobby'); setResult(null); setOpponent(null);
    setRoomId(null); setStatusMsg('');
    resetGame('w');
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────
  // White player sees white at bottom (rows 7→0 displayed top→bottom), red player sees red at bottom
  const rows = myColor === 'r' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  const cols = myColor === 'r' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];

  const isSel   = (r, c) => selected?.[0] === r && selected?.[1] === c;
  const isValid = (r, c) => validForSel.some(([vr, vc]) => vr === r && vc === c);
  const isLast  = (r, c) => lastMove && (
    (lastMove.from[0] === r && lastMove.from[1] === c) ||
    (lastMove.to[0]   === r && lastMove.to[1]   === c)
  );

  const canInteract = phase === 'game' && currentTurn === myColor && !doneRef.current;
  const turnLabel   = currentTurn === myColor ? 'Your turn' : "Opponent's turn";
  const wpcs = countPieces(board, 'w');
  const rpcs = countPieces(board, 'r');

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
          title="🔵 Checkers"
          description="Capture all your opponent's pieces or block them completely"
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

      {/* ── COUNTDOWN ── */}
      {phase === 'countdown' && (
        <div className="text-center animate-fade-in">
          {countdown !== null ? (
            <>
              <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1E90FF' }}>
                {countdown}
              </div>
              <p className="text-muted">Get ready...</p>
            </>
          ) : (
            <>
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-muted">Match found! Starting...</p>
            </>
          )}
        </div>
      )}

      {/* ── GAME ── */}
      {phase === 'game' && (
        <div className="flex flex-col items-center gap-3 animate-fade-in" style={{ zoom: boardZoom }}>

          {/* Header */}
          <div className="flex items-center justify-between w-full" style={{ maxWidth: `${8 * SQ}px` }}>
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <span className="w-4 h-4 rounded-full bg-white border-2 border-gray-400 inline-block" />
              {myColor === 'r' ? (opponent?.username || 'Bot') : profile?.username}
              <span className="text-xs text-muted font-normal">({wpcs})</span>
            </div>
            <span className={`text-xs font-black px-3 py-1 rounded-full border ${
              currentTurn === myColor
                ? 'bg-success/20 text-success border-success/30'
                : 'bg-surface text-muted border-border'
            }`}>{turnLabel}</span>
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <span className="text-xs text-muted font-normal">({rpcs})</span>
              {myColor === 'w' ? (opponent?.username || 'Bot') : profile?.username}
              <span className="w-4 h-4 rounded-full bg-red-600 border-2 border-red-800 inline-block" />
            </div>
          </div>

          {/* Turn timer bar */}
          {timeLeft !== null && (
            <div className="w-full" style={{ maxWidth: `${8 * SQ + 8}px` }}>
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: timeLeft <= 10 ? '#f87171' : timeLeft <= 20 ? '#fbbf24' : '#4ade80' }} className="font-bold">
                  ⏱ {currentTurn === myColor ? 'Your' : "Opp's"} turn: {timeLeft}s
                </span>
              </div>
              <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'rgba(255,255,255,0.1)' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.max(0, (timeLeft / 60) * 100)}%`,
                  background: timeLeft <= 10 ? '#f87171' : timeLeft <= 20 ? '#fbbf24' : '#4ade80',
                  transition: 'width 0.25s linear, background 0.5s',
                }} />
              </div>
            </div>
          )}

          {/* Board */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(8, ${SQ}px)`,
            gridTemplateRows: `repeat(8, ${SQ}px)`,
            border: '3px solid #4a3728',
            borderRadius: '4px',
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          }}
            className="select-none"
          >
            {rows.map(r => cols.map(c => {
              const isDark = (r + c) % 2 === 1;
              const sqBg   = isDark ? '#8B5E3C' : '#FFCE9E';
              const piece  = board[r][c];
              const sel    = isSel(r, c);
              const valid  = isValid(r, c);
              const last   = isLast(r, c);

              let overlay = null;
              if (sel)  overlay = 'rgba(20,85,255,0.45)';
              else if (last && isDark) overlay = 'rgba(255,200,0,0.30)';

              return (
                <div key={`${r}-${c}`}
                  draggable={canInteract && isDark && !!piece && pieceColor(piece) === myColor && !chainPieceRef.current}
                  onClick={() => canInteract && isDark && handleClick(r, c)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', JSON.stringify([r, c]));
                    const isWhite = pieceColor(piece) === 'w';
                    const size = Math.round(SQ * 0.75);
                    const canvas = document.createElement('canvas');
                    canvas.width = size; canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    const cx = size / 2, cy = size / 2, rad = size / 2 - 2;
                    const grad = ctx.createRadialGradient(cx * 0.7, cy * 0.7, 0, cx, cy, rad);
                    if (isWhite) { grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#d8d8d8'); }
                    else { grad.addColorStop(0, '#e05050'); grad.addColorStop(1, '#8b1a1a'); }
                    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.closePath();
                    ctx.fillStyle = grad; ctx.fill();
                    ctx.strokeStyle = isWhite ? '#b8b8b8' : '#5c0f0f'; ctx.lineWidth = 2.5; ctx.stroke();
                    if (isKing(piece)) {
                      ctx.fillStyle = isWhite ? '#8B6914' : '#FFD700';
                      ctx.font = `bold ${Math.round(size * 0.42)}px sans-serif`;
                      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                      ctx.fillText('♛', cx, cy + 1);
                    }
                    canvas.style.cssText = 'position:fixed;top:-999px;left:-999px;pointer-events:none;';
                    document.body.appendChild(canvas);
                    e.dataTransfer.setDragImage(canvas, cx, cy);
                    setTimeout(() => canvas.remove(), 100);
                    const moves = getValidMovesForPiece(boardRef.current, r, c);
                    setSelected([r, c]);
                    setValidForSel(moves.map(m => m.to));
                  }}
                  onDragEnd={() => { setSelected(null); setValidForSel([]); }}
                  onDragOver={(e) => { if (canInteract && isDark) e.preventDefault(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    try {
                      const [fr, fc] = JSON.parse(e.dataTransfer.getData('text/plain'));
                      const b = boardRef.current;
                      const moves = getValidMovesForPiece(b, fr, fc);
                      const match = moves.find(m => m.to[0] === r && m.to[1] === c);
                      if (match) {
                        const nb = applyMove(b, match.from, match.to, match.jumped);
                        const followUp = match.jumped ? jumpMoves(nb, r, c, [match.jumped]) : [];
                        socket?.emit('checkers_move', {
                          roomId: roomIdRef.current,
                          from: match.from, to: match.to,
                          jumped: match.jumped,
                          chainDone: followUp.length === 0,
                          boardSnapshot: nb,
                        });
                        execStep(match.from, match.to, match.jumped, followUp.length === 0);
                      }
                    } catch {}
                    setSelected(null); setValidForSel([]);
                  }}
                  style={{
                    width: `${SQ}px`, height: `${SQ}px`,
                    backgroundColor: sqBg,
                    position: 'relative',
                    cursor: canInteract && isDark ? 'pointer' : 'default',
                  }}
                >
                  {overlay && <div style={{ position: 'absolute', inset: 0, backgroundColor: overlay, pointerEvents: 'none' }} />}

                  {/* Valid move dot */}
                  {valid && isDark && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      pointerEvents: 'none',
                    }}>
                      <div style={{
                        width: `${SQ * 0.28}px`, height: `${SQ * 0.28}px`,
                        borderRadius: '50%',
                        backgroundColor: 'rgba(20,120,255,0.55)',
                        boxShadow: '0 0 6px rgba(20,120,255,0.5)',
                      }} />
                    </div>
                  )}

                  {/* Piece */}
                  {piece && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      pointerEvents: 'none',
                    }}>
                      {/* Piece circle */}
                      <div style={{
                        width: `${SQ * 0.75}px`, height: `${SQ * 0.75}px`,
                        borderRadius: '50%',
                        background: pieceColor(piece) === 'w'
                          ? 'radial-gradient(circle at 35% 35%, #ffffff, #d8d8d8)'
                          : 'radial-gradient(circle at 35% 35%, #e05050, #8b1a1a)',
                        border: pieceColor(piece) === 'w'
                          ? '3px solid #b8b8b8'
                          : '3px solid #5c0f0f',
                        boxShadow: '0 3px 8px rgba(0,0,0,0.55), inset 0 1px 3px rgba(255,255,255,0.3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        position: 'relative',
                      }}>
                        {/* King crown */}
                        {isKing(piece) && (
                          <span style={{
                            fontSize: `${SQ * 0.38}px`,
                            lineHeight: 1,
                            color: pieceColor(piece) === 'w' ? '#8B6914' : '#FFD700',
                            textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                            userSelect: 'none',
                          }}>♛</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            }))}
          </div>

          {/* Bottom controls */}
          <div className="flex items-center gap-4 mt-1">
            <span className="text-xs text-muted">
              You play{' '}
              <span className={`font-bold ${myColor === 'w' ? 'text-white' : 'text-red-400'}`}>
                {myColor === 'w' ? 'White' : 'Red'}
              </span>
            </span>
            {chainPiece && (
              <span className="text-xs text-warning font-bold animate-pulse">Multi-jump chain!</span>
            )}
            <GlowButton variant="ghost" size="sm" className="border border-border" onClick={resign}>
              Resign
            </GlowButton>
          </div>
        </div>
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
              const eloDelta = myNewElo - eloBeforeRef.current;
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
                          ? resultCurrency === 'diamonds'
                            ? `+${Math.round(result.balanceChange.winnerPayout)} 💎`
                            : <span className="inline-flex items-center gap-1">+{result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <CoinIcon size="0.8em" /></span>
                          : resultCurrency === 'diamonds'
                            ? `-${entryFee} 💎`
                            : <span className="inline-flex items-center gap-1">-{entryFee} <CoinIcon size="0.8em" /></span>}
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
        </div>
      </div>
      )}
    </div>
  );
}



