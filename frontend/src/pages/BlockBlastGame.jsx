import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import PlayerName from '../components/PlayerName';
import DiamondIcon from '../components/DiamondIcon';
import { useLocation } from 'react-router-dom';
import { playMatchFound, playCountdown, playPlace, playClear, playBlast } from '../utils/sound';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby, { COIN_FEES } from '../components/GameLobby';
import ResultScreen from '../components/ResultScreen';
import GameHelp from '../components/GameHelp';
import ChallengeLinkBox from '../components/ChallengeLinkBox';
import PrivateWaiting from '../components/PrivateWaiting';
import { usePageReady } from '../hooks/usePageReady';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { useGameScrollLock } from '../hooks/useGameScrollLock';
import { useResumeMatch } from '../hooks/useResumeMatch';
import CoinIcon from '../components/CoinIcon';
import { usePrivateRematch } from '../hooks/usePrivateRematch';

// Coin tiers come from the shared list — this page had its own copy, so a tier
// added anywhere else silently skipped Block Burst.
//
// The DIAMOND tiers are deliberately still local: Block Burst offers six of
// them where the shared list has three, and folding it in would quietly remove
// four bet sizes players can currently pick.
const DIAMOND_FEES = [50, 100, 250, 500, 1000, 50000];

const GRID         = 8;

// Piece definitions: array of [row, col] offsets
const PIECE_DEFS = [
  [[0,0]],
  [[0,0],[0,1]],
  [[0,0],[1,0]],
  [[0,0],[0,1],[0,2]],
  [[0,0],[1,0],[2,0]],
  [[0,0],[1,0],[2,0],[2,1]],
  [[0,1],[1,1],[2,0],[2,1]],
  [[0,0],[0,1],[0,2],[1,1]],
  [[0,1],[0,2],[1,0],[1,1]],
  [[0,0],[0,1],[1,1],[1,2]],
  [[0,0],[0,1],[1,0],[1,1]],
  [[0,0],[0,1],[0,2],[0,3]],
  [[0,0],[1,0],[2,0],[3,0]],
  [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]],
];

const PIECE_COLORS = [
  '#00aaff','#00ff66','#ffee00','#ff2244','#cc44ff',
  '#00ffee','#ff8800','#ff66cc','#aaff00','#7755ff',
];

function makePRNG(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextPiece(rand) {
  const defIdx   = Math.floor(rand() * PIECE_DEFS.length);
  const colorIdx = Math.floor(rand() * PIECE_COLORS.length);
  return { cells: PIECE_DEFS[defIdx], color: PIECE_COLORS[colorIdx] };
}

// Returns true if a piece can be placed somewhere on the grid
function canBePlaced(grid, piece) {
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      if (canPlace(grid, piece, r, c)) return true;
  return false;
}

// Ensures at least 1 piece in tray can be placed; if not, replaces last slot with 1×1
function ensurePlayable(tray, grid) {
  const anyCanPlace = tray.some(p => p && canBePlaced(grid, p));
  if (!anyCanPlace) {
    tray[2] = { cells: [[0, 0]], color: '#888888' };
  }
  return tray;
}

function nextTray(rand, grid) {
  const tray = [nextPiece(rand), nextPiece(rand), nextPiece(rand)];
  if (grid) ensurePlayable(tray, grid);
  return tray;
}

function emptyGrid() {
  return Array.from({ length: GRID }, () => Array(GRID).fill(null));
}

function canPlace(grid, piece, r, c) {
  for (const [dr, dc] of piece.cells) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) return false;
    if (grid[nr][nc] !== null && grid[nr][nc] !== undefined) return false;
  }
  return true;
}

function place(grid, piece, r, c) {
  const next = grid.map(row => [...row]);
  for (const [dr, dc] of piece.cells) next[r + dr][c + dc] = piece.color;
  return next;
}

function clearLines(grid) {
  let g = grid.map(row => [...row]);
  let totalCleared = 0;
  let chain = 0;
  const allFullRows = [], allFullCols = [];
  while (true) {
    const fullRows = [], fullCols = [];
    for (let r = 0; r < GRID; r++) {
      if (g[r].every(c => c !== null)) fullRows.push(r);
    }
    for (let c = 0; c < GRID; c++) {
      if (g.every(row => row[c] !== null)) fullCols.push(c);
    }
    if (fullRows.length === 0 && fullCols.length === 0) break;
    for (const r of fullRows) for (let c = 0; c < GRID; c++) g[r][c] = null;
    for (const c of fullCols) for (let r = 0; r < GRID; r++) g[r][c] = null;
    totalCleared += fullRows.length + fullCols.length;
    chain++;
    allFullRows.push(...fullRows);
    allFullCols.push(...fullCols);
  }
  return { grid: g, cleared: totalCleared, fullRows: allFullRows, fullCols: allFullCols, chain };
}

function scoreForClear(cleared, cells, chain = 1) {
  const base = cells * 10 + cleared * 100 * Math.max(1, cleared);
  return Math.round(base * Math.max(1, chain));
}

function pieceMaxDim(piece) {
  const maxR = Math.max(...piece.cells.map(([r]) => r));
  const maxC = Math.max(...piece.cells.map(([,c]) => c));
  return { rows: maxR + 1, cols: maxC + 1 };
}

// Returns true if no piece in the tray can be placed anywhere on the grid
function checkIsStuck(grid, tray) {
  const pieces = tray.filter(Boolean);
  if (pieces.length === 0) return false;
  return pieces.every(piece => {
    for (let r = 0; r < GRID; r++)
      for (let c = 0; c < GRID; c++)
        if (canPlace(grid, piece, r, c)) return false;
    return true;
  });
}

export default function BlockBlastGame() {
  const ready = usePageReady();
  const { profile, refreshProfile, updateProfile } = useAuth();
  const { socket, authenticated, doAuth, playerCounts } = useSocket();
  // Rematch for invite/code matches — same two players, no new code.
  // See usePrivateRematch: the server marks the match private, and both
  // players must accept before anything is staked.
  const privateRematch = usePrivateRematch(socket, 'block_blast_match_found');
  // Only a live match re-claims itself after a reconnect; a refresh forfeits.
  useResumeMatch(socket, () => phaseRef.current === 'playing');
  const location = useLocation();

  const [phase, _setPhase]             = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  // Pin the page for the countdown and the match itself: start at the top,
  // and no scrolling the board off-screen while it is being played.
  useGameScrollLock(phase === 'queue' || phase === 'countdown' || phase === 'active', phase);
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee]       = useState(() => location.state?.entryFee ?? (betCurrency === 'diamonds' ? DIAMOND_FEES[0] : COIN_FEES[0]));
  const [opponent, setOpponent]       = useState(null);
  const [roomId, setRoomId]           = useState(null);
  const [countdown, setCountdown]     = useState(0);
  const [result, setResult]           = useState(null);
  const [statusMsg, setStatusMsg]     = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [invitedFriend, setInvitedFriend] = useState(null);
  const [isSolo, setIsSolo]           = useState(false);

  // Responsive cell size
  const [cellPx, setCellPx] = useState(Math.min(48, Math.floor((window.innerWidth - 32) / GRID)));
  useEffect(() => {
    const upd = () => setCellPx(Math.min(48, Math.floor((window.innerWidth - 32) / GRID)));
    window.addEventListener('resize', upd);
    return () => window.removeEventListener('resize', upd);
  }, []);
  const traySlot = Math.max(72, Math.round(112 * cellPx / 60));

  // Game state
  const [grid, setGrid]               = useState(emptyGrid());
  const [tray, setTray]               = useState([null, null, null]);
  const [dragging, setDragging]       = useState(null);
  const [cursorPos, setCursorPos]     = useState({ x: 0, y: 0 });
  const [hover, setHover]             = useState(null);
  const [score, setScore]             = useState(0);
  const [oppScore, setOppScore]       = useState(0);
  const [gameOver, setGameOver]       = useState(false);
  const [stuck, setStuck]             = useState(false);       // this player is stuck
  const [oppStuck, setOppStuck]       = useState(false);       // opponent is stuck
  const [flashCells, setFlashCells]   = useState(new Set());
  const [scorePopups, setScorePopups] = useState([]);

  const randRef        = useRef(null);
  const gridRef        = useRef(emptyGrid());
  const trayRef        = useRef([null, null, null]);
  const scoreRef       = useRef(0);
  const roomIdRef      = useRef(null);
  const phaseRef       = useRef(location.state?.autoQueue ? 'queue' : 'lobby');
  function setPhase(p) { phaseRef.current = p; _setPhase(p); }
  const gameOverRef    = useRef(false); // true once result/forfeit received — blocks stale game events
  const isSoloRef      = useRef(false);
  const stuckRef       = useRef(false);
  const profileRef     = useRef(profile);
  const eloBeforeRef   = useRef(null);
  const hoverRef          = useRef(null);
  const grabOffsetRef     = useRef({ x: 0, y: 0, halfRows: 0, halfCols: 0 });
  const gridContainerRef  = useRef(null);
  const popupIdRef     = useRef(0);
  // How long blast mode lasts. One constant: the countdown, the bar's drain
  // and the backstop timeout all have to agree, and three copies of 5000 is
  // three places for them to stop agreeing.
  const BLAST_MS = 5000;
  const [energy, setEnergy]               = useState(0);
  const [blastMode, setBlastMode]         = useState(false);
  const [blastSecondsLeft, setBlastSecondsLeft] = useState(0);
  // When the current blast ends, as a wall-clock deadline — see the countdown
  // effect below for why it is a deadline and not a subtraction.
  const blastUntilRef = useRef(0);
  // false on the frame blast starts, true from the next one. The gap between
  // the two is what gives the CSS transition something to animate from.
  const [blastDraining, setBlastDraining] = useState(false);
  const [keepPlayingSeconds, setKeepPlayingSeconds] = useState(0);
  const energyRef = useRef(0);
  const blastModeRef = useRef(false);
  const blastTimerRef = useRef(null);
  const keepPlayingTimerRef = useRef(null);
  const keepPlayingEndRef = useRef(null);

  const socketRef        = useRef(socket);
  const refreshProfileRef = useRef(refreshProfile);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { socketRef.current = socket; }, [socket]);
  useEffect(() => { refreshProfileRef.current = refreshProfile; }, [refreshProfile]);
  // Forfeit on every way out of the page — refresh, tab close, in-app
  // navigation — but NOT on an app switch. See useLeaveGuard.
  useLeaveGuard(socket);

  // Let the settlement land, then show the leaver their real balance.
  useEffect(() => () => { setTimeout(() => refreshProfileRef.current?.(), 2500); }, []);
  // Refresh balance on mount; delayed second call catches server settle that races with reload
  useEffect(() => {
    refreshProfile();
    const t = setTimeout(refreshProfile, 2500);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll locking lives in useGameScrollLock above, which locks the <main>
  // scroller rather than the document.
  //
  // What was here set `document.body.style.touchAction = 'none'` on a phase
  // named 'playing' — a phase this page does not have; its values are lobby,
  // queue, countdown, active, result and private_waiting. So it never ran, and
  // it was one rename away from putting touch-action: none on the whole
  // document, which stops taps reaching anything until a reload. Removed rather
  // than corrected, because the shared hook already does the job properly and
  // two things fighting over body styles is how one of them ends up stuck.

  // Blast mode: the energy bar runs backwards as the clock.
  //
  // There were two things saying the same thing — a bar pinned at 100% and a
  // number counting down beside it — and the bar, the bigger of the two, was
  // the one saying nothing.
  //
  // The DRAIN is one CSS transition, not a value pushed every 60ms. Setting
  // the width 83 times a second means 83 React renders of the whole board
  // fighting the grid for frames, and the bar visibly stepped — the stutter
  // was the updates arriving, not the animation. Handing the browser a single
  // "go to 0% over five seconds, linearly" lets it interpolate on the
  // compositor, which is both perfectly smooth and free.
  //
  // Two renders total: one to pin it full, one on the next frame to start it
  // moving. The frame between them is what makes the transition run at all —
  // set to 0% in the same paint as 100% and there is nothing to animate from.
  useEffect(() => {
    if (!blastMode) { setBlastDraining(false); return undefined; }
    const raf = requestAnimationFrame(() => setBlastDraining(true));
    return () => cancelAnimationFrame(raf);
  }, [blastMode]);

  // The seconds counter beside it, which needs a value rather than a style.
  // Once a second is all it can show, so that is all it is asked for.
  //
  // Measured against a deadline rather than counted down: a tick that arrives
  // late — a dropped frame, a backgrounded tab — would otherwise stretch the
  // five seconds, and the number would disagree with the bar the browser is
  // animating on its own clock.
  useEffect(() => {
    if (!blastMode) return undefined;
    const until = blastUntilRef.current || (Date.now() + BLAST_MS);
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) {
        blastModeRef.current = false;
        setBlastMode(false);
        energyRef.current = 0;
        setEnergy(0);
        setBlastSecondsLeft(0);
        return;
      }
      setBlastSecondsLeft(Math.ceil(left / 1000));
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, [blastMode]);

  // Persist game state to sessionStorage while playing so rejoin can restore it
  useEffect(() => {
    if ((phase !== 'active') || !roomId) return;
    try {
      sessionStorage.setItem('blockBlast_state', JSON.stringify({
        grid: gridRef.current, tray: trayRef.current, score: scoreRef.current,
      }));
    } catch {}
  }, [grid, score, phase, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? <DiamondIcon /> : <CoinIcon size="0.85em" />;
  const balance      = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && balance < entryFee;


  // ── Socket listeners ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    socket.on('block_blast_match_found', ({ roomId: rid, opponent: opp, vsBot, entryFee: fee, currency: cur }) => {
      eloBeforeRef.current = profileRef.current?.elo ?? null;
      gameOverRef.current = false; // reset for new match
      roomIdRef.current = rid;
      setOppScore(0);
      setRoomId(rid);
      setOpponent(opp);
      setIsSolo(!!vsBot);
      isSoloRef.current = !!vsBot;
      setPhase('countdown');
      setCountdown(3);
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

    socket.on('block_blast_countdown', ({ count }) => { setCountdown(count); if (count > 0) playCountdown(); });

    socket.on('block_blast_start', ({ seed }) => {
      if (gameOverRef.current) return; // opponent already left — don't overwrite result screen
      setPhase('active');
      initGame(seed);
    });

    socket.on('block_blast_result', (res) => {
      if (!roomIdRef.current) return; // stale event after leaving — ignore
      roomIdRef.current = null;
      gameOverRef.current = true; // mark game over so no further game events are processed
      setResult(res);
      setPhase('result');
      setGameOver(true);
      const myId = profileRef.current?.id;
      const isWin = res.winnerId === myId;
      const payout = res.balanceChange?.winnerPayout ?? res.winnerPayout;
      if (payout != null && isWin) {
        const isDiamonds = res.currency === 'diamonds';
        updateProfile(isDiamonds
          ? { diamonds: Math.max(0, (profileRef.current?.diamonds ?? 0) + payout) }
          : { c_coins: Math.max(0, (profileRef.current?.c_coins ?? 0) + payout) }
        );
      }
      refreshProfile();
    });

    socket.on('block_blast_player_stuck', ({ stuckUserId }) => {
      if (gameOverRef.current) return;
      if (stuckUserId !== profileRef.current?.id) setOppStuck(true);
    });

    socket.on('block_blast_keep_playing', ({ seconds }) => {
      if (gameOverRef.current) return;
      setKeepPlayingSeconds(seconds);
      if (keepPlayingTimerRef.current) clearInterval(keepPlayingTimerRef.current);
      keepPlayingTimerRef.current = setInterval(() => {
        setKeepPlayingSeconds(s => (s <= 1 ? 0 : s - 1));
      }, 1000);
      // When the catch-up time is up, submit our final score so the server
      // resolves the match INSTANTLY (both scores are now in) — no waiting on
      // the server's separate timer, which could drift a few seconds.
      if (keepPlayingEndRef.current) clearTimeout(keepPlayingEndRef.current);
      keepPlayingEndRef.current = setTimeout(() => {
        if (keepPlayingTimerRef.current) { clearInterval(keepPlayingTimerRef.current); keepPlayingTimerRef.current = null; }
        setKeepPlayingSeconds(0);
        const rid = roomIdRef.current;
        if (rid && socket && !gameOverRef.current) {
          socket.emit('block_blast_complete', { roomId: rid, score: scoreRef.current });
        }
      }, seconds * 1000);
    });

    socket.on('block_blast_opponent_score', ({ score: s }) => {
      if (gameOverRef.current) return;
      setOppScore(s);
    });

    socket.on('opponent_disconnected', (data = {}) => {
      if (!roomIdRef.current) return; // stale event after leaving — ignore
      roomIdRef.current = null;
      gameOverRef.current = true; // mark game over — blocks any in-flight game events
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
      setResult({
        winnerId:      data.winnerId || myId,
        loserId:       data.loserId,
        winnerUsername: isWin ? (profileRef.current?.username) : (data.winnerUsername),
        loserUsername:  isWin ? (data.loserUsername) : (profileRef.current?.username),
        disconnected:  true,
        balanceChange: (isWin && payout != null) ? { winnerPayout: payout } : (payout != null ? { winnerPayout: 0 } : undefined),
        entryFee:      data.entryFee,
        currency:      data.currency,
        newWinnerElo:  data.newWinnerElo,
        newLoserElo:   data.newLoserElo,
      });
      setGameOver(true);
      setPhase('result');
      refreshProfile();
    });

    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code); setInvitedFriend(null);
      setPhase('private_waiting');
    });
    socket.on('invite_sent', ({ friendUsername }) => { setPrivateCode(''); setInvitedFriend(friendUsername || 'your friend'); setStatusMsg(''); setPhase('private_waiting'); });
    socket.on('invite_declined', ({ byUsername }) => { setInvitedFriend(null); setStatusMsg(`${byUsername || 'They'} declined your invite.`); setPhase('lobby'); });
    socket.on('invite_expired', () => { setInvitedFriend(null); setStatusMsg('Invite expired — no response.'); setPhase('lobby'); });

    return () => {
      socket.emit('leave_game');
      socket.emit('leave_all_queues');
      socket.off('block_blast_match_found');
      socket.off('match_cancelled');
      socket.off('block_blast_countdown');
      socket.off('block_blast_start');
      socket.off('block_blast_result');
      socket.off('block_blast_player_stuck');
      socket.off('block_blast_keep_playing');
      socket.off('block_blast_opponent_score');
      socket.off('opponent_disconnected');
      socket.off('private_room_created');
      socket.off('invite_sent'); socket.off('invite_declined'); socket.off('invite_expired');
    };
  }, [socket]);

  function initGame(seed) {
    const rand = makePRNG(seed);
    randRef.current  = rand;
    const g = emptyGrid();
    const t = nextTray(rand, g);
    gridRef.current  = g;
    trayRef.current  = t;
    scoreRef.current = 0;
    stuckRef.current = false;
    setGrid(g);
    setTray(t);
    setScore(0);
    setGameOver(false);
    setStuck(false);
    setOppStuck(false);
    setDragging(null);
    setHover(null);
    setFlashCells(new Set());
    setScorePopups([]);
    hoverRef.current = null;

    // Reset energy & blast
    energyRef.current = 0;
    blastModeRef.current = false;
    setEnergy(0);
    setBlastMode(false);
    setBlastSecondsLeft(0);
    setKeepPlayingSeconds(0);
    if (blastTimerRef.current) { clearTimeout(blastTimerRef.current); blastTimerRef.current = null; }
    if (keepPlayingTimerRef.current) { clearInterval(keepPlayingTimerRef.current); keepPlayingTimerRef.current = null; }
    if (keepPlayingEndRef.current) { clearTimeout(keepPlayingEndRef.current); keepPlayingEndRef.current = null; }

    // No timer — play until stuck
  }

  // Called after every drop to check if stuck
  function _checkStuck(newGrid, newTray) {
    if (stuckRef.current) return; // already stuck
    if (blastModeRef.current) return; // in blast mode — don't trigger stuck check
    if (!checkIsStuck(newGrid, newTray)) return;

    stuckRef.current = true;
    setStuck(true);
    setGameOver(true);

    const rid = roomIdRef.current;
    if (!rid || !socket) return;

    if (isSoloRef.current) {
      // Solo endless: game over, submit final score
      socket.emit('block_blast_complete', { roomId: rid, score: scoreRef.current });
    } else {
      // PvP: freeze here, wait for opponent / timer
      socket.emit('block_blast_stuck', { roomId: rid, score: scoreRef.current });
    }
  }

  // ── Blast mode: click a cell to clear its row ─────────────────────────────

  function handleBlastClick(r) {
    if (!blastModeRef.current || gameOver) return;
    const g = gridRef.current.map(row => [...row]);
    let cleared = 0;
    for (let c = 0; c < GRID; c++) { if (g[r][c] !== null) { g[r][c] = null; cleared++; } }
    if (cleared === 0) return;
    playClear();

    // Everything lands NOW. The board, the score and the ping all used to sit
    // inside a 200ms setTimeout so the flash could play over the old cells,
    // and clicking faster than that lost rows:
    //
    //   click A  -> gridRef = gA, timer scheduled carrying gA and scoreA
    //   click B  -> reads scoreRef, which the timer has NOT written yet, so
    //               scoreB is computed from the score BEFORE A
    //   +200ms   -> timer A sets the board back to gA, undoing B on screen
    //   +300ms   -> timer B sets scoreB, and A's points are gone
    //
    // Two rows cleared, one row's points, and a board that flickered
    // backwards in between. Which is exactly "some of the rows I clicked
    // didn't register".
    //
    // The flash is a decoration and is the only thing that stays on a timer —
    // it is additive, so overlapping clicks light up more cells rather than
    // fighting over one value.
    const pts = cleared * 20;
    const newScore = scoreRef.current + pts;
    gridRef.current = g;
    setGrid(g);
    scoreRef.current = newScore;
    setScore(newScore);
    if (socket && roomIdRef.current) socket.emit('block_blast_score_ping', { roomId: roomIdRef.current, score: newScore });

    const flashed = [];
    for (let c = 0; c < GRID; c++) flashed.push(`${r},${c}`);
    setFlashCells(prev => {
      const next = new Set(prev);
      for (const k of flashed) next.add(k);
      return next;
    });
    setTimeout(() => {
      setFlashCells(prev => {
        const next = new Set(prev);
        for (const k of flashed) next.delete(k);
        return next;
      });
    }, 200);

    if (pts > 0) {
      const id = ++popupIdRef.current;
      setScorePopups(p => [...p, { id, text: `⚡ +${pts}` }]);
      setTimeout(() => setScorePopups(p => p.filter(x => x.id !== id)), 1200);
    }
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  function handleDrop(idx, r, c) {
    if (gameOver) return;
    const piece = trayRef.current[idx];
    if (!piece || !canPlace(gridRef.current, piece, r, c)) return;

    const placed = place(gridRef.current, piece, r, c);
    const { grid: cleared, cleared: numCleared, fullRows, fullCols, chain } = clearLines(placed);

    playPlace();
    if (numCleared > 0) playClear();

    const pts = scoreForClear(numCleared, piece.cells.length, chain);
    const newScore = scoreRef.current + pts;

    // Update energy bar
    const energyGain = piece.cells.length * 1 + numCleared * 5;
    const newEnergy = energyRef.current + energyGain;
    energyRef.current = newEnergy >= 100 ? 0 : newEnergy;
    setEnergy(energyRef.current);
    if (newEnergy >= 100 && !blastModeRef.current) {
      blastModeRef.current = true;
      blastUntilRef.current = Date.now() + BLAST_MS;
      setBlastMode(true);
      playBlast();
      setBlastSecondsLeft(Math.round(BLAST_MS / 1000));
      // The bar starts full and the drain effect above takes it down; the
      // timeout stays as a backstop in case that effect never mounts.
      setEnergy(100);
      if (blastTimerRef.current) clearTimeout(blastTimerRef.current);
      blastTimerRef.current = setTimeout(() => {
        blastModeRef.current = false;
        setBlastMode(false);
        setBlastSecondsLeft(0);
        energyRef.current = 0;
        setEnergy(0);
      }, BLAST_MS);
    }

    const newTray = [...trayRef.current];
    newTray[idx] = null;
    if (newTray.every(p => p === null)) {
      const refilled = nextTray(randRef.current, cleared);
      newTray[0] = refilled[0]; newTray[1] = refilled[1]; newTray[2] = refilled[2];
    }
    trayRef.current = newTray;
    setTray([...newTray]);

    if (numCleared > 0) {
      gridRef.current = placed;
      setGrid(placed);

      const cells = new Set();
      for (const fr of fullRows) for (let cc = 0; cc < GRID; cc++) cells.add(`${fr},${cc}`);
      for (const fc of fullCols) for (let rr = 0; rr < GRID; rr++) cells.add(`${rr},${fc}`);
      setFlashCells(cells);

      setTimeout(() => {
        gridRef.current = cleared;
        scoreRef.current = newScore;
        setGrid(cleared);
        setScore(newScore);
        if (socket && roomIdRef.current) socket.emit('block_blast_score_ping', { roomId: roomIdRef.current, score: newScore });
        setFlashCells(new Set());
        if (pts > 0) {
          const id = ++popupIdRef.current;
          const chainText = chain > 1 ? ` 🔥×${chain}` : '';
          setScorePopups(p => [...p, { id, text: `+${pts}${chainText}` }]);
          setTimeout(() => setScorePopups(p => p.filter(x => x.id !== id)), 1200);
        }
        _checkStuck(cleared, trayRef.current);
      }, 240);
    } else {
      gridRef.current = cleared;
      scoreRef.current = newScore;
      setGrid(cleared);
      setScore(newScore);
      if (socket && roomIdRef.current) socket.emit('block_blast_score_ping', { roomId: roomIdRef.current, score: newScore });
      _checkStuck(cleared, trayRef.current);
    }
  }

  useEffect(() => {
    if (!dragging) return;

    function calcHoverFromPoint(clientX, clientY) {
      if (!gridContainerRef.current) return;
      const rect = gridContainerRef.current.getBoundingClientRect();
      const TOTAL = CELL_PX + CELL_GAP;
      const PAD = 8; // p-2 = 8px
      const relX = clientX - rect.left - PAD;
      const relY = clientY - rect.top - PAD;
      // Math.round gives ~50% threshold: snap when past center of each cell unit
      const gridC = Math.round(relX / TOTAL);
      const gridR = Math.round(relY / TOTAL);
      const adjR = gridR - grabOffsetRef.current.halfRows;
      const adjC = gridC - grabOffsetRef.current.halfCols;
      if (hoverRef.current?.r !== adjR || hoverRef.current?.c !== adjC) {
        setHover({ r: adjR, c: adjC });
        hoverRef.current = { r: adjR, c: adjC };
      }
    }

    function onMove(e) {
      setCursorPos({ x: e.clientX, y: e.clientY });
      calcHoverFromPoint(e.clientX, e.clientY);
    }
    function onUp() {
      const h = hoverRef.current;
      if (h) handleDrop(dragging.idx, h.r, h.c);
      setDragging(null);
      setHover(null);
      hoverRef.current = null;
    }
    function onTouchMove(e) {
      e.preventDefault();
      const touch = e.touches[0];
      const touchOffsetY = 70; // lift piece above finger on touch screens
      setCursorPos({ x: touch.clientX, y: touch.clientY - touchOffsetY });
      calcHoverFromPoint(touch.clientX, touch.clientY - touchOffsetY);
    }
    function onTouchEnd() { onUp(); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  const activePiece  = dragging ? trayRef.current[dragging.idx] : null;
  const previewCells = hover && activePiece
    ? activePiece.cells.map(([dr, dc]) => [hover.r + dr, hover.c + dc])
        .filter(([r, c]) => r >= 0 && r < GRID && c >= 0 && c < GRID)
    : [];
  const canDrop = hover && activePiece ? canPlace(gridRef.current, activePiece, hover.r, hover.c) : false;
  const CELL_GAP = 2;

  // ── Actions ───────────────────────────────────────────────────────────────

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_block_blast_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_block_blast_vs_bot', { entryFee, currency: betCurrency });
    // Straight to the countdown. A bot match has nothing to wait for — the
    // room is created on the server the moment this reaches it — so the queue
    // screen appeared for one frame and then vanished, which reads as a
    // flicker rather than as a step. match_found sets the same phase and the
    // real count a moment later; this only decides what is on screen in
    // between.
    setCountdown(3); setPhase('countdown'); setStatusMsg('');
  }
  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_block_blast_vs_bot', { entryFee: 0, currency: 'coins' });
    setCountdown(3); setPhase('countdown'); setStatusMsg('');
  }
  function leaveQueue() {
    socket.emit('leave_block_blast_queue'); setPhase('lobby'); setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'blockBlast', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'blockBlast', code });
    setPhase('queue'); setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setInvitedFriend(null); setStatusMsg('');
  }
  function requestRematch() {
    socket.emit('block_blast_rematch_request', { roomId });
    setResult(null); setPhase('countdown'); setGameOver(false);
    setStuck(false); setOppStuck(false);
    setStatusMsg('Waiting for opponent...');
  }
  // Clears the finished match without choosing a phase, so callers decide where
  // the player lands.
  function clearMatch() {
    setResult(null);
    setOpponent(null); setRoomId(null); setGameOver(false);
    setStuck(false); setOppStuck(false); setStatusMsg('');
  }

  function backToLobby() { clearMatch(); setPhase('lobby'); }

  // Play Again used to call joinQueue/playVsBot directly, which left result,
  // gameOver and stuck set from the run that just ended — so the next match
  // started against state that already said it was over.
  function playAgain(start) { clearMatch(); start(); }

  const isWinner = result && result.winnerId === profile?.id;
  const CELL_PX  = cellPx;

  // These hooks must be declared before any early return (Rules of Hooks)
  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-join a private room from an accepted friend invite.
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

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-bg flex flex-col items-center justify-center px-3 sm:px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>

      {/* ── RESULT ── */}
      {/* Result screens sit BELOW the navbar, like every other game's. These were
          `fixed inset-0 z-50`, which covered the top bar so the player could not
          see their balance or navigate away from the result. */}
      {phase === 'result' && result && !result.isSolo && (
        <div className="min-h-[calc(100dvh-3.5rem)] bg-bg flex items-center justify-center overflow-y-auto py-2 w-full">
          <ResultScreen
            vsBot={!!result.vsBot}
            opponent={opponent}
            isWinner={isWinner}
            isDraw={result.draw}
            winnerUsername={result.winnerUsername}
            loserUsername={result.loserUsername}
            newWinnerElo={result.newWinnerElo}
            newLoserElo={result.newLoserElo}
            winnerBefore={result.winnerBefore}
            loserBefore={result.loserBefore}
            eloBeforeRef={eloBeforeRef}
            balanceChange={result.balanceChange}
            currency={result.currency || betCurrency}
            entryFee={result.entryFee ?? entryFee}
            disconnected={result.disconnected}
            winnerStreak={result.winnerStreak}
            isFirstWin={result.isFirstWin}
            profile={profile}
            gameLabel="Block Burst"
            extraRows={[{
              label: 'Score',
              value: `${(isWinner ? (result.winnerScore ?? 0) : (result.loserScore ?? 0)).toLocaleString()} — ${(isWinner ? (result.loserScore ?? 0) : (result.winnerScore ?? 0)).toLocaleString()}`,
            }]}
            isPrivate={privateRematch.isPrivate}
            rematchState={privateRematch.rematchState}
            onPrivateRematch={privateRematch.requestRematch}
            onPlayAgain={() => playAgain(joinQueue)}
            onBackToLobby={backToLobby}
          />
        </div>
      )}
      {phase === 'result' && result && result.isSolo && result.humanWon !== null && (
        <div className="min-h-[calc(100dvh-3.5rem)] bg-bg flex items-center justify-center overflow-y-auto py-2 w-full">
          <ResultScreen
            opponent={opponent}
            // Solo means a bot opponent, so no streak was ever at stake.
            vsBot
            isWinner={result.humanWon}
            // A free run has no opponent worth naming and nothing at stake, so
            // it drops the "you vs bot" framing; a paid bot match keeps it.
            solo={!(result.entryFee > 0)}
            winnerUsername={result.humanWon ? profile?.username : 'Duely Bot'}
            loserUsername={result.humanWon ? 'Duely Bot' : profile?.username}
            newWinnerElo={result.humanWon ? result.newElo : undefined}
            newLoserElo={result.humanWon ? undefined : result.newElo}
            winnerBefore={result.humanWon ? result.eloBefore : undefined}
            loserBefore={result.humanWon ? undefined : result.eloBefore}
            eloBeforeRef={eloBeforeRef}
            balanceChange={result.balanceChange}
            currency={result.currency || betCurrency}
            entryFee={result.entryFee ?? entryFee}
            profile={profile}
            gameLabel="Block Burst"
            extraRows={[
              { label: 'Your Score', value: (result.playerScore ?? 0).toLocaleString() },
              { label: 'Bot Score', value: (result.botScore ?? 0).toLocaleString() },
            ]}
            isPrivate={privateRematch.isPrivate}
            rematchState={privateRematch.rematchState}
            onPrivateRematch={privateRematch.requestRematch}
            onPlayAgain={() => playAgain(playVsBot)}
            onBackToLobby={backToLobby}
          />
        </div>
      )}
      {phase === 'result' && result && result.isSolo && result.humanWon === null && (
        <div className="min-h-[calc(100dvh-3.5rem)] bg-bg flex items-center justify-center overflow-y-auto py-2 w-full">
          <ResultScreen
            opponent={opponent}
            solo
            isWinner
            winnerUsername={profile?.username ?? 'You'}
            profile={profile}
            gameLabel="Block Burst"
            extraRows={[
              { label: 'Final Score', value: (result.playerScore ?? 0).toLocaleString() },
            ]}
            isPrivate={privateRematch.isPrivate}
            rematchState={privateRematch.rematchState}
            onPrivateRematch={privateRematch.requestRematch}
            onPlayAgain={() => playAgain(playVsBotFree)}
            onBackToLobby={backToLobby}
          />
        </div>
      )}

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="Block Burst"
          description="Drag blocks onto the grid to fill rows and columns and clear them for points. Fill the energy bar to unlock Blast Mode — tap any row to clear it instantly."
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={balance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          botLabel="Solo Endless"
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
          gameType="block-blast"
          liveCount={playerCounts?.['block-blast'] ?? 0}
        />
      )}

      {/* ── PRIVATE WAITING ── */}
      {phase === 'private_waiting' && (
        <PrivateWaiting
          inline
          invitedFriend={invitedFriend}
          code={privateCode}
          gameType="blockBlast"
          onCancel={cancelPrivate}
        />
      )}

      {/* ── QUEUE ── */}
      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-6">Searching...</h2>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* ── COUNTDOWN ── */}
      {phase === 'countdown' && (
        <div className="text-center animate-fade-in">
          {countdown > 0 ? (
            <>
              <div className="text-8xl font-black text-primary mb-4" style={{ textShadow: '0 0 40px #1250B4' }}>
                {countdown}
              </div>
              <p className="text-muted">Get ready...</p>
              {!isSolo && opponent && <p className="text-xs text-muted mt-2 flex items-center justify-center gap-1.5">
                  vs <PlayerName username={opponent.username} avatarUrl={opponent.avatarUrl}
                       color={opponent.profileColor} isBot={!!opponent.isBot} size="w-5 h-5" />
                </p>}
              {/* Solo Endless has no opponent — naming the bot invents one. */}
              {/* The bot gets the same treatment as a player: its name is next to
                  its face, not on its own as bare text. */}
              {isSolo && entryFee > 0 && (
                <p className="text-xs text-muted mt-2 flex items-center justify-center gap-1.5">
                  vs <PlayerName username="Duely Bot" isBot size="w-5 h-5" />
                </p>
              )}
            </>
          ) : (
            <>
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-muted">Starting...</p>
            </>
          )}
        </div>
      )}

      {/* ── GAME ── */}
      {phase === 'active' && (
        <div className="relative flex flex-col items-center gap-4 animate-fade-in w-full" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}>
          <style>{`
            /* No transform in here any more.
               A CSS animation overrides an inline transform outright, so this
               was quietly cancelling the bar's own translate — and a scale
               pulsing twice a second on the element that is supposed to be
               sliding smoothly is its own source of judder. Brightness and
               glow say "powered up" without moving anything. */
            @keyframes powerUpPulse {
              0%, 100% { filter: brightness(1);    box-shadow: 0 0 6px rgba(0,204,255,0.55); }
              50%      { filter: brightness(1.35); box-shadow: 0 0 16px rgba(0,204,255,0.95); }
            }
          `}</style>
          {/*
            Blast Mode and line clears used amber (#facc15/#f97316), which washed
            the whole board warm — it read as the screen going red. Both are the
            site blue now. BLAST is the bright cyan end so it still separates
            clearly from the filling bar, which runs deep blue → cyan.
          */}
          {/* HUD */}
          {/* The help button sits IN this row, not floating over it. Floated at
              top-right it landed squarely on the opponent's score. */}
          {/* px-12, not pl-12. The help button is absolute at left-3 with w-9, so
            it occupies 12px to 48px — and the row reserved exactly 48px on
            the left and nothing on the right. Two consequences, both
            reported: the centre column is centred inside a row that is 48px
            narrower on one side, so the mode label sits 24px right of true
            centre; and the guess count starts at exactly 48px, flush against
            the button with no clearance, which is where the avatar met the
            "?". Padding both sides equally re-centres the middle column, and
            14 rather than 12 puts 8px between the button and the column. */}
        {/* The mode label is its own line, above the scores.
            It used to sit in the middle column of this row, between the two
            score readouts — and that column is whatever is left after both
            scores and 56px of padding on each side. Measured at 360px it was
            81px against a 95px label, and once the scores reach six figures it
            collapses to 20px, where even "vs Bot" does not fit. There is no
            font size that survives that, because the space depends on the
            score. On its own line it has the full width at every size.

            Three modes, not two. isSolo means "vs the bot" and is true for a
            STAKED bot match as much as a free one — so betting diamonds
            against the bot read as "Solo Endless", which is neither solo nor
            endless. The stake separates them. A disguised demo opponent is
            free and vs a bot too and must keep looking like an ordinary
            match, which is what opponent.isBot settles. */}
        <div className="text-center w-full max-w-lg px-4 -mb-1">
          {isSolo && entryFee > 0 ? (
            <span className="text-xs sm:text-sm text-muted">vs <span className="text-accent font-semibold">Bot</span></span>
          ) : isSolo && opponent?.isBot ? (
            <span className="text-xs sm:text-sm text-muted">Solo <span className="text-accent font-semibold">Endless</span></span>
          ) : (
            <span className="text-sm sm:text-base font-black text-accent">Score Race</span>
          )}
          {oppStuck && !isSolo && <span className="text-xs text-warning font-bold ml-2">Opp stuck</span>}
        </div>

        <div className="relative flex items-center justify-between w-full max-w-lg gap-2 px-14">
            <GameHelp gameType="blockBlast" placement="top-left" />
            {/* My score */}
            <div className="text-center min-w-[72px]">
              <div className="text-xl font-black font-mono text-success">{score.toLocaleString()}</div>
              <div className="text-[0.625rem] text-muted flex items-center justify-center">
                <PlayerName username={profile?.username ?? 'You'} avatarUrl={profile?.avatar_url}
                  color={profile?.profile_color} size="w-4 h-4" />
              </div>
            </div>

            {/* Nothing in the middle any more — see the mode line above the
                row. This keeps the space between the two scores and nothing
                else, so neither score can be squeezed by a label. */}
            <div className="flex-1 min-w-0" />

            {/* Opponent score */}
            <div className="text-center min-w-[72px]">
              <div className={`text-xl font-black font-mono ${oppScore > score ? 'text-danger' : oppScore < score ? 'text-success' : 'text-accent'}`}>
                {oppScore.toLocaleString()}
              </div>
              <div className="text-[0.625rem] text-muted flex items-center justify-center">
                {/* isSolo here means "against the bot" — the bot is a real
                    opponent in this game and has a score, so it gets a face
                    like anyone else. */}
                <PlayerName
                  username={isSolo ? 'Duely Bot' : (opponent?.username ?? 'Opponent')}
                  avatarUrl={isSolo ? null : opponent?.avatarUrl}
                  color={isSolo ? null : opponent?.profileColor}
                  // Not isSolo: a demo match is solo AND disguised, and the
                  // mode does not know which. Only the opponent does.
                  isBot={!!opponent?.isBot}
                  size="w-4 h-4" />
              </div>
            </div>
          </div>

          {/* Status banners */}
          {stuck && isSolo && (
            <div className="px-4 py-2 bg-danger/10 border border-danger/30 rounded-xl text-danger font-bold text-sm">
              No more moves! Calculating score...
            </div>
          )}
          {stuck && !isSolo && (
            <div className="px-4 py-2 bg-warning/10 border border-warning/30 rounded-xl text-warning font-bold text-sm animate-pulse">
              No more moves — waiting for opponent...
            </div>
          )}
          {keepPlayingSeconds > 0 && !stuck && (
            <div className="px-4 py-2 bg-primary/10 border border-primary/40 rounded-xl text-primary font-bold text-sm animate-pulse">
              ⚡ Opponent stuck! Keep playing — {keepPlayingSeconds}s left!
            </div>
          )}
          {!isSolo && gameOver && !stuck && (
            <div className="text-warning font-bold text-sm animate-pulse">
              Waiting for results...
            </div>
          )}

          {/* Energy bar */}
          <div className="w-full max-w-lg px-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold" style={{ color: blastMode ? '#00ccff' : '#888' }}>
                {blastMode ? `⚡ BLAST MODE — ${blastSecondsLeft}s` : '⚡ Energy'}
              </span>
              {!blastMode && <span className="text-xs text-muted">{Math.round(energy)}/100</span>}
            </div>
            {/* The pulse lives on the track, not on the fill — see the
                keyframes above for why the fill cannot carry an animation. */}
            <div
              className="w-full h-3 bg-surface border border-border rounded-full overflow-hidden"
              style={{ animation: blastMode ? 'powerUpPulse 0.5s ease-in-out infinite' : undefined }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  // The fill is always full width and SLIDES, rather than
                  // being resized.
                  //
                  // width is a layout property, so animating it reflows and
                  // repaints every frame on the same main thread that is
                  // running the game; a transform can be composited instead.
                  // That is the standard reason to prefer it, though it is
                  // NOT the measured cause of the judder here — see the
                  // keyframes above, which were cancelling the fill's
                  // transform outright and pulsing it twice a second besides.
                  //
                  // translateX rather than scaleX because scaling squashes the
                  // rounded ends and the gradient with them; sliding under the
                  // track's overflow keeps the geometry exactly right.
                  width: '100%',
                  transform: blastMode
                    ? (blastDraining ? 'translateX(-100%)' : 'translateX(0%)')
                    : `translateX(-${100 - Math.max(0, Math.min(100, energy))}%)`,
                  // linear, because it is a clock. An ease would spend longer
                  // near the ends and read as the timer slowing down.
                  transition: blastMode
                    ? `transform ${BLAST_MS}ms linear`
                    : 'transform 200ms ease, background 200ms ease',
                  // Promotes the fill to its own layer up front, so the first
                  // frame of the drain is not the one that pays for it.
                  willChange: 'transform',
                  background: blastMode
                    ? 'linear-gradient(90deg, #00ccff, #7dd3fc)'
                    : 'linear-gradient(90deg, #1250B4, #00ccff)',
                }}
              />
            </div>
            {blastMode && <p className="text-xs text-center mt-1 font-bold animate-pulse" style={{ color: '#00ccff' }}>Click any row to clear it!</p>}
          </div>

          {/* Grid */}
          <div
            ref={gridContainerRef}
            className="inline-grid gap-0.5 p-2 bg-surface border border-surfaceLight rounded-xl select-none"
            style={{ gridTemplateColumns: `repeat(${GRID}, ${CELL_PX}px)`, touchAction: 'none' }}
            onMouseLeave={() => { setHover(null); hoverRef.current = null; }}
          >
            {grid.map((row, r) =>
              row.map((cell, c) => {
                const isFlash   = flashCells.has(`${r},${c}`);
                const isPreview = !isFlash && previewCells.some(([pr, pc]) => pr === r && pc === c);
                const isBlastRow = blastMode && !isFlash;
                return (
                  <div
                    key={`${r}-${c}`}
                    data-r={r}
                    data-c={c}
                    // pointerdown, not click. A click waits for the release
                    // and only counts if press and release land on the SAME
                    // cell — tap fast on a 3px-gapped grid and a finger that
                    // slides one cell between the two produces no click at
                    // all. pointerdown fires on contact, for mouse and touch
                    // alike, so every tap that reaches a cell registers.
                    onPointerDown={() => blastMode && handleBlastClick(r)}
                    style={{
                      width: CELL_PX, height: CELL_PX,
                      borderRadius: 6,
                      cursor: blastMode ? 'crosshair' : dragging ? (canDrop ? 'copy' : 'no-drop') : 'default',
                      background: isFlash
                        ? 'radial-gradient(circle at 40% 30%, #ffffff, #00ccff)'
                        : cell
                          ? `linear-gradient(135deg, ${cell}ff 0%, ${cell}cc 100%)`
                          : isPreview
                            ? (canDrop ? (activePiece?.color + 'aa') : '#ff444466')
                            : isBlastRow
                              ? 'linear-gradient(135deg, #001426 0%, #000a14 100%)'
                              : 'linear-gradient(135deg, #111827 0%, #0d1420 100%)',
                      border: isFlash
                        ? '2px solid #00ccff'
                        : cell
                          ? `1px solid ${cell}88`
                          : isPreview
                            ? (canDrop ? `1px solid ${activePiece?.color}` : '1px solid #ff4444')
                            : isBlastRow
                              ? '1px solid rgba(0,204,255,0.15)'
                              : '1px solid rgba(255,255,255,0.07)',
                      boxShadow: isFlash
                        ? `0 0 28px #00ccff, 0 0 56px #00ccff66`
                        : cell
                          ? `0 0 12px ${cell}cc, 0 0 24px ${cell}55, inset 0 1px 0 rgba(255,255,255,0.15)`
                          : isBlastRow
                            ? '0 0 4px rgba(0,204,255,0.1)'
                            : 'none',
                      transition: isFlash ? 'none' : 'background 0.08s, box-shadow 0.12s',
                      position: 'relative', overflow: 'hidden',
                    }}
                  />
                );
              })
            )}
          </div>

          {/* Tray — 3 draggable piece cards */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', touchAction: 'none' }} className="select-none">
            {tray.map((piece, idx) => {
              if (!piece) return (
                <div key={idx} className="rounded-2xl border-2 border-dashed border-border/30 opacity-20" style={{ width: traySlot, height: traySlot }} />
              );
              const dim = pieceMaxDim(piece);
              const miniCell = Math.min(Math.round(26 * cellPx / 60), Math.floor((traySlot - 16) / Math.max(dim.rows, dim.cols)));
              const isDraggingThis = dragging?.idx === idx;
              return (
                <div
                  key={idx}
                  onMouseDown={(e) => {
                    if (gameOver || blastMode) return;
                    e.preventDefault();
                    const p = trayRef.current[idx];
                    if (!p) return;
                    const d = pieceMaxDim(p);
                    const halfRows = Math.floor(d.rows / 2);
                    const halfCols = Math.floor(d.cols / 2);
                    grabOffsetRef.current = {
                      x: halfCols * (CELL_PX + CELL_GAP), y: halfRows * (CELL_PX + CELL_GAP),
                      halfRows, halfCols,
                    };
                    setCursorPos({ x: e.clientX, y: e.clientY });
                    setDragging({ idx });
                  }}
                  onTouchStart={(e) => {
                    if (gameOver || blastMode) return;
                    e.preventDefault();
                    const p = trayRef.current[idx];
                    if (!p) return;
                    const d = pieceMaxDim(p);
                    const halfRows = Math.floor(d.rows / 2);
                    const halfCols = Math.floor(d.cols / 2);
                    grabOffsetRef.current = {
                      x: halfCols * (CELL_PX + CELL_GAP), y: halfRows * (CELL_PX + CELL_GAP),
                      halfRows, halfCols,
                    };
                    const touch = e.touches[0];
                    setCursorPos({ x: touch.clientX, y: touch.clientY - 70 });
                    setDragging({ idx });
                  }}
                  className={`p-3 rounded-2xl border-2 transition-all duration-150 ${
                    isDraggingThis
                      ? 'border-primary shadow-glow bg-primary/10 opacity-50'
                      : gameOver || blastMode
                        ? 'border-surfaceLight opacity-40 cursor-not-allowed'
                        : 'border-surfaceLight hover:border-primary/60 hover:shadow-glow bg-surface cursor-grab active:cursor-grabbing active:scale-95'
                  }`}
                  style={{ width: traySlot, height: traySlot, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
                >
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${dim.cols}, ${miniCell}px)`,
                    gridTemplateRows: `repeat(${dim.rows}, ${miniCell}px)`,
                    gap: 1,
                  }}>
                    {Array.from({ length: dim.rows }).map((_, r) =>
                      Array.from({ length: dim.cols }).map((_, c) => {
                        const filled = piece.cells.some(([dr, dc]) => dr === r && dc === c);
                        return (
                          <div key={`${r}-${c}`} style={{
                            width: miniCell, height: miniCell,
                            background: filled
                              ? `linear-gradient(135deg, ${piece.color} 0%, ${piece.color}bb 100%)`
                              : 'transparent',
                            borderRadius: 3, opacity: filled ? 1 : 0,
                            boxShadow: filled ? `inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 4px ${piece.color}88` : 'none',
                          }} />
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!stuck && !blastMode && <p className="text-muted text-xs">Drag a piece from the tray and drop it onto the grid</p>}

          {/* Score popups */}
          {scorePopups.map(p => (
            <div key={p.id} style={{
              position: 'fixed', top: '18%', left: '50%',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none', zIndex: 9999,
              animation: 'floatUp 1s ease-out forwards',
              fontSize: 28, fontWeight: 900, color: '#00ccff',
              textShadow: '0 0 16px #00ccff, 0 2px 4px #000',
            }}>{p.text}</div>
          ))}

          {/* Ghost piece */}
          {dragging && activePiece && (() => {
            const dim = pieceMaxDim(activePiece);
            return (
              <div style={{
                position: 'fixed', left: cursorPos.x, top: cursorPos.y,
                transform: `translate(${-grabOffsetRef.current.x}px, ${-grabOffsetRef.current.y}px)`,
                pointerEvents: 'none', zIndex: 9999, opacity: 0.9,
              }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${dim.cols}, ${CELL_PX}px)`,
                  gridTemplateRows: `repeat(${dim.rows}, ${CELL_PX}px)`,
                  gap: 2,
                }}>
                  {Array.from({ length: dim.rows }).map((_, r) =>
                    Array.from({ length: dim.cols }).map((_, c) => {
                      const filled = activePiece.cells.some(([dr, dc]) => dr === r && dc === c);
                      return (
                        <div key={`${r}-${c}`} style={{
                          width: CELL_PX, height: CELL_PX,
                          background: filled ? `linear-gradient(135deg, ${activePiece.color} 0%, ${activePiece.color}bb 100%)` : 'transparent',
                          borderRadius: 6,
                          boxShadow: filled ? `inset 0 1px 0 rgba(255,255,255,0.3), 0 0 14px ${activePiece.color}cc` : 'none',
                          opacity: filled ? 1 : 0,
                        }} />
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}

    </div>
  );
}



