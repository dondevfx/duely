import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import ResultScreen from '../components/ResultScreen';
import { usePageReady } from '../hooks/usePageReady';

const COLS = 10;
const ROWS = 20;
const CELL = 36;

const COIN_FEES    = [0.5, 1, 2, 5, 10, 25];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

// Score table: 1, 2, 3, 4 lines (real Tetris scoring)
const LINE_SCORES = [0, 100, 300, 500, 800];

// Neon color mapping per piece type
const PIECE_COLORS = {
  I: '#00ffff',   // cyan
  O: '#ffff00',   // yellow
  T: '#cc44ff',   // purple
  S: '#00ff88',   // lime green
  Z: '#ff4444',   // red
  J: '#4488ff',   // blue
  L: '#ff8800',   // orange
};

const PIECES = [
  { type: 'I', shape: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], color: PIECE_COLORS.I },
  { type: 'O', shape: [[1,1],[1,1]],                               color: PIECE_COLORS.O },
  { type: 'T', shape: [[0,1,0],[1,1,1],[0,0,0]],                   color: PIECE_COLORS.T },
  { type: 'S', shape: [[0,1,1],[1,1,0],[0,0,0]],                   color: PIECE_COLORS.S },
  { type: 'Z', shape: [[1,1,0],[0,1,1],[0,0,0]],                   color: PIECE_COLORS.Z },
  { type: 'J', shape: [[1,0,0],[1,1,1],[0,0,0]],                   color: PIECE_COLORS.J },
  { type: 'L', shape: [[0,0,1],[1,1,1],[0,0,0]],                   color: PIECE_COLORS.L },
];

// Speed table: ms per gravity tick per level (index = level - 1, capped at 9)
const SPEED_TABLE = [800, 720, 640, 560, 480, 400, 330, 260, 200, 150];
function getDropSpeed(lines) {
  const level = Math.min(Math.floor(lines / 10), 9);
  return SPEED_TABLE[level];
}

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function rotate(shape) {
  const n = shape.length, m = shape[0].length;
  const out = Array.from({ length: m }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++)
    for (let c = 0; c < m; c++)
      out[c][n - 1 - r] = shape[r][c];
  return out;
}

function makePiece(p) {
  return { type: p.type, shape: p.shape, color: p.color,
    x: Math.floor(COLS / 2) - Math.floor(p.shape[0].length / 2), y: 0 };
}

function shuffledBag() {
  const idx = [0,1,2,3,4,5,6];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

function validPos(board, shape, px, py) {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const nr = py + r, nc = px + c;
      if (nc < 0 || nc >= COLS || nr >= ROWS) return false;
      if (nr >= 0 && board[nr][nc] && board[nr][nc] !== 'PU') return false;
    }
  }
  return true;
}

function placePiece(board, shape, px, py, color) {
  const nb = board.map(r => [...r]);
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      if (shape[r][c] && py + r >= 0) nb[py + r][px + c] = color;
  return nb;
}

// Returns { board, cleared, clearedRows }
function clearLines(board, puCell = null) {
  const clearedRows = [];
  for (let r = 0; r < ROWS; r++) {
    const full = board[r].every((c, col) =>
      Boolean(c) || (puCell && puCell.row === r && puCell.col === col)
    );
    if (full) clearedRows.push(r);
  }
  const kept = board.filter((row, r) => {
    const full = row.every((c, col) =>
      Boolean(c) || (puCell && puCell.row === r && puCell.col === col)
    );
    return !full;
  });
  const cleared = ROWS - kept.length;
  while (kept.length < ROWS) kept.unshift(Array(COLS).fill(0));
  return { board: kept, cleared, clearedRows };
}

function addGarbageRows(board, count) {
  const hole = Math.floor(Math.random() * COLS);
  const garbage = Array.from({ length: count }, () => {
    const row = Array(COLS).fill('#8B1A1A');
    row[hole] = 0;
    return row;
  });
  return [...board.slice(count), ...garbage];
}

export default function TetrisGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const location = useLocation();

  const [phase, setPhase]           = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]     = useState(location.state?.entryFee ?? COIN_FEES[Math.floor(COIN_FEES.length / 2)]);
  const [opponent, setOpponent]     = useState(null);
  const [roomId, setRoomId]         = useState(null);
  const [countdown, setCountdown]   = useState(null);
  const [score, setScore]           = useState(0);
  const [level, setLevel]           = useState(1);
  const [linesCleared, setLinesCleared] = useState(0);
  const [oppLines, setOppLines]     = useState(0);
  const [isSolo, setIsSolo]         = useState(false);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');
  const [oppBoard, setOppBoard]     = useState(null);
  const [nextPieces, setNextPieces] = useState([]);
  const [privateCode, setPrivateCode] = useState('');
  const [garbageAlert, setGarbageAlert] = useState(0); // rows incoming, for flash UI

  // Power-up states
  const [activePowerUp, setActivePowerUp] = useState(null);

  const canvasRef  = useRef(null);
  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const phaseRef     = useRef(phase);
  const eloBeforeRef = useRef(null);

  // Game state in refs (never trigger re-render during play)
  const boardRef        = useRef(emptyBoard());
  const pieceRef        = useRef(null);
  const nextPiecesRef   = useRef([]);
  const bagRef          = useRef([]);
  const linesRef        = useRef(0);
  const scoreRef        = useRef(0);
  const levelRef        = useRef(1);
  const deadRef         = useRef(false);
  const gravityDelayRef = useRef(SPEED_TABLE[0]);
  const lastTickRef     = useRef(0);
  const rafRef          = useRef(null);
  const lockAndNextRef  = useRef(null);
  const flashRowsRef    = useRef(new Set());
  const flashStartRef   = useRef(0);
  const softDropRef     = useRef(null); // interval for holding down arrow
  const softDropTimerRef = useRef(null); // timeout before fast drop starts

  // Speed / power-up refs
  const totalLinesRef   = useRef(0);
  const powerUpCellRef  = useRef(null); // null | { row, col, type }
  const activePowerUpRef = useRef(null); // mirrors activePowerUp state for use inside RAF

  roomIdRef.current  = roomId;
  profileRef.current = profile;
  phaseRef.current   = phase;

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? '💎' : '🪙';
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const isWinner     = result && result.winnerId === profile?.id;

  useEffect(() => { setEntryFee(isDiamonds ? DIAMOND_FEES[Math.floor(DIAMOND_FEES.length / 2)] : COIN_FEES[Math.floor(COIN_FEES.length / 2)]); }, [betCurrency]);

  // Stop soft-drop interval and any pending start timer
  function stopSoftDrop() {
    if (softDropTimerRef.current) {
      clearTimeout(softDropTimerRef.current);
      softDropTimerRef.current = null;
    }
    if (softDropRef.current) {
      clearInterval(softDropRef.current);
      softDropRef.current = null;
    }
  }

  // Shared move logic — called by keyboard and touch buttons
  function tetrisMove(dir) {
    if (phaseRef.current !== 'game') return;
    const p = pieceRef.current;
    const b = boardRef.current;
    if (!p) return;
    if (dir === 'left'   && validPos(b, p.shape, p.x - 1, p.y)) { pieceRef.current = { ...p, x: p.x - 1 }; return; }
    if (dir === 'right'  && validPos(b, p.shape, p.x + 1, p.y)) { pieceRef.current = { ...p, x: p.x + 1 }; return; }
    if (dir === 'down') {
      if (validPos(b, p.shape, p.x, p.y + 1)) pieceRef.current = { ...p, y: p.y + 1 };
      else lockAndNextRef.current?.();
      return;
    }
    if (dir === 'rotate') {
      const rot = rotate(p.shape);
      if      (validPos(b, rot, p.x,     p.y)) pieceRef.current = { ...p, shape: rot };
      else if (validPos(b, rot, p.x + 1, p.y)) pieceRef.current = { ...p, shape: rot, x: p.x + 1 };
      else if (validPos(b, rot, p.x - 1, p.y)) pieceRef.current = { ...p, shape: rot, x: p.x - 1 };
      return;
    }
    if (dir === 'drop') {
      let ny = p.y;
      while (validPos(b, p.shape, p.x, ny + 1)) ny++;
      pieceRef.current = { ...p, y: ny };
      stopSoftDrop();
      lockAndNextRef.current?.();
    }
  }

  // Key handler — hold ArrowDown = soft drop interval, left/right work independently
  useEffect(() => {
    function onKey(e) {
      if (phaseRef.current !== 'game') return;
      if (e.key === 'ArrowLeft') {
        tetrisMove('left');
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        tetrisMove('right');
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (!e.repeat && !softDropRef.current && !softDropTimerRef.current) {
          tetrisMove('down');
          // Small delay before fast drop kicks in
          softDropTimerRef.current = setTimeout(() => {
            softDropTimerRef.current = null;
            softDropRef.current = setInterval(() => tetrisMove('down'), 50);
          }, 160);
        }
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'z' || e.key === 'Z') {
        tetrisMove('rotate');
        e.preventDefault();
      } else if (e.key === ' ') {
        tetrisMove('drop');
        e.preventDefault();
      }
    }
    function onKeyUp(e) {
      if (e.key === 'ArrowDown') stopSoftDrop();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      stopSoftDrop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function startGame() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    bagRef.current = [];
    function bagPiece() {
      if (bagRef.current.length === 0) bagRef.current = shuffledBag();
      return makePiece(PIECES[bagRef.current.pop()]);
    }

    boardRef.current        = emptyBoard();
    linesRef.current        = 0;
    scoreRef.current        = 0;
    levelRef.current        = 1;
    deadRef.current         = false;
    gravityDelayRef.current = SPEED_TABLE[0];
    lastTickRef.current     = 0;
    totalLinesRef.current   = 0;
    powerUpCellRef.current  = null;
    activePowerUpRef.current = null;
    setActivePowerUp(null);
    setLinesCleared(0);
    setScore(0);
    setLevel(1);

    pieceRef.current = bagPiece();
    // Fill 9 pieces in the queue for the next-piece panel
    nextPiecesRef.current = [bagPiece(), bagPiece(), bagPiece(), bagPiece(), bagPiece(), bagPiece(), bagPiece(), bagPiece(), bagPiece()];
    setNextPieces([...nextPiecesRef.current]);

    // --- Power-up: floating text (simple approach) ---
    function showFloatingText(text) {
      // We'll reflect a status message briefly; doesn't require DOM changes
      setStatusMsg(text);
      setTimeout(() => setStatusMsg(''), 2000);
    }

    // --- Power-up activation ---
    // IMPORTANT: returns the modified board so the caller can use it instead of 'cleared'.
    // Previously boardRef.current was set inside here but then overwritten by boardRef.current = cleared below.
    function activatePowerUp(type, boardAfterClear) {
      if (type === 'double') {
        // Double points for 15s — no board change
        const pu = { type: 'double', endsAt: Date.now() + 15000 };
        activePowerUpRef.current = pu;
        setActivePowerUp(pu);
        setTimeout(() => {
          if (activePowerUpRef.current?.type === 'double') {
            activePowerUpRef.current = null;
            setActivePowerUp(null);
          }
        }, 15000);
        showFloatingText('⚡ DOUBLE POINTS 15s!');
        return boardAfterClear; // board unchanged

      } else if (type === 'bomb') {
        // Count every filled block in the board-after-clear, give 20 pts each, wipe
        let blocksCleared = 0;
        for (let r = 0; r < ROWS; r++)
          for (let c = 0; c < COLS; c++)
            if (boardAfterClear[r][c]) blocksCleared++;
        const isDouble = activePowerUpRef.current?.type === 'double' && Date.now() < activePowerUpRef.current.endsAt;
        const bonus = blocksCleared * 20 * (isDouble ? 2 : 1);
        if (bonus > 0) {
          scoreRef.current += bonus;
          setScore(scoreRef.current);
        }
        showFloatingText(`💣 BOOM! +${bonus > 0 ? bonus.toLocaleString() : 'CLEAR'}`);
        return emptyBoard(); // return empty board — caller stores this

      } else if (type === 'clearer') {
        // Clear the power-up's row + the row below it (2 rows)
        const pu = powerUpCellRef.current;
        const puRow = pu ? pu.row : ROWS - 1;
        const nb = boardAfterClear.map(r => [...r]);
        for (let c = 0; c < COLS; c++) nb[puRow][c] = 0;
        if (puRow + 1 < ROWS) for (let c = 0; c < COLS; c++) nb[puRow + 1][c] = 0;
        showFloatingText('🧹 ROWS CLEARED!');
        return nb; // return modified board — caller stores this
      }
      return boardAfterClear;
    }

    function lockAndNext() {
      if (deadRef.current) return;
      const p = pieceRef.current;
      const b = boardRef.current;
      if (!p) return;

      const locked = placePiece(b, p.shape, p.x, p.y, p.color);

      // Spawn power-up cell: 20% chance, only if none exists, bottom 4 rows only
      if (!powerUpCellRef.current && Math.random() < 0.20) {
        const types = ['double', 'bomb', 'clearer'];
        const type = types[Math.floor(Math.random() * 3)];
        const row = ROWS - 1 - Math.floor(Math.random() * 4); // rows 16–19
        const col = Math.floor(Math.random() * COLS);
        powerUpCellRef.current = { row, col, type };
      }

      const { board: cleared, cleared: num, clearedRows } = clearLines(locked, powerUpCellRef.current);

      // Start with the cleared board; power-up may replace it
      let finalBoard = cleared;

      if (num > 0) {
        // Flash rows
        const fullRows = new Set(clearedRows);
        flashRowsRef.current = fullRows;
        flashStartRef.current = performance.now();
        setTimeout(() => { flashRowsRef.current = new Set(); }, 200);

        // Scoring BEFORE power-up (so double-check uses current multiplier state)
        const isDouble = activePowerUpRef.current?.type === 'double' && Date.now() < activePowerUpRef.current.endsAt;
        const multiplier = isDouble ? 2 : 1;
        const gain = ((LINE_SCORES[num] ?? 0) * levelRef.current) * multiplier;
        scoreRef.current += gain;

        // Activate power-up if its row was cleared — returns the board to use
        const pu = powerUpCellRef.current;
        if (pu && clearedRows.includes(pu.row)) {
          finalBoard = activatePowerUp(pu.type, cleared); // ← use returned board
          powerUpCellRef.current = null;
        }

        // Update total lines for speed escalation
        totalLinesRef.current += num;
        linesRef.current += num;

        const newSpeed = getDropSpeed(totalLinesRef.current);
        if (newSpeed !== gravityDelayRef.current) gravityDelayRef.current = newSpeed;

        const newLevel = Math.floor(linesRef.current / 10) + 1;
        levelRef.current = newLevel;

        setScore(scoreRef.current);
        setLevel(levelRef.current);
        setLinesCleared(linesRef.current);
      }

      boardRef.current = finalBoard; // ← use finalBoard (may be empty after bomb, etc.)
      if (socket && roomIdRef.current) {
        socket.emit('tetris_score_ping', { roomId: roomIdRef.current, linesCleared: linesRef.current, score: scoreRef.current });
        if (num >= 2) socket.emit('tetris_garbage', { roomId: roomIdRef.current, rows: num - 1 });
      }
      // Perfect clear: board completely empty after clearing
      const isPerfectClear = num > 0 && cleared.every(row => row.every(c => !c));
      if (isPerfectClear) {
        scoreRef.current += 2000;
        setScore(scoreRef.current);
        if (socket && roomIdRef.current) {
          socket.emit('tetris_garbage', { roomId: roomIdRef.current, rows: 4 });
        }
      }
      lastTickRef.current = performance.now();

      const next = nextPiecesRef.current[0] || bagPiece();
      nextPiecesRef.current = [...nextPiecesRef.current.slice(1), bagPiece()];
      setNextPieces([...nextPiecesRef.current]);

      if (!validPos(cleared, next.shape, next.x, next.y)) {
        deadRef.current = true;
        stopSoftDrop();
        if (socket && roomIdRef.current) {
          socket.emit('tetris_topped_out', { roomId: roomIdRef.current, linesCleared: linesRef.current, score: scoreRef.current });
        }
        return;
      }
      pieceRef.current = next;
      if (socket && roomIdRef.current) {
        socket.emit('tetris_board_update', { roomId: roomIdRef.current, board: boardRef.current });
      }
    }
    lockAndNextRef.current = lockAndNext;

    const ctx = canvas.getContext('2d');

    function draw(timestamp) {
      // Gravity based on current speed level
      if (!deadRef.current && phaseRef.current === 'game') {
        if (timestamp - lastTickRef.current >= gravityDelayRef.current) {
          lastTickRef.current = timestamp;
          const p = pieceRef.current;
          const b = boardRef.current;
          if (p) {
            if (validPos(b, p.shape, p.x, p.y + 1)) {
              pieceRef.current = { ...p, y: p.y + 1 };
            } else {
              lockAndNext();
            }
          }
        }
      }

      // --- Board background: very dark with faint grid lines ---
      ctx.fillStyle = '#05080f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid lines
      ctx.strokeStyle = 'rgba(30,40,60,0.8)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= COLS; x++) {
        ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ROWS * CELL); ctx.stroke();
      }
      for (let y = 0; y <= ROWS; y++) {
        ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(COLS * CELL, y * CELL); ctx.stroke();
      }

      // --- Board cells with neon glow ---
      const b = boardRef.current;
      const flashRows = flashRowsRef.current;
      const flashAlpha = flashRows.size > 0 ? Math.min(1, (performance.now() - flashStartRef.current) / 80) : 0;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cell = b[r][c];
          if (cell) {
            const cellColor = cell;
            const cx = c * CELL, cy = r * CELL;
            if (flashRows.has(r)) {
              ctx.fillStyle = `rgba(255,255,255,${1.0 - flashAlpha * 0.8})`;
              ctx.shadowColor = '#ffffff';
              ctx.shadowBlur = 24;
              ctx.fillRect(cx + 1, cy + 1, CELL - 2, CELL - 2);
              ctx.shadowBlur = 0;
            } else {
              // Neon glow for locked cells
              ctx.fillStyle = cellColor;
              ctx.shadowColor = cellColor;
              ctx.shadowBlur = 12;
              ctx.fillRect(cx + 1, cy + 1, CELL - 2, CELL - 2);
              // Inner darker fill to show depth
              ctx.shadowBlur = 0;
              ctx.fillStyle = cellColor + '55';
              ctx.fillRect(cx + 2, cy + 2, CELL - 4, CELL - 4);
              // Bright top-left edge for pixel-art look
              ctx.fillStyle = 'rgba(255,255,255,0.18)';
              ctx.fillRect(cx + 1, cy + 1, CELL - 2, 2); // top edge
              ctx.fillRect(cx + 1, cy + 1, 2, CELL - 2); // left edge
              ctx.shadowBlur = 0;
              // Garbage row overlay
              if (cellColor === '#8B1A1A') {
                ctx.fillStyle = 'rgba(255,80,0,0.15)';
                ctx.fillRect(cx + 1, cy + 1, CELL - 2, CELL - 2);
              }
            }
          }
        }
      }
      ctx.shadowBlur = 0;

      // --- Power-up cell ---
      const puCell = powerUpCellRef.current;
      if (puCell) {
        const hasBlock = b[puCell.row]?.[puCell.col];
        const t = performance.now() / 1000;
        const pulse = 0.6 + 0.4 * Math.sin(t * 3);
        const px2 = puCell.col * CELL, py2 = puCell.row * CELL;

        const colors = {
          double:  { bg: '#001833', border: '#0088ff', glow: '#0066ff' },
          bomb:    { bg: '#1a0800', border: '#ff6600', glow: '#ff4400' },
          clearer: { bg: '#001a00', border: '#00cc44', glow: '#00aa33' },
        };
        const pc = colors[puCell.type] || colors.double;

        if (!hasBlock) {
          // Draw full power-up cell (bg + pulsing border)
          ctx.shadowColor = pc.glow;
          ctx.shadowBlur = 16 * pulse;
          ctx.fillStyle = pc.bg;
          ctx.fillRect(px2 + 1, py2 + 1, CELL - 2, CELL - 2);
          ctx.strokeStyle = pc.border;
          ctx.lineWidth = 2;
          ctx.globalAlpha = pulse;
          ctx.strokeRect(px2 + 2, py2 + 2, CELL - 4, CELL - 4);
          ctx.globalAlpha = 1;
          ctx.fillStyle = pc.border + '22';
          ctx.fillRect(px2 + 3, py2 + 3, CELL - 6, CELL - 6);
          ctx.fillStyle = pc.border;
          ctx.fillRect(px2 + 2, py2 + 2, 4, 4);
          ctx.fillRect(px2 + CELL - 6, py2 + 2, 4, 4);
          ctx.fillRect(px2 + 2, py2 + CELL - 6, 4, 4);
          ctx.fillRect(px2 + CELL - 6, py2 + CELL - 6, 4, 4);
          ctx.shadowBlur = 0;
        } else {
          // Block is covering the power-up — draw a high-contrast dark pill behind the emoji
          // so it pops clearly over any block color
          const cx2 = px2 + CELL / 2;
          const cy2 = py2 + CELL / 2;
          const r2 = CELL * 0.38;
          ctx.save();
          ctx.globalAlpha = 0.82 * pulse;
          ctx.fillStyle = '#000000';
          ctx.shadowColor = pc.glow;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.ellipse(cx2, cy2, r2, r2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = pc.border;
          ctx.lineWidth = 2;
          ctx.globalAlpha = pulse;
          ctx.stroke();
          ctx.restore();
        }

        // Always draw emoji — larger and with glow when hidden under a block
        ctx.shadowBlur = hasBlock ? 8 : 0;
        ctx.shadowColor = pc.glow;
        ctx.globalAlpha = 1;
        ctx.font = `${Math.floor(CELL * (hasBlock ? 0.65 : 0.58))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          puCell.type === 'double' ? '⚡' : puCell.type === 'bomb' ? '💣' : '🧹',
          px2 + CELL / 2, py2 + CELL / 2
        );
      }

      const piece = pieceRef.current;
      if (piece && !deadRef.current) {
        // Ghost piece — compute where the piece would land
        let ghostY = piece.y;
        while (validPos(b, piece.shape, piece.x, ghostY + 1)) ghostY++;

        if (ghostY !== piece.y) {
          for (let r = 0; r < piece.shape.length; r++) {
            for (let c = 0; c < piece.shape[r].length; c++) {
              if (piece.shape[r][c]) {
                const gr = ghostY + r;
                const gc = piece.x + c;
                if (gr >= 0 && gr < ROWS && gc >= 0 && gc < COLS) {
                  const gx = gc * CELL, gy = gr * CELL;
                  ctx.strokeStyle = piece.color + '88';
                  ctx.lineWidth = 2;
                  ctx.strokeRect(gx + 2, gy + 2, CELL - 4, CELL - 4);
                }
              }
            }
          }
        }

        // Active piece with neon glow
        for (let r = 0; r < piece.shape.length; r++) {
          for (let c = 0; c < piece.shape[r].length; c++) {
            if (piece.shape[r][c]) {
              const px = (piece.x + c) * CELL;
              const py = (piece.y + r) * CELL;
              // Background fill with glow
              ctx.fillStyle = piece.color;
              ctx.shadowColor = piece.color;
              ctx.shadowBlur = 12;
              ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
              // Inner darker fill to show depth
              ctx.shadowBlur = 0;
              ctx.fillStyle = piece.color + '55';
              ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
              // Bright top-left edge for pixel-art look
              ctx.fillStyle = 'rgba(255,255,255,0.18)';
              ctx.fillRect(px + 1, py + 1, CELL - 2, 2); // top edge
              ctx.fillRect(px + 1, py + 1, 2, CELL - 2); // left edge
              ctx.shadowBlur = 0;
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    }
    rafRef.current = requestAnimationFrame(draw);
  }

  function stopGame() {
    cancelAnimationFrame(rafRef.current);
    stopSoftDrop();
  }

  useEffect(() => {
    if (phase === 'game') {
      const t = setTimeout(startGame, 100);
      return () => { clearTimeout(t); stopGame(); };
    }
    return stopGame;
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Socket events
  useEffect(() => {
    if (!socket) return;

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee, vsBot }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp);
      setIsSolo(!!vsBot);
      if (fee !== undefined) setEntryFee(fee);
      setResult(null);
      setOppBoard(null);
      setPhase('countdown');
    }

    function onCountdown({ count }) {
      setCountdown(count);
      setPhase('countdown');
    }

    function onRoundStart() {
      setCountdown(null);
      setLinesCleared(0);
      setScore(0);
      setLevel(1);
      setOppLines(0);
      setOppBoard(null);
      setStatusMsg('');
      setPhase('game');
    }

    function onResult(data) {
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      stopGame();
      refreshProfile();
    }

    function onDisconnect(data = {}) {
      stopGame();
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

    function onGarbageIncoming({ rows }) {
      if (deadRef.current) return;
      boardRef.current = addGarbageRows(boardRef.current, rows);
      setGarbageAlert(rows);
      setTimeout(() => setGarbageAlert(0), 900);
    }

    socket.on('tetris_match_found',    onMatchFound);
    socket.on('tetris_countdown',      onCountdown);
    socket.on('tetris_round_start',    onRoundStart);
    socket.on('tetris_opponent_board', ({ board }) => setOppBoard(board));
    socket.on('tetris_opponent_lines', ({ linesCleared: l }) => setOppLines(l));
    socket.on('tetris_garbage_incoming', onGarbageIncoming);
    socket.on('tetris_result',         onResult);
    socket.on('opponent_disconnected', onDisconnect);
    socket.on('error',                 onError);
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      socket.emit('leave_game');
      socket.off('tetris_match_found',    onMatchFound);
      socket.off('tetris_countdown',      onCountdown);
      socket.off('tetris_round_start',    onRoundStart);
      socket.off('tetris_opponent_board');
      socket.off('tetris_opponent_lines');
      socket.off('tetris_garbage_incoming', onGarbageIncoming);
      socket.off('tetris_result',         onResult);
      socket.off('opponent_disconnected', onDisconnect);
      socket.off('error',                 onError);
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_tetris_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_tetris_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting bot match...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_tetris_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_tetris_queue');
    setPhase('lobby');
    setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'tetris', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'tetris', code });
    setPhase('queue');
    setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby');
    setPrivateCode('');
    setStatusMsg('');
  }

  function requestRematch() {
    stopGame();
    setResult(null);
    socket.emit('tetris_rematch_request', { roomId });
    setPhase('queue');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    stopGame();
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setStatusMsg('');
    setOppBoard(null);
  }

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🟩 Block Fall"
          description="Stack falling blocks to clear lines and earn points. Power-ups spawn in the bottom 4 rows — clear a line containing one to activate: ⚡ Double points 15s · 💣 Clears entire board (points for every block!) · 🧹 Wipes 5 rows"
          controls="← → move · ↑ / Z rotate · ↓ soft drop (hold) · Space hard drop"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          botLabel="🎮 Solo Endless"
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
          gameType="tetris"
          liveCount={playerCounts?.tetris ?? 0}
        />
      )}

      {/* PRIVATE WAITING */}
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

      {/* GAME */}
      {phase === 'game' && (
        <div className="flex items-start justify-center gap-4 animate-fade-in w-full max-w-sm lg:max-w-none px-2">
          {/* Main board */}
          <div className="flex flex-col items-center gap-2 w-full lg:w-auto">
            {/* Score/Level header */}
            <div className="flex items-center justify-between w-full gap-2">
              <div className="text-center min-w-[80px]">
                <div className="text-lg font-black font-mono text-success">{score.toLocaleString()}</div>
                <div className="text-[10px] text-muted leading-tight">Score</div>
              </div>
              <div className="text-center flex-1">
                {isSolo
                  ? <div className="text-base font-black text-success">∞ Endless</div>
                  : <div className="text-base font-black text-accent">Race</div>
                }
                <div className="text-xs font-bold text-primary">Lv {level}</div>
              </div>
              <div className="text-center min-w-[80px]">
                {isSolo ? (
                  <div className="text-lg font-black font-mono text-muted">{linesCleared}</div>
                ) : (
                  <div className={`text-lg font-black font-mono ${oppLines > linesCleared ? 'text-danger' : oppLines < linesCleared ? 'text-success' : 'text-accent'}`}>{oppLines}</div>
                )}
                <div className="text-[10px] text-muted leading-tight">{isSolo ? 'Lines' : opponent?.username ?? 'Opp'}</div>
              </div>
            </div>

            {/* Lines cleared below score */}
            <div className="flex items-center justify-between w-full text-xs text-muted px-1">
              <span>{linesCleared} lines</span>
              {!isSolo && <span className="text-accent">{profile?.username ?? 'You'} vs {opponent?.username ?? 'Opp'}</span>}
            </div>

            {/* Power-up HUD */}
            {activePowerUp && (
              <div className="text-center text-sm font-black animate-pulse"
                style={{
                  color: activePowerUp.type === 'slow' ? '#aa44ff' : '#00ffff',
                  textShadow: activePowerUp.type === 'slow' ? '0 0 12px #aa44ff' : '0 0 12px #00ffff',
                }}>
                {activePowerUp.type === 'double' && <>⚡ DOUBLE SCORE {Math.max(0, Math.ceil((activePowerUp.endsAt - Date.now()) / 1000))}s</>}
                {activePowerUp.type === 'slow' && <>🐢 SLOW TIME {activePowerUp.remaining}s</>}
              </div>
            )}
            {statusMsg && (
              <div className="text-center text-sm font-black animate-pulse"
                style={{ color: '#ff8800', textShadow: '0 0 10px #ff8800' }}>
                {statusMsg}
              </div>
            )}

            <div className="relative">
              {garbageAlert > 0 && (
                <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center pointer-events-none"
                  style={{ animation: 'fadeIn 0.15s ease' }}>
                  <div className="bg-red-700/90 text-white text-xs font-bold px-3 py-1 rounded-b-lg shadow-lg">
                    ⚠ +{garbageAlert} garbage {garbageAlert === 1 ? 'row' : 'rows'}!
                  </div>
                </div>
              )}
              <canvas
                ref={canvasRef}
                width={COLS * CELL}
                height={ROWS * CELL}
                className="rounded-xl border border-border block"
                style={{ maxWidth: '100%', height: 'auto' }}
              />
            </div>

            {/* Mobile touch controls */}
            <div className="md:hidden w-full mt-3 select-none">
              <div className="grid grid-cols-3 gap-2 mb-2">
                <button
                  onPointerDown={() => tetrisMove('left')}
                  className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-2xl font-bold active:bg-primary/30 touch-none">←</button>
                <button
                  onPointerDown={() => tetrisMove('rotate')}
                  className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-xl font-bold active:bg-primary/30 touch-none">↺</button>
                <button
                  onPointerDown={() => tetrisMove('right')}
                  className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-2xl font-bold active:bg-primary/30 touch-none">→</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    tetrisMove('down');
                    if (!softDropRef.current && !softDropTimerRef.current) {
                      softDropTimerRef.current = setTimeout(() => {
                        softDropTimerRef.current = null;
                        softDropRef.current = setInterval(() => tetrisMove('down'), 60);
                      }, 160);
                    }
                  }}
                  onPointerUp={stopSoftDrop}
                  onPointerLeave={stopSoftDrop}
                  className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-xl font-bold active:bg-primary/30 touch-none">↓ Hold</button>
                <button
                  onPointerDown={() => tetrisMove('drop')}
                  className="py-5 rounded-xl bg-primary/20 border border-primary/40 text-primary text-xl font-bold active:bg-primary/50 touch-none">⬇ Drop</button>
              </div>
            </div>
          </div>

          {/* Next pieces preview — always shows first 3 */}
          <div className="flex lg:flex-col items-center gap-3 lg:pt-10 w-full lg:w-auto">
            <div className="text-xs text-muted font-bold uppercase tracking-widest">Next</div>
            <div className="flex lg:flex-col gap-2 flex-row flex-nowrap">
              {nextPieces.slice(0, 3).map((piece, idx) => {
                const cs = idx === 0 ? 22 : 17;
                let minR = piece.shape.length, maxR = -1, minC = piece.shape[0]?.length ?? 0, maxC = -1;
                piece.shape.forEach((row, r) => row.forEach((cell, c) => { if (cell) { minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c); } }));
                const trimmed = maxR < 0 ? piece.shape : piece.shape.slice(minR, maxR + 1).map(row => row.slice(minC, maxC + 1));
                const cols = trimmed[0]?.length ?? 1;
                const rows = trimmed.length;
                return (
                  <div key={idx}
                    className="bg-surface border border-border rounded-xl flex items-center justify-center transition-opacity"
                    style={{ width: 104, height: 84, opacity: idx === 0 ? 1 : 0.55 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${cs}px)`, gridTemplateRows: `repeat(${rows}, ${cs}px)`, gap: 2 }}>
                      {trimmed.map((row, r) =>
                        row.map((cell, c) => (
                          <div key={`${r}-${c}`} style={{
                            width: cs, height: cs,
                            background: cell ? piece.color : 'transparent',
                            boxShadow: cell ? `0 0 5px ${piece.color}aa` : 'none',
                            borderRadius: 3,
                          }} />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <ResultScreen
            isWinner={isWinner}
            winnerUsername={result.winnerUsername}
            loserUsername={result.loserUsername}
            newWinnerElo={result.newWinnerElo}
            newLoserElo={result.newLoserElo}
            eloBeforeRef={eloBeforeRef}
            balanceChange={result.balanceChange}
            currency={resultCurrency}
            entryFee={entryFee}
            disconnected={result.disconnected}
            winnerStreak={result.winnerStreak}
            isFirstWin={result.isFirstWin}
            profile={profile}
            gameLabel="🟩 Block Fall"
            extraRows={[{
              label: 'Score',
              value: `${(isWinner ? result.winnerScore ?? result.winnerLines : result.loserScore ?? result.loserLines).toLocaleString()} — ${(isWinner ? result.loserScore ?? result.loserLines : result.winnerScore ?? result.winnerLines).toLocaleString()}`,
            }]}
            onRematch={!isSolo ? requestRematch : null}
            onPlayAgain={backToLobby}
            rematchLabel="Rematch"
          />
        </div>
      )}
    </div>
  );
}


