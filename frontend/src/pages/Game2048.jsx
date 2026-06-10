import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 500, 1000, 5000];
const DIAMOND_FEES = [50, 100, 250, 500, 1000, 10000];

// ── 2048 game logic ──────────────────────────────────────────────────

// Classic 2048 warm beige palette
const TILE_COLORS = {
  0:    '#cdc1b4',
  2:    '#eee4da',
  4:    '#ede0c8',
  8:    '#f2b179',
  16:   '#f59563',
  32:   '#f67c5f',
  64:   '#f65e3b',
  128:  '#edcf72',
  256:  '#edcc61',
  512:  '#edc850',
  1024: '#edc53f',
  2048: '#edc22e',
  4096: '#3c3a32',
  8192: '#3c3a32',
};
const TEXT_COLOR_DARK  = '#776e65'; // for tiles 2, 4
const TEXT_COLOR_LIGHT = '#f9f6f2'; // for tiles 8+
const BOARD_BG = '#bbada0';
const CELL_BG  = '#cdc1b4';

function countBombs(board) {
  let n = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (board[r][c] === 'bomb') n++;
  return n;
}

function addTile(board, spawnBomb = false) {
  const empties = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (board[r][c] === 0) empties.push([r, c]);
  if (!empties.length) return board;
  const [r, c] = empties[Math.floor(Math.random() * empties.length)];
  const nb = board.map(row => [...row]);
  nb[r][c] = spawnBomb ? 'bomb' : (Math.random() < 0.9 ? 2 : 4);
  return nb;
}

// Maybe spawn a bomb in an empty cell (5% chance, max 1 bomb on board)
function maybeSpawnBomb(board) {
  if (countBombs(board) >= 1) return board;
  if (Math.random() >= 0.05) return board;
  return addTile(board, true);
}

function initBoard() {
  const empty = Array.from({ length: 4 }, () => Array(4).fill(0));
  return addTile(addTile(empty));
}

// Slide a row left, handling bombs:
//   - bomb + bomb collision → both vanish (no effect)
//   - bomb + number (or number + bomb) → bomb explodes (flagged via hasBombCollision)
//   - number + number → normal merge
// Returns { row, score, merges, hasBombCollision, bombColPos (index in output where bomb was) }
function slideRow(row) {
  let score = 0, merges = 0;
  // filter out zeros
  const tiles = row.filter(x => x !== 0);
  const merged = [];
  let hasBombCollision = false;
  let bombColPos = -1; // column index in merged[] where bomb-number collision happened (the number tile pos)
  let skip = false;

  for (let i = 0; i < tiles.length; i++) {
    if (skip) { skip = false; continue; }
    const cur = tiles[i];
    const nxt = i + 1 < tiles.length ? tiles[i + 1] : null;

    if (cur === 'bomb' && nxt === 'bomb') {
      // both bombs collide → both disappear
      skip = true;
      // nothing pushed
    } else if (cur === 'bomb' && nxt !== null && nxt !== 'bomb') {
      // bomb slides into a number → explosion at nxt position
      hasBombCollision = true;
      bombColPos = merged.length; // the number lands here after bomb
      merged.push(nxt);           // number tile survives (doubled later in moveBoard)
      skip = true;                // consume both
    } else if (cur !== 'bomb' && nxt === 'bomb') {
      // number slides into bomb → explosion at cur position
      hasBombCollision = true;
      bombColPos = merged.length;
      merged.push(cur);           // number tile survives
      skip = true;
    } else if (cur !== 'bomb' && nxt !== null && nxt !== 'bomb' && cur === nxt) {
      // normal numeric merge
      const val = cur * 2;
      merged.push(val);
      score += val;
      merges++;
      skip = true;
    } else {
      merged.push(cur);
    }
  }

  while (merged.length < 4) merged.push(0);
  return { row: merged, score, merges, hasBombCollision, bombColPos };
}

function transpose(b)    { return b[0].map((_, c) => b.map(row => row[c])); }
function reverseRows(b)  { return b.map(row => [...row].reverse()); }

// Apply bomb explosion at (row, col): double the tile there + all 8 neighbors (cap 8192)
// Returns { newBoard, bonusScore }
function applyBombExplosion(board, row, col) {
  const nb = board.map(r => [...r]);
  let bonusScore = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr > 3 || nc < 0 || nc > 3) continue;
      const v = nb[nr][nc];
      if (typeof v === 'number' && v > 0) {
        const newVal = Math.min(v * 2, 8192);
        nb[nr][nc] = newVal;
        bonusScore += newVal;
      }
    }
  }
  return { newBoard: nb, bonusScore };
}

function moveBoard(board, dir) {
  let totalScore = 0, totalMerges = 0;
  // We need to track which rows had bomb collisions and at which column
  const bombCollisions = []; // { gridRow, gridCol } in the post-slide grid

  function slideAll(g) {
    return g.map((row, ri) => {
      const { row: nr, score, merges, hasBombCollision, bombColPos } = slideRow(row);
      totalScore += score;
      totalMerges += merges;
      if (hasBombCollision) bombCollisions.push({ gridRow: ri, gridCol: bombColPos });
      return nr;
    });
  }

  let result;
  // For directions other than left we transform, slide, then un-transform.
  // Bomb collision positions need to be mapped back to original grid coordinates.
  if (dir === 'left') {
    result = slideAll(board);
    // positions are already in correct grid space
  }
  if (dir === 'right') {
    const rev = slideAll(reverseRows(board));
    result = reverseRows(rev);
    // columns were reversed: actual col = 3 - bombColPos
    bombCollisions.forEach(bc => { bc.gridCol = 3 - bc.gridCol; });
  }
  if (dir === 'up') {
    const trans = slideAll(transpose(board));
    result = transpose(trans);
    // after transpose+slideAll: gridRow was col, gridCol was row → swap back
    bombCollisions.forEach(bc => { const tmp = bc.gridRow; bc.gridRow = bc.gridCol; bc.gridCol = tmp; });
  }
  if (dir === 'down') {
    const trans = reverseRows(transpose(board));
    const slid  = slideAll(trans);
    result = transpose(reverseRows(slid));
    // down = transpose → reverseRows → slide → reverseRows → transpose
    // after slideAll on (transpose→reverseRows): gridRow=col, gridCol=(3-row) → undo reverseRows then transpose
    bombCollisions.forEach(bc => {
      const tmpR = bc.gridRow;
      const tmpC = bc.gridCol;
      // undo reverseRows on cols: actual col in transposed = 3 - tmpC
      // then undo transpose: actual row = 3-tmpC, actual col = tmpR
      bc.gridRow = 3 - tmpC;
      bc.gridCol = tmpR;
    });
  }

  if (!result) return { board, score: 0, moved: false, merges: 0, exploded: false, bonusScore: 0 };
  const moved = result.some((row, r) => row.some((v, c) => v !== board[r][c]));
  if (!moved) return { board, score: 0, moved: false, merges: 0, exploded: false, bonusScore: 0 };

  // Apply bomb explosions
  let workBoard = result;
  let totalBonusScore = 0;
  let exploded = false;
  for (const { gridRow, gridCol } of bombCollisions) {
    const { newBoard, bonusScore } = applyBombExplosion(workBoard, gridRow, gridCol);
    workBoard = newBoard;
    totalBonusScore += bonusScore;
    exploded = true;
  }

  // Spawn normal tile then maybe a bomb
  let finalBoard = addTile(workBoard);
  finalBoard = maybeSpawnBomb(finalBoard);

  return { board: finalBoard, score: totalScore, moved: true, merges: totalMerges, exploded, bonusScore: totalBonusScore };
}

function hasValidMove(board) {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (board[r][c] === 0) return true;
    // bomb always allows a move (it can collide with neighbors)
    if (board[r][c] === 'bomb') return true;
    if (c < 3 && (board[r][c] === board[r][c + 1] || board[r][c + 1] === 'bomb')) return true;
    if (r < 3 && (board[r][c] === board[r + 1][c] || board[r + 1][c] === 'bomb')) return true;
  }
  return false;
}

function has2048(board) { return board.some(row => row.some(v => typeof v === 'number' && v >= 2048)); }

// ── Component ────────────────────────────────────────────────────────

export default function Game2048() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]           = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]     = useState(location.state?.entryFee ?? 1);
  const [opponent, setOpponent]     = useState(null);
  const [roomId, setRoomId]         = useState(null);
  const [countdown, setCountdown]   = useState(null);
  const [board, setBoard]           = useState(() => initBoard());
  const [myScore, setMyScore]       = useState(0);
  const [oppScore, setOppScore]     = useState(0);
  const [roundScore, setRoundScore] = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult] = useState(null);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [comboFlash, setComboFlash] = useState(null); // null | { text: string, key: number }
  const [boomFlash, setBoomFlash]   = useState(false); // true for ~0.5s after bomb explosion

  const boardRef    = useRef(initBoard());
  const scoreRef    = useRef(0);
  const gameOverRef = useRef(false);
  const wonRef      = useRef(false);
  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const phaseRef     = useRef(phase);
  const eloBeforeRef = useRef(null);
  const touchRef    = useRef(null);
  const frameRef    = useRef(0); // animation frame counter for bomb pulse

  roomIdRef.current  = roomId;
  profileRef.current = profile;
  phaseRef.current   = phase;

  const isDiamonds = betCurrency === 'diamonds';
  const myBalance  = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const isWinner   = result && result.winnerId === profile?.id;

  const { RejoinOverlay } = useGamePageRejoin('twoFortyEight', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('game'); },
    () => setPhase('lobby'),
  );

  function resetGame() {
    const b = initBoard();
    boardRef.current  = b;
    scoreRef.current  = 0;
    gameOverRef.current = false;
    wonRef.current    = false;
    setBoard(b);
    setMyScore(0);
    setOppScore(0);
    setComboFlash(null);
    setBoomFlash(false);
  }

  // Socket events
  useEffect(() => {
    if (!socket) return;

    function onPrivateRoomCreated({ code }) { setPrivateCode(code); setPhase('private_waiting'); }

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      if (fee !== undefined) setEntryFee(fee);
      setRoundScore({ me: 0, opp: 0 });
      setCurrentRound(1);
      setRoundResult(null);
      setResult(null);
      setPhase('countdown');
    }

    function onCountdown({ count }) { setCountdown(count); setPhase('countdown'); }

    function onRoundStart({ round }) {
      setCurrentRound(round);
      setCountdown(null);
      setRoundResult(null);
      resetGame();
      setPhase('game');
    }

    function onOppScore({ score }) { setOppScore(score); }

    function onRoundResult({ round, roundWinnerId, scores }) {
      const myId = profileRef.current?.id;
      setRoundResult({ round, won: roundWinnerId === myId });
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('round_result');
    }

    function onResult(data) {
      const myId = profileRef.current?.id;
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      if (data.scores) {
        setRoundScore({
          me:  data.scores[myId] ?? 0,
          opp: data.scores[Object.keys(data.scores).find(k => k !== myId)] ?? 0,
        });
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

    socket.on('private_room_created',  onPrivateRoomCreated);
    socket.on('g2048_match_found',    onMatchFound);
    socket.on('g2048_countdown',      onCountdown);
    socket.on('g2048_round_start',    onRoundStart);
    socket.on('g2048_opponent_score', onOppScore);
    socket.on('g2048_round_result',   onRoundResult);
    socket.on('g2048_result',         onResult);
    socket.on('opponent_disconnected', onDisconnect);
    socket.on('error',                onError);

    return () => {
      socket.off('private_room_created',  onPrivateRoomCreated);
      socket.off('g2048_match_found',    onMatchFound);
      socket.off('g2048_countdown',      onCountdown);
      socket.off('g2048_round_start',    onRoundStart);
      socket.off('g2048_opponent_score', onOppScore);
      socket.off('g2048_round_result',   onRoundResult);
      socket.off('g2048_result',         onResult);
      socket.off('opponent_disconnected', onDisconnect);
      socket.off('error',               onError);
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard handler
  useEffect(() => {
    if (phase !== 'game') return;
    const KEY_DIR = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      a: 'left', d: 'right', w: 'up', s: 'down',
    };
    function handleKey(e) {
      const dir = KEY_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      if (gameOverRef.current || wonRef.current) return;
      applyMove(dir);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animation frame ticker for bomb pulse border (animFrame drives re-renders, value unused directly)
  const [animFrame, setAnimFrame] = useState(0); // eslint-disable-line no-unused-vars
  useEffect(() => {
    let rafId;
    let running = true;
    function tick() {
      if (!running) return;
      frameRef.current += 1;
      setAnimFrame(f => f + 1);
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafId); };
  }, []);

  function applyMove(dir) {
    if (gameOverRef.current || wonRef.current) return;
    const { board: nb, score: addScore, moved, merges, exploded, bonusScore } = moveBoard(boardRef.current, dir);
    if (!moved) return;
    boardRef.current = nb;

    // Combo multiplier (applied to normal merge score only)
    let finalScore = addScore;
    let comboText = null;
    if (merges >= 4) {
      finalScore = Math.round(addScore * 2);
      comboText = `COMBO ×2! +${finalScore}`;
    } else if (merges >= 2) {
      finalScore = Math.round(addScore * 1.5);
      comboText = `COMBO ×1.5! +${finalScore}`;
    }

    // Add bomb bonus score
    if (exploded && bonusScore > 0) {
      finalScore += bonusScore;
      setBoomFlash(true);
      setTimeout(() => setBoomFlash(false), 500);
    }

    scoreRef.current += finalScore;
    setBoard(nb.map(r => [...r]));
    setMyScore(scoreRef.current);

    if (comboText) {
      setComboFlash({ text: comboText, key: Date.now() });
      setTimeout(() => setComboFlash(null), 900);
    }

    if (addScore > 0 || bonusScore > 0) socket?.emit('g2048_score_ping', { roomId: roomIdRef.current, score: scoreRef.current });

    if (has2048(nb) && !wonRef.current) {
      wonRef.current = true;
      socket?.emit('g2048_reached_2048', { roomId: roomIdRef.current, score: scoreRef.current });
    } else if (!hasValidMove(nb) && !gameOverRef.current) {
      gameOverRef.current = true;
      socket?.emit('g2048_game_over', { roomId: roomIdRef.current, score: scoreRef.current });
    }
  }

  // Touch swipe
  function onTouchStart(e) { touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
  function onTouchEnd(e) {
    if (!touchRef.current || phaseRef.current !== 'game') return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    touchRef.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return;
    if (Math.abs(dx) > Math.abs(dy)) applyMove(dx > 0 ? 'right' : 'left');
    else applyMove(dy > 0 ? 'down' : 'up');
  }

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_g2048_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_g2048_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_g2048_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() { socket.emit('leave_g2048_queue'); setPhase('lobby'); setStatusMsg(''); }

  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'game2048', entryFee: fee ?? entryFee, currency: cur ?? betCurrency });
  }
  function joinPrivate(code) {
    if (!code?.trim()) return;
    socket.emit('join_private_room', { code: code.trim(), entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room', { code: privateCode });
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }

  function requestRematch() {
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    setResult(null);
    socket.emit('g2048_rematch_request', { roomId });
    setPhase('queue');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setStatusMsg('');
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    resetGame();
  }

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div
      className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {RejoinOverlay}

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🔢 2048"
          description="Slide and merge tiles — race your opponent to 2048"
          betCurrency={betCurrency}
          setBetCurrency={setBetCurrency}
          entryFee={entryFee}
          setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated}
          doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          botLabel="🎮 Solo Endless"
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
          controls="Arrow keys or WASD to move — Swipe on mobile"
        />
      )}

      {/* PRIVATE WAITING */}
      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in max-w-sm w-full">
          <h2 className="text-2xl font-bold text-white mb-2">Room Created</h2>
          <p className="text-muted mb-4">Share this code with your opponent:</p>
          <div className="text-5xl font-black font-mono text-accent tracking-widest mb-2 bg-surface border border-border rounded-xl py-4">{privateCode}</div>
          <button onClick={() => navigator.clipboard.writeText(privateCode)} className="text-xs text-primary hover:underline mb-6 block mx-auto">Copy code</button>
          <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted text-sm mb-4">Waiting for opponent to join...</p>
          <button onClick={cancelPrivate} className="text-xs text-muted hover:text-white transition-colors">Cancel</button>
        </div>
      )}

      {/* QUEUE */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* COUNTDOWN */}
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

      {/* GAME / ROUND_RESULT */}
      {(phase === 'game' || phase === 'round_result') && (
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          {/* Score header */}
          <div className="flex items-center justify-between w-full" style={{ maxWidth: '560px' }}>
            <div className="flex flex-col items-start min-w-[90px]">
              <span className="text-xs text-muted uppercase tracking-wide">You</span>
              <span className="text-2xl font-black font-mono text-success">{myScore}</span>
            </div>
            <div className="text-center">
              <span className="text-xs text-muted">vs <span className="text-white font-semibold">{opponent?.username || 'Duely Bot'}</span></span>
            </div>
            <div className="flex flex-col items-end min-w-[90px]">
              <span className="text-xs text-muted uppercase tracking-wide">{opponent?.username || 'Duely Bot'}</span>
              <span className={`text-2xl font-black font-mono ${oppScore > myScore ? 'text-danger' : oppScore < myScore ? 'text-success' : 'text-accent'}`}>{oppScore}</span>
            </div>
          </div>

          {/* Combo flash */}
          {comboFlash && (
            <div className="text-center font-black text-xl animate-fade-in" style={{ color: '#ffd700', textShadow: '0 0 16px #ffd70088' }}>
              {comboFlash.text}
            </div>
          )}

          {/* Round result overlay */}
          {phase === 'round_result' && roundResult && (
            <div className={`text-center px-6 py-2 rounded-xl border ${
              roundResult.won ? 'bg-success/10 border-success/30' : 'bg-danger/10 border-danger/30'
            }`}>
              <div className="font-black">{roundResult.won ? '✅ Round Won!' : '❌ Round Lost'}</div>
              <div className="text-xs text-muted animate-pulse">Next round starting...</div>
            </div>
          )}

          {/* Board */}
          <div className={`relative ${phase === 'round_result' ? 'opacity-50 pointer-events-none' : ''}`}>
            {/* BOOM flash overlay */}
            {boomFlash && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
                borderRadius: '16px',
                background: 'rgba(255, 100, 0, 0.18)',
              }}>
                <span style={{
                  fontSize: '3rem', fontWeight: 900, color: '#ff6400',
                  textShadow: '0 0 24px #ff640088, 0 2px 0 #000',
                  letterSpacing: '2px',
                }}>BOOM!</span>
              </div>
            )}
            <div style={{
              background: BOARD_BG, padding: '12px', borderRadius: '16px',
              display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px',
            }}>
              {board.map((row, r) => row.map((val, c) => {
                const isBomb = val === 'bomb';
                const pulse = 0.5 + 0.5 * Math.sin(frameRef.current / 15);
                const bombBorderColor = `rgba(255, 100, 0, ${pulse.toFixed(3)})`;

                if (isBomb) {
                  return (
                    <div key={`${r}-${c}`} style={{
                      width: 'clamp(88px, 18vw, 120px)', height: 'clamp(88px, 18vw, 120px)',
                      background: '#2a2a2a',
                      border: `3px solid ${bombBorderColor}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '2.4rem', borderRadius: '10px',
                      boxShadow: `0 0 12px ${bombBorderColor}`,
                      transition: 'box-shadow 0.05s',
                    }}>
                      💣
                    </div>
                  );
                }

                const bg = TILE_COLORS[val] ?? CELL_BG;
                const fg = (val === 2 || val === 4) ? TEXT_COLOR_DARK : (val === 0 ? TEXT_COLOR_DARK : TEXT_COLOR_LIGHT);
                const fs = val >= 1000 ? '22px' : val >= 100 ? '28px' : '38px';

                return (
                  <div key={`${r}-${c}`} style={{
                    width: 'clamp(88px, 18vw, 120px)', height: 'clamp(88px, 18vw, 120px)',
                    background: bg, color: fg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: fs, fontWeight: 'bold', borderRadius: '10px',
                    transition: 'background 0.1s',
                  }}>
                    {val !== 0 ? val : ''}
                  </div>
                );
              }))}
            </div>
          </div>

          {/* Mobile d-pad */}
          <div className="grid grid-cols-3 gap-2 mt-1 md:hidden">
            <div />
            <button onPointerDown={() => applyMove('up')}
              className="py-3 bg-surface border border-border rounded-lg text-white text-xl font-bold active:bg-primary/20">↑</button>
            <div />
            <button onPointerDown={() => applyMove('left')}
              className="py-3 bg-surface border border-border rounded-lg text-white text-xl font-bold active:bg-primary/20">←</button>
            <button onPointerDown={() => applyMove('down')}
              className="py-3 bg-surface border border-border rounded-lg text-white text-xl font-bold active:bg-primary/20">↓</button>
            <button onPointerDown={() => applyMove('right')}
              className="py-3 bg-surface border border-border rounded-lg text-white text-xl font-bold active:bg-primary/20">→</button>
          </div>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 ${isWinner ? '' : 'grayscale'}`}>{isWinner ? '🏆' : '💀'}</div>
          <h2 className={`text-4xl font-black mb-2 ${isWinner ? 'text-success' : 'text-danger'}`}>
            {isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-muted">Score</span>
              <span className="text-white font-bold">{myScore} — {oppScore}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Your ELO</span>
              <span className="text-white font-bold">{(() => {
                const elo = isWinner ? result.newWinnerElo : result.newLoserElo;
                const delta = elo - (eloBeforeRef.current ?? elo);
                return <>{elo} <span className={delta >= 0 ? 'text-success' : 'text-danger'}>({delta >= 0 ? '+' : ''}{delta})</span></>;
              })()}</span>
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
          </div>

          <div className="flex gap-3">
            <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
            <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
          </div>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
        </div>
      </div>
      )}
    </div>
  );
}

