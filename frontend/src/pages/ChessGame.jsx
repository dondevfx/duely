import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.5, 1, 2, 5, 10, 25];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];
const SQ = 76; // square size px

// ── Unicode pieces (kept for drag ghost) ──────────────────────────────────────
const GLYPH = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟',
};

// ── SVG chess piece shapes ────────────────────────────────────────────────────
function ChessPieceSVG({ piece }) {
  const isWhite = piece[0] === 'w';
  const type    = piece[1]; // 'K','Q','R','B','N','P'

  const fill   = isWhite ? '#ffffff' : '#000000';
  const stroke = isWhite ? '#000000' : '#ffffff';

  let shape = null;
  if (type === 'P') {
    shape = (
      <>
        {/* Wide base platform */}
        <rect x="11" y="39" width="23" height="4" rx="2" fill={fill} stroke={stroke} strokeWidth="1.2" />
        {/* Tapered skirt */}
        <path d="M 14,39 C 14,34 16,30 18.5,28 C 19.5,27 21,26.5 22.5,26.5 C 24,26.5 25.5,27 26.5,28 C 29,30 31,34 31,39 Z"
          fill={fill} stroke={stroke} strokeWidth="1.2" />
        {/* Neck */}
        <rect x="20" y="19" width="5" height="8" rx="1" fill={fill} stroke={stroke} strokeWidth="1.2" />
        {/* Head */}
        <circle cx="22.5" cy="14" r="6.5" fill={fill} stroke={stroke} strokeWidth="1.2" />
      </>
    );
  } else if (type === 'R') {
    shape = (
      <>
        <path d="M 9,39 L 36,39 L 36,36 L 9,36 Z" />
        <path d="M 12.5,32 L 14,29.5 L 31,29.5 L 32.5,32 Z" />
        <path d="M 12,36 L 12,32 L 33,32 L 33,36 Z" />
        <path d="M 14,29.5 L 14,16.5 L 31,16.5 L 31,29.5 Z" />
        <path d="M 14,16.5 L 11,14 L 34,14 L 31,16.5 Z" />
        <path d="M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14 Z" />
        <path d="M 12,35.5 L 33,35.5" fill="none" strokeWidth="1" stroke={stroke} />
        <path d="M 13,31.5 L 32,31.5" fill="none" strokeWidth="1" stroke={stroke} />
        <path d="M 14,29.5 L 31,29.5" fill="none" strokeWidth="1" stroke={stroke} />
      </>
    );
  } else if (type === 'N') {
    shape = (
      <g>
        <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" />
        <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" />
        <path d="M 9.5,25.5 A 0.5,0.5 0 1 1 8.5,25.5 A 0.5,0.5 0 1 1 9.5,25.5 z" fill={isWhite ? '#000' : '#fff'} />
        <path d="M 15,15.5 A 0.5,1.5 0 1 1 14,15.5 A 0.5,1.5 0 1 1 15,15.5 z" transform="rotate(30,15,15.5)" fill={isWhite ? '#000' : '#fff'} />
      </g>
    );
  } else if (type === 'B') {
    shape = (
      <>
        <path d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 Z" />
        <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26.5 27.5,26.5 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26.5 C 17.5,26.5 15,27.5 15,30 C 15,30 14.5,30.5 15,32 Z" />
        <path d="M 25,8 A 2.5,2.5 0 1 1 20,8 A 2.5,2.5 0 1 1 25,8 Z" />
        <path d="M 17.5,26 L 27.5,26" fill="none" stroke={stroke} strokeWidth="1" />
        <path d="M 15,30 L 30,30" fill="none" stroke={stroke} strokeWidth="1" />
        <path d="M 22.5,15.5 L 22.5,20.5" fill="none" stroke={stroke} strokeWidth="1.5" />
        <path d="M 20,18 L 25,18" fill="none" stroke={stroke} strokeWidth="1.5" />
      </>
    );
  } else if (type === 'Q') {
    shape = (
      <g>
        <circle cx="6" cy="12" r="2.75" />
        <circle cx="14" cy="9" r="2.75" />
        <circle cx="22.5" cy="8" r="2.75" />
        <circle cx="31" cy="9" r="2.75" />
        <circle cx="39" cy="12" r="2.75" />
        <path d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 22.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 z" />
        <path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11.5,38.5 11.5,38.5 C 17.5,40.5 27.5,40.5 33.5,38.5 C 33.5,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z" />
        <path d="M 11.5,30 C 15,29 30,29 33.5,30" fill="none" stroke={isWhite ? '#000' : '#fff'} strokeWidth="1" />
        <path d="M 12,33.5 C 15,32.5 30,32.5 33,33.5" fill="none" stroke={isWhite ? '#000' : '#fff'} strokeWidth="1" />
      </g>
    );
  } else if (type === 'K') {
    shape = (
      <g>
        <path d="M 22.5,11.63 L 22.5,6" stroke={isWhite ? '#000' : '#fff'} strokeWidth="1.5" fill="none" />
        <path d="M 20,8 L 25,8" stroke={isWhite ? '#000' : '#fff'} strokeWidth="1.5" fill="none" />
        <path d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25" />
        <path d="M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 z" />
        <path d="M 12,36.5 C 18,39.5 27,39.5 33,36.5" fill="none" stroke={isWhite ? '#000' : '#fff'} strokeWidth="1" />
        <path d="M 12,37 L 12,32.5 C 12,32.5 7,28.5 10,23.5 C 10,23.5 13,22.5 15,26 C 18,23 19.5,22 22.5,22 C 25.5,22 27,23 30,26 C 32,22.5 35,23.5 35,23.5 C 38,28.5 33,32.5 33,32.5 L 33,37" fill="none" stroke={isWhite ? '#000' : '#fff'} strokeWidth="1" />
      </g>
    );
  }

  return (
    <svg
      viewBox="0 0 45 45"
      width="100%"
      height="100%"
      style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
    >
      <g
        fill={isWhite ? '#ffffff' : '#000000'}
        stroke={isWhite ? '#000000' : '#ffffff'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {shape}
      </g>
    </svg>
  );
}

// ── Board logic ───────────────────────────────────────────────────────────────

function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const BACK = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = 'b' + BACK[c];
    b[1][c] = 'bP';
    b[6][c] = 'wP';
    b[7][c] = 'w' + BACK[c];
  }
  return b;
}

function initCastle() { return { w: { k: true, q: true }, b: { k: true, q: true } }; }
function pc(p)        { return p?.[0] ?? null; }
function pt(p)        { return p?.[1] ?? null; }
function inB(r, c)    { return r >= 0 && r < 8 && c >= 0 && c < 8; }

// All squares a piece attacks (pawn attacks only diagonally, regardless of occupancy)
function attacks(board, r, c) {
  const p = board[r][c];
  if (!p) return [];
  const col = pc(p), type = pt(p);
  const res = [];
  if (type === 'P') {
    const d = col === 'w' ? -1 : 1;
    for (const dc of [-1, 1]) if (inB(r + d, c + dc)) res.push([r + d, c + dc]);
    return res;
  }
  function ray(dr, dc) {
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc)) { res.push([nr, nc]); if (board[nr][nc]) break; nr += dr; nc += dc; }
  }
  if (type === 'N') {
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
      if (inB(r+dr, c+dc)) res.push([r+dr, c+dc]);
  } else if (type === 'B') {
    for (const d of [[-1,-1],[-1,1],[1,-1],[1,1]]) ray(...d);
  } else if (type === 'R') {
    for (const d of [[-1,0],[1,0],[0,-1],[0,1]]) ray(...d);
  } else if (type === 'Q') {
    for (const d of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) ray(...d);
  } else if (type === 'K') {
    for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])
      if (inB(r+dr, c+dc)) res.push([r+dr, c+dc]);
  }
  return res;
}

function isAttacked(board, r, c, byColor) {
  for (let pr = 0; pr < 8; pr++)
    for (let pc2 = 0; pc2 < 8; pc2++) {
      if (!board[pr][pc2] || pc(board[pr][pc2]) !== byColor) continue;
      if (attacks(board, pr, pc2).some(([mr, mc]) => mr === r && mc === c)) return true;
    }
  return false;
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (board[r][c] === color + 'K') return [r, c];
  return [0, 0];
}

function inCheck(board, color) {
  const [kr, kc] = findKing(board, color);
  return isAttacked(board, kr, kc, color === 'w' ? 'b' : 'w');
}

function pseudoMoves(board, r, c, castle, ep) {
  const p = board[r][c];
  if (!p) return [];
  const col = pc(p), type = pt(p), opp = col === 'w' ? 'b' : 'w';
  const res = [];

  function tryAdd(nr, nc) {
    if (inB(nr, nc) && (!board[nr][nc] || pc(board[nr][nc]) !== col)) res.push([nr, nc]);
  }
  function ray(dr, dc) {
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc)) {
      const t = board[nr][nc];
      if (t) { if (pc(t) !== col) res.push([nr, nc]); break; }
      res.push([nr, nc]); nr += dr; nc += dc;
    }
  }

  if (type === 'P') {
    const d = col === 'w' ? -1 : 1, start = col === 'w' ? 6 : 1;
    const nr = r + d;
    if (inB(nr, c) && !board[nr][c]) {
      res.push([nr, c]);
      if (r === start && !board[nr + d]?.[c]) res.push([nr + d, c]);
    }
    for (const dc of [-1, 1]) {
      if (!inB(nr, c + dc)) continue;
      if (board[nr][c + dc] && pc(board[nr][c + dc]) === opp) res.push([nr, c + dc]);
      if (ep && ep[0] === nr && ep[1] === c + dc) res.push([nr, c + dc]);
    }
  } else if (type === 'N') {
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) tryAdd(r+dr, c+dc);
  } else if (type === 'B') {
    for (const d of [[-1,-1],[-1,1],[1,-1],[1,1]]) ray(...d);
  } else if (type === 'R') {
    for (const d of [[-1,0],[1,0],[0,-1],[0,1]]) ray(...d);
  } else if (type === 'Q') {
    for (const d of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) ray(...d);
  } else if (type === 'K') {
    for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) tryAdd(r+dr, c+dc);
    const rank = col === 'w' ? 7 : 0;
    if (r === rank && c === 4 && !inCheck(board, col)) {
      if (castle[col]?.k && !board[rank][5] && !board[rank][6] &&
          !isAttacked(board, rank, 5, opp) && !isAttacked(board, rank, 6, opp))
        res.push([rank, 6]);
      if (castle[col]?.q && !board[rank][3] && !board[rank][2] && !board[rank][1] &&
          !isAttacked(board, rank, 3, opp) && !isAttacked(board, rank, 2, opp))
        res.push([rank, 2]);
    }
  }
  return res;
}

function applyMove(board, fr, fc, tr, tc, castle, ep) {
  const nb = board.map(row => [...row]);
  const piece = nb[fr][fc], col = pc(piece), type = pt(piece);
  let newEp = null;
  const newCastle = { w: { ...castle.w }, b: { ...castle.b } };
  nb[tr][tc] = piece;
  nb[fr][fc] = null;
  // En passant capture
  if (type === 'P' && ep && tr === ep[0] && tc === ep[1]) nb[fr][tc] = null;
  // En passant target
  if (type === 'P' && Math.abs(tr - fr) === 2) newEp = [(fr + tr) / 2, fc];
  // Castling rook move
  if (type === 'K') {
    const rank = col === 'w' ? 7 : 0;
    if (fc === 4 && tc === 6) { nb[rank][5] = nb[rank][7]; nb[rank][7] = null; }
    if (fc === 4 && tc === 2) { nb[rank][3] = nb[rank][0]; nb[rank][0] = null; }
    newCastle[col] = { k: false, q: false };
  }
  if (type === 'R') {
    if (col === 'w') { if (fc === 7) newCastle.w.k = false; if (fc === 0) newCastle.w.q = false; }
    else             { if (fc === 7) newCastle.b.k = false; if (fc === 0) newCastle.b.q = false; }
  }
  // Rook captured at corner removes rights
  if (tr === 0 && tc === 0) newCastle.b.q = false;
  if (tr === 0 && tc === 7) newCastle.b.k = false;
  if (tr === 7 && tc === 0) newCastle.w.q = false;
  if (tr === 7 && tc === 7) newCastle.w.k = false;
  // Auto-queen
  if (type === 'P' && (tr === 0 || tr === 7)) nb[tr][tc] = col + 'Q';
  return { board: nb, ep: newEp, castle: newCastle };
}

function legalMoves(board, r, c, castle, ep) {
  const col = pc(board[r][c]);
  return pseudoMoves(board, r, c, castle, ep).filter(([tr, tc]) => {
    const { board: nb } = applyMove(board, r, c, tr, tc, castle, ep);
    return !inCheck(nb, col);
  });
}

function allLegal(board, color, castle, ep) {
  const all = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (board[r][c] && pc(board[r][c]) === color)
      for (const to of legalMoves(board, r, c, castle, ep))
        all.push({ from: [r, c], to });
  return all;
}

function gameStatus(board, colorToMove, castle, ep) {
  const legal = allLegal(board, colorToMove, castle, ep);
  if (legal.length > 0) return inCheck(board, colorToMove) ? 'check' : 'playing';
  return inCheck(board, colorToMove) ? 'checkmate' : 'stalemate';
}

function botMove(board, botColor, castle, ep) {
  const moves = allLegal(board, botColor, castle, ep);
  if (!moves.length) return null;
  // Prefer captures, then checks
  const caps = moves.filter(({ to: [tr, tc] }) => board[tr][tc]);
  const pool = caps.length ? caps : moves;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChessGame() {
  const ready = usePageReady();
  const [boardZoom, setBoardZoom] = useState(1);
  useEffect(() => {
    const update = () => setBoardZoom(Math.min(1, (window.innerWidth - 24) / (8 * SQ + 32)));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  const location = useLocation();

  const [phase, setPhase]               = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]         = useState(location.state?.entryFee ?? COIN_FEES[Math.floor(COIN_FEES.length / 2)]);
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
  const [legals, setLegals]             = useState([]);
  const [castle, setCastle]             = useState(initCastle);
  const [ep, setEp]                     = useState(null);
  const [status, setStatus]             = useState('playing');
  const [lastMove, setLastMove]         = useState(null);

  // Refs for stale-closure-safe callbacks
  const boardRef      = useRef(initBoard());
  const castleRef     = useRef(initCastle());
  const epRef         = useRef(null);
  const turnRef       = useRef('w');
  const myColorRef    = useRef('w');
  const vsBotRef      = useRef(false);
  const roomIdRef     = useRef(null);
  const profileRef    = useRef(profile);
  const phaseRef      = useRef('lobby');
  const doneRef       = useRef(false);
  const botTimerRef   = useRef(null);
  const eloBeforeRef  = useRef(profile?.elo ?? 1000);

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

  useEffect(() => { setEntryFee(isDiamonds ? DIAMOND_FEES[Math.floor(DIAMOND_FEES.length / 2)] : COIN_FEES[Math.floor(COIN_FEES.length / 2)]); }, [betCurrency]);

  // ── Client-side countdown when phase = 'countdown' ──────────────────────────
  useEffect(() => {
    if (phase !== 'countdown') return;
    let count = 3;
    setCountdown(count);
    const iv = setInterval(() => {
      count--;
      if (count > 0) { setCountdown(count); }
      else { clearInterval(iv); setCountdown(null); setPhase('game'); }
    }, 1000);
    return () => clearInterval(iv);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── If bot goes first (shouldn't happen — player is always white) ────────────
  useEffect(() => {
    if (phase === 'game' && vsBotRef.current && turnRef.current !== myColorRef.current) {
      scheduleBotMove();
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Game reset ───────────────────────────────────────────────────────────────
  function resetGame(colForMe = 'w') {
    const b = initBoard();
    const c = initCastle();
    boardRef.current  = b;
    castleRef.current = c;
    epRef.current     = null;
    turnRef.current   = 'w';
    doneRef.current   = false;
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
    setBoard(b);
    setMyColor(colForMe);
    myColorRef.current = colForMe;
    setCastle(c);
    setEp(null);
    setCurrentTurn('w');
    setSelected(null);
    setLegals([]);
    setStatus('playing');
    setLastMove(null);
  }

  // ── Execute a move (used by both player and bot) ─────────────────────────────
  function execMove(fr, fc, tr, tc) {
    const b   = boardRef.current;
    const c   = castleRef.current;
    const ep2 = epRef.current;

    const { board: nb, ep: newEp, castle: newC } = applyMove(b, fr, fc, tr, tc, c, ep2);
    boardRef.current  = nb;
    castleRef.current = newC;
    epRef.current     = newEp;

    const nextTurn = turnRef.current === 'w' ? 'b' : 'w';
    turnRef.current = nextTurn;

    setBoard(nb.map(r => [...r]));
    setCastle({ ...newC });
    setEp(newEp);
    setCurrentTurn(nextTurn);
    setLastMove({ from: [fr, fc], to: [tr, tc] });
    setSelected(null);
    setLegals([]);

    const st = gameStatus(nb, nextTurn, newC, newEp);
    setStatus(st);

    if (st === 'checkmate' || st === 'stalemate') {
      if (!doneRef.current) {
        doneRef.current = true;
        if (st === 'checkmate') {
          // nextTurn lost (they're in checkmate). The mover won.
          const moverColor = nextTurn === 'w' ? 'b' : 'w';
          const iWon = moverColor === myColorRef.current;
          socket?.emit('chess_game_over', {
            roomId: roomIdRef.current,
            winnerSocketId: iWon ? socket.id : null,
            reason: 'checkmate',
          });
        } else {
          socket?.emit('chess_game_over', { roomId: roomIdRef.current, winnerSocketId: null, reason: 'stalemate' });
        }
      }
    } else if (vsBotRef.current && nextTurn !== myColorRef.current) {
      scheduleBotMove();
    } else if (vsBotRef.current && nextTurn === myColorRef.current) {
      // Bot just finished its turn — tell server so it restarts our timer
      socket?.emit('chess_bot_done', { roomId: roomIdRef.current });
    }
  }

  function scheduleBotMove() {
    if (botTimerRef.current) clearTimeout(botTimerRef.current);
    botTimerRef.current = setTimeout(() => {
      if (phaseRef.current !== 'game' || !vsBotRef.current) return;
      const botColor = myColorRef.current === 'w' ? 'b' : 'w';
      const move = botMove(boardRef.current, botColor, castleRef.current, epRef.current);
      if (!move) {
        if (!doneRef.current) {
          doneRef.current = true;
          const st2 = inCheck(boardRef.current, botColor) ? 'checkmate' : 'stalemate';
          socket?.emit('chess_game_over', {
            roomId: roomIdRef.current,
            winnerSocketId: st2 === 'checkmate' ? socket?.id : null,
            reason: st2,
          });
        }
        return;
      }
      execMove(move.from[0], move.from[1], move.to[0], move.to[1]);
    }, 700 + Math.random() * 700);
  }

  // ── Square click ─────────────────────────────────────────────────────────────
  function handleClick(r, c) {
    if (phaseRef.current !== 'game') return;
    if (turnRef.current !== myColorRef.current) return;
    if (doneRef.current) return;

    const b   = boardRef.current;
    const c2  = castleRef.current;
    const ep2 = epRef.current;

    if (selected) {
      if (legals.some(([lr, lc]) => lr === r && lc === c)) {
        const [fr, fc] = selected;
        execMove(fr, fc, r, c);
        socket?.emit('chess_move', { roomId: roomIdRef.current, from: [fr, fc], to: [r, c], boardSnapshot: { board: boardRef.current, castle: castleRef.current, ep: epRef.current } });
        return;
      }
    }
    if (b[r][c] && pc(b[r][c]) === myColorRef.current) {
      setSelected([r, c]);
      setLegals(legalMoves(b, r, c, c2, ep2));
    } else {
      setSelected(null);
      setLegals([]);
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

    function onOpponentMove({ from: [fr, fc], to: [tr, tc] }) {
      if (!vsBotRef.current) execMove(fr, fc, tr, tc);
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

    socket.on('chess_timer', ({ endsAt, currentTurn }) => {
      if (currentTurn === myColorRef.current) setTimerEndsAt(endsAt);
      else setTimerEndsAt(null);
    });
    socket.on('chess_turn_skipped', ({ nextTurn }) => {
      setCurrentTurn(nextTurn);
      // If it's now the bot's turn, kick off its move immediately
      if (vsBotRef.current && nextTurn !== myColorRef.current) scheduleBotMove();
    });
    socket.on('chess_match_found',    onMatchFound);
    socket.on('chess_opponent_move',  onOpponentMove);
    socket.on('chess_result',         onResult);
    socket.on('opponent_disconnected', onDisconnect);
    socket.on('error',                onError);
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });
    socket.on('chess_rejoin', ({ myColor: col, currentTurn: ct, boardSnapshot, opponent: opp, entryFee: fee }) => {
      if (boardSnapshot) {
        boardRef.current  = boardSnapshot.board;
        castleRef.current = boardSnapshot.castle || initCastle();
        epRef.current     = boardSnapshot.ep || null;
        setBoard(boardSnapshot.board.map(r => [...r]));
        setCastle(boardSnapshot.castle || initCastle());
        setEp(boardSnapshot.ep || null);
      }
      myColorRef.current = col || 'w';
      turnRef.current    = ct || 'w';
      setMyColor(col || 'w');
      setCurrentTurn(ct || 'w');
      if (opp) setOpponent(opp);
      if (fee !== undefined) setEntryFee(fee);
      setPhase('game');
    });

    return () => {
      socket.emit('leave_game');
      socket.off('chess_timer');
      socket.off('chess_turn_skipped');
      socket.off('chess_match_found',    onMatchFound);
      socket.off('chess_opponent_move',  onOpponentMove);
      socket.off('chess_result',         onResult);
      socket.off('opponent_disconnected', onDisconnect);
      socket.off('error',               onError);
      socket.off('private_room_created');
      socket.off('chess_rejoin');
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
    socket.emit('join_chess_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_chess_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_chess_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting free match...');
  }
  function leaveQueue() { socket.emit('leave_chess_queue'); setPhase('lobby'); setStatusMsg(''); }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'chess', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'chess', code });
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
      socket?.emit('chess_resign', { roomId });
    }
  }

  function requestRematch() {
    resetGame(myColor === 'w' ? 'b' : 'w');
    setResult(null);
    socket?.emit('chess_rematch_request', { roomId });
    setPhase('queue'); setStatusMsg('Waiting for rematch...');
  }

  function playAgainVsBot() {
    resetGame('w');
    setResult(null);
    socket.emit('play_chess_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting next bot match...');
  }

  function backToLobby() {
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null; }
    setVsBot(false); setBotWins(0); setBotLosses(0);
    setPhase('lobby'); setResult(null); setOpponent(null);
    setRoomId(null); setStatusMsg('');
    resetGame('w');
  }

  // ── Rendering helpers ────────────────────────────────────────────────────────
  const rows = myColor === 'b' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  const cols = myColor === 'b' ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];
  const files  = myColor === 'b' ? ['h','g','f','e','d','c','b','a'] : ['a','b','c','d','e','f','g','h'];
  const ranks  = myColor === 'b' ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];

  function sqBg(r, c) { return (r + c) % 2 === 0 ? '#F0D9B5' : '#B58863'; }
  const isSel   = (r, c) => selected?.[0] === r && selected?.[1] === c;
  const isLegal = (r, c) => legals.some(([lr, lc]) => lr === r && lc === c);
  const isLast  = (r, c) => lastMove && (
    (lastMove.from[0] === r && lastMove.from[1] === c) ||
    (lastMove.to[0]   === r && lastMove.to[1]   === c)
  );
  const isCheckSq = (r, c) => {
    const p = board[r][c];
    return p && pt(p) === 'K' && pc(p) === currentTurn && status === 'check';
  };

  const canInteract = phase === 'game' && currentTurn === myColor && !doneRef.current;
  const turnLabel   = status === 'checkmate' ? 'Checkmate!'
    : status === 'stalemate' ? 'Stalemate!'
    : status === 'check'     ? (currentTurn === myColor ? 'You are in check!' : 'Opponent in check')
    : currentTurn === myColor ? 'Your turn' : "Opponent's turn";
  const turnStyle   = status === 'checkmate' || status === 'stalemate' ? 'text-danger'
    : status === 'check' && currentTurn === myColor ? 'text-warning'
    : currentTurn === myColor ? 'text-success' : 'text-muted';

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-2 py-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="♟️ Chess"
          description="Classic chess — outthink your opponent to deliver checkmate. Both players wager; the winner claims the pot."
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
          gameType="chess"
          liveCount={playerCounts?.chess ?? 0}
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

          {/* Status bar */}
          <div className="flex flex-col items-center gap-1 w-full" style={{ maxWidth: `${8 * SQ + 20}px` }}>
            <div className="flex items-center justify-between w-full">
              <div className="text-xs text-muted font-bold">
                {myColor === 'b' ? (opponent?.username || 'Bot') : profile?.username}
                <span className="ml-1 opacity-50">{myColor === 'b' ? '♔' : '♚'}</span>
              </div>
              <span className={`text-xs font-black px-3 py-1 rounded-full border ${
                status === 'checkmate' || status === 'stalemate'
                  ? 'bg-danger/20 text-danger border-danger/30'
                  : status === 'check' && currentTurn === myColor
                    ? 'bg-warning/20 text-warning border-warning/30'
                    : currentTurn === myColor
                      ? 'bg-success/20 text-success border-success/30'
                      : 'bg-surface text-muted border-border'
              }`}>{turnLabel}</span>
              <div className="text-xs text-muted font-bold">
                <span className="mr-1 opacity-50">{myColor === 'w' ? '♔' : '♚'}</span>
                {myColor === 'w' ? (opponent?.username || 'Bot') : profile?.username}
              </div>
            </div>
            {timeLeft !== null && phase === 'game' && (
              <div className="w-full flex items-center gap-2">
                <span className="text-xs font-bold shrink-0" style={{ color: timeLeft <= 10 ? '#f87171' : timeLeft <= 20 ? '#fbbf24' : '#4ade80' }}>
                  ⏱ {timeLeft}s
                </span>
                <div className="flex-1 rounded-full overflow-hidden" style={{ height: 4, background: 'rgba(255,255,255,0.1)' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.max(0, (timeLeft / 60) * 100)}%`,
                    background: timeLeft <= 10 ? '#f87171' : timeLeft <= 20 ? '#fbbf24' : '#4ade80',
                    transition: 'width 0.25s linear, background 0.5s',
                  }} />
                </div>
              </div>
            )}
          </div>

          {/* Board + rank labels */}
          <div className="flex gap-1 items-start select-none">
            {/* Rank labels */}
            <div className="flex flex-col" style={{ height: `${8 * SQ}px` }}>
              {ranks.map(n => (
                <div key={n} style={{ height: `${SQ}px` }}
                  className="flex items-center justify-center text-[10px] text-muted w-4 font-mono">{n}</div>
              ))}
            </div>

            {/* Board */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(8, ${SQ}px)`,
              gridTemplateRows: `repeat(8, ${SQ}px)`,
              border: '3px solid #5d4037',
              borderRadius: '4px',
              overflow: 'hidden',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}>
              {rows.map(r => cols.map(c => {
                const piece     = board[r][c];
                const selected_ = isSel(r, c);
                const legal_    = isLegal(r, c);
                const last_     = isLast(r, c);
                const check_    = isCheckSq(r, c);
                const bg        = sqBg(r, c);

                let overlay = null;
                if (selected_) overlay = 'rgba(20,85,255,0.55)';
                else if (check_) overlay = 'rgba(220,30,30,0.55)';
                else if (last_)  overlay = 'rgba(235,200,20,0.40)';

                return (
                  <div key={`${r}-${c}`}
                    draggable={canInteract && !!piece && pc(piece) === myColor}
                    onClick={() => canInteract && handleClick(r, c)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', JSON.stringify([r, c]));
                      // Custom ghost: styled square with piece letter (unicode chess glyphs are unreliable cross-platform)
                      const isWhite = pc(piece) === 'w';
                      const ghost = document.createElement('div');
                      ghost.textContent = pt(piece);
                      ghost.style.cssText = `position:fixed;top:-999px;left:-999px;width:${SQ}px;height:${SQ}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(SQ*0.52)}px;font-weight:900;font-family:system-ui,sans-serif;background:${isWhite?'rgba(255,255,255,0.92)':'rgba(18,18,18,0.92)'};color:${isWhite?'#111':'#eee'};border-radius:10px;border:2.5px solid ${isWhite?'#aaa':'#555'};box-shadow:0 4px 16px rgba(0,0,0,0.6);pointer-events:none;`;
                      document.body.appendChild(ghost);
                      e.dataTransfer.setDragImage(ghost, SQ * 0.36, SQ * 0.36);
                      requestAnimationFrame(() => ghost.remove());
                      setSelected([r, c]);
                      setLegals(legalMoves(boardRef.current, r, c, castleRef.current, epRef.current));
                    }}
                    onDragEnd={() => { setSelected(null); setLegals([]); }}
                    onDragOver={(e) => { if (canInteract) e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      try {
                        const [fr, fc] = JSON.parse(e.dataTransfer.getData('text/plain'));
                        const fresh = legalMoves(boardRef.current, fr, fc, castleRef.current, epRef.current);
                        if (fresh.some(([lr, lc]) => lr === r && lc === c)) {
                          execMove(fr, fc, r, c);
                          socket?.emit('chess_move', { roomId: roomIdRef.current, from: [fr, fc], to: [r, c], boardSnapshot: { board: boardRef.current, castle: castleRef.current, ep: epRef.current } });
                        }
                      } catch {}
                      setSelected(null); setLegals([]);
                    }}
                    style={{
                      width: `${SQ}px`, height: `${SQ}px`,
                      backgroundColor: bg,
                      position: 'relative',
                      cursor: canInteract ? 'pointer' : 'default',
                    }}
                  >
                    {overlay && (
                      <div style={{ position: 'absolute', inset: 0, backgroundColor: overlay, pointerEvents: 'none' }} />
                    )}

                    {/* Legal move indicator */}
                    {legal_ && (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                        {piece ? (
                          <div style={{ width: '100%', height: '100%', borderRadius: 0, border: '4px solid rgba(20,85,220,0.65)', boxSizing: 'border-box' }} />
                        ) : (
                          <div style={{ width: `${SQ * 0.28}px`, height: `${SQ * 0.28}px`, borderRadius: '50%', backgroundColor: 'rgba(20,85,220,0.45)' }} />
                        )}
                      </div>
                    )}

                    {/* Piece */}
                    {piece && (
                      <div style={{
                        position: 'absolute', inset: 0,
                        padding: '4px',
                        userSelect: 'none', pointerEvents: 'none',
                      }}>
                        <ChessPieceSVG piece={piece} />
                      </div>
                    )}
                  </div>
                );
              }))}
            </div>
          </div>

          {/* File labels */}
          <div className="flex pl-5" style={{ width: `${8 * SQ + 20}px` }}>
            {files.map(f => (
              <div key={f} style={{ width: `${SQ}px` }}
                className="text-center text-[10px] text-muted font-mono">{f}</div>
            ))}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-4 mt-1">
            <span className="text-xs text-muted">
              Playing as{' '}
              <span className={`font-bold ${myColor === 'w' ? 'text-white' : 'text-gray-300'}`}>
                {myColor === 'w' ? 'White ♔' : 'Black ♚'}
              </span>
            </span>
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
          <h2 className={`text-4xl font-black mb-1 ${result.draw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`}>
            {result.draw ? 'Draw!' : isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected && (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          )}
          {isWinner && (result.winnerStreak ?? 0) >= 2 && (
            <p className="text-lg font-bold text-orange-400 mb-3" style={{ textShadow: '0 0 10px rgba(251,146,60,0.5)' }}>
              🔥 {result.winnerStreak} Win Streak!
            </p>
          )}
          {isWinner && result.isFirstWin && (
            <div className="mb-4 px-4 py-2 rounded-xl bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 text-sm font-bold">
              🎉 First Victory! You're on the board!
            </div>
          )}
          {!isWinner && !result?.draw && (
            <p className="text-sm text-muted italic mb-4">
              {["Sharp opponent — review this game and come back stronger.", "Every loss is a lesson in disguise.", "One tempo away — your endgame is improving."][Math.floor(Date.now() / 1000) % 3]}
            </p>
          )}
          {result.reason && (
            <p className="text-sm text-muted mb-4 capitalize">{result.reason.replace(/_/g, ' ')}</p>
          )}

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
                      <span className={isWinner ? 'text-2xl font-black text-success' : 'text-danger font-bold'}
                        style={isWinner ? { textShadow: '0 0 12px rgba(74,222,128,0.5)' } : {}}>
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

          <div className="flex flex-col gap-3">
            {vsBot
              ? <GlowButton variant="primary" onClick={playAgainVsBot} className="w-full">Play Again</GlowButton>
              : <GlowButton variant="primary" onClick={requestRematch} className="w-full">Rematch</GlowButton>
            }
            <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full border border-border">Home</GlowButton>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}




