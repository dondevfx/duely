import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';

const GRID     = 16;
const CELL     = 44;
const TICK_MS  = 150;
const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

const KEY_DIR = {
  ArrowUp:    { x: 0, y: -1 },
  ArrowDown:  { x: 0, y:  1 },
  ArrowLeft:  { x: -1, y: 0 },
  ArrowRight: { x:  1, y: 0 },
  w: { x: 0, y: -1 }, W: { x: 0, y: -1 },
  s: { x: 0, y:  1 }, S: { x: 0, y:  1 },
  a: { x: -1, y: 0 }, A: { x: -1, y: 0 },
  d: { x:  1, y: 0 }, D: { x:  1, y: 0 },
};

function randomApple(snake) {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
  } while (snake.some(s => s.x === pos.x && s.y === pos.y));
  return pos;
}

function nextAppleType() {
  const roll = Math.random();
  if (roll < 0.65) return 'normal';    // 65% — red, +1pt
  if (roll < 0.77) return 'phase';     // 12% — cyan, phase through body 15s
  if (roll < 0.89) return 'double';    // 12% — gold star, 2× score 15s
  return 'cluster';                     // 11% — green sparkle, 5 apples spawn at once
}

export default function SnakeGame() {
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
  const [myScore, setMyScore]       = useState(0);
  const [oppScore, setOppScore]     = useState(0);
  const [roundScore, setRoundScore] = useState({ me: 0, opp: 0 });
  const [currentRound, setCurrentRound] = useState(1);
  const [roundResult, setRoundResult] = useState(null);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [isSolo, setIsSolo]         = useState(false);
  const [reconnecting, setReconnecting] = useState(null); // seconds remaining in rejoin window
  const isSoloRef = useRef(false);

  const [botScore, setBotScore] = useState(0);

  const canvasRef    = useRef(null);
  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const phaseRef     = useRef(phase);
  const eloBeforeRef = useRef(null);
  const snakeRef     = useRef([]);
  const prevSnakeRef = useRef([]);
  const tickTimeRef  = useRef(0);
  const dirRef       = useRef({ x: 1, y: 0 });
  const nextDirRef   = useRef({ x: 1, y: 0 });
  const appleRef     = useRef({ x: 10, y: 10, type: 'normal' });
  const scoreRef     = useRef(0);
  const botScoreRef  = useRef(0);
  const deadRef      = useRef(false);
  const tickRef      = useRef(null);
  const botTickRef   = useRef(null);
  const rafRef       = useRef(null);
  const entryFeeRef  = useRef(entryFee);
  entryFeeRef.current = entryFee;

  // Power-up refs
  const activePowerUpRef  = useRef(null); // null | { type: 'phase'|'double'|'cluster', endsAt: number }
  const clusterApplesRef  = useRef([]);

  roomIdRef.current   = roomId;
  profileRef.current  = profile;
  phaseRef.current    = phase;
  isSoloRef.current   = isSolo;

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? '💎' : '🪙';
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;
  const isWinner     = result && result.winnerId === profile?.id;

  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  const { RejoinOverlay } = useGamePageRejoin('snake', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('game'); },
    () => setPhase('lobby'),
  );

  // Key direction handler
  useEffect(() => {
    function onKey(e) {
      if (phaseRef.current !== 'game') return;
      const d = KEY_DIR[e.key];
      if (!d) return;
      e.preventDefault();
      const cur = dirRef.current;
      if (d.x === -cur.x && d.y === -cur.y) return; // prevent 180—
      nextDirRef.current = d;
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function startGame() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Reset power-up refs
    activePowerUpRef.current = null;
    clusterApplesRef.current = [];

    const initSnake = [{ x: 5, y: 8 }, { x: 4, y: 8 }, { x: 3, y: 8 }];
    snakeRef.current     = initSnake;
    prevSnakeRef.current = initSnake.map(s => ({ ...s }));
    tickTimeRef.current  = performance.now();
    dirRef.current       = { x: 1, y: 0 };
    nextDirRef.current   = { x: 1, y: 0 };
    appleRef.current     = { ...randomApple(initSnake), type: nextAppleType() };
    scoreRef.current     = 0;
    botScoreRef.current  = 0;
    deadRef.current      = false;
    setMyScore(0);
    setBotScore(0);

    // Bot apple timer — active for all solo/bot games (free or wagered)
    if (isSoloRef.current) {
      const BOT_TARGET = Math.floor(Math.random() * 12) + 8; // 8-20 apples
      botTickRef.current = setInterval(() => {
        if (botScoreRef.current >= BOT_TARGET) { clearInterval(botTickRef.current); return; }
        botScoreRef.current++;
        setBotScore(botScoreRef.current);
      }, 3500 + Math.random() * 2000);
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    // Draw loop — 60fps with sub-tick interpolation for smooth movement
    function draw(now) {
      const ctx = canvas.getContext('2d');

      // Progress through current tick (0 = just ticked, 1 = next tick due)
      const t = Math.min(1, (now - tickTimeRef.current) / TICK_MS);

      // Draw grass checkerboard
      for (let row = 0; row < GRID; row++) {
        for (let col = 0; col < GRID; col++) {
          const isLight = (row + col) % 2 === 0;
          ctx.fillStyle = isLight ? '#2d5a27' : '#1f4019';
          ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
        }
      }

      // Subtle texture: tiny highlight on each tile (makes it look more like grass tiles)
      ctx.globalAlpha = 0.12;
      for (let row = 0; row < GRID; row++) {
        for (let col = 0; col < GRID; col++) {
          const isLight = (row + col) % 2 === 0;
          if (isLight) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(col * CELL + 1, row * CELL + 1, CELL - 2, 3);
          }
        }
      }
      ctx.globalAlpha = 1.0;

      // Apple
      const a = appleRef.current;
      const appleType = a.type || 'normal';
      const ax = a.x * CELL + CELL / 2;
      const ay = a.y * CELL + CELL / 2;
      const pulse = 0.5 + 0.5 * Math.sin(now / 280);

      if (appleType === 'phase') {
        // Phase apple — cyan glow circle with ⚡
        ctx.shadowColor = '#00eeff';
        ctx.shadowBlur = 6 + pulse * 10;
        ctx.fillStyle = '#00ccff';
        ctx.beginPath();
        ctx.arc(ax, ay, CELL / 2 - 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(CELL * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡', ax, ay);
        ctx.textBaseline = 'alphabetic';
      } else if (appleType === 'double') {
        // Double apple — gold glow with star
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 6 + pulse * 12;
        ctx.fillStyle = '#ffd700';
        ctx.beginPath();
        ctx.arc(ax, ay, CELL / 2 - 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#000';
        ctx.font = `bold ${Math.round(CELL * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⭐', ax, ay);
        ctx.textBaseline = 'alphabetic';
      } else if (appleType === 'cluster') {
        // Cluster apple — bright green with clover
        ctx.shadowColor = '#22c55e';
        ctx.shadowBlur = 6 + pulse * 10;
        ctx.fillStyle = '#4ade80';
        ctx.beginPath();
        ctx.arc(ax, ay, CELL / 2 - 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(CELL * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🍀', ax, ay);
        ctx.textBaseline = 'alphabetic';
      } else {
        // Normal red apple
        ctx.shadowColor = '#ff2222';
        ctx.shadowBlur = 4 + pulse * 8;
        ctx.fillStyle = '#e53e3e';
        ctx.beginPath();
        ctx.arc(ax, ay + 2, CELL / 2 - 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        // shine dot
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(ax - 3, ay - 2, 3, 0, Math.PI * 2);
        ctx.fill();
        // stem
        ctx.strokeStyle = '#5a3a1a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay - CELL / 2 + 6);
        ctx.lineTo(ax + 2, ay - CELL / 2 + 2);
        ctx.stroke();
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.ellipse(ax + 5, ay - CELL / 2 + 3, 5, 3, Math.PI / 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw cluster bonus apples (smaller red dots)
      for (const ca of clusterApplesRef.current) {
        const cx = ca.x * CELL + CELL / 2;
        const cy = ca.y * CELL + CELL / 2;
        ctx.fillStyle = '#e53e3e';
        ctx.shadowColor = '#ff2222';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(cx, cy, CELL / 2 - 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Snake — solid connected body via thick rounded path
      const snake = snakeRef.current;
      const prev  = prevSnakeRef.current;
      const bodyW = CELL - 4; // stroke width for the body

      // Build interpolated positions for every segment
      const pts = snake.map((cur, i) => {
        const p = prev[i] ?? prev[prev.length - 1] ?? cur;
        return {
          x: lerp(p.x, cur.x, t) * CELL + CELL / 2,
          y: lerp(p.y, cur.y, t) * CELL + CELL / 2,
        };
      });

      // Determine phase power-up state for transparency
      const pu = activePowerUpRef.current;
      const phasing = pu?.type === 'phase' && performance.now() < pu.endsAt;

      if (pts.length > 1) {
        ctx.globalAlpha = phasing ? 0.5 : 1.0;

        // Glow pass
        ctx.shadowColor = '#16a34a';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#16a34a';
        ctx.lineWidth = bodyW;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Highlight pass (lighter stripe)
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.25)';
        ctx.lineWidth = bodyW * 0.45;
        ctx.beginPath();
        ctx.moveTo(pts[0].x - 2, pts[0].y - 2);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - 2, pts[i].y - 2);
        ctx.stroke();

        // Head
        const hx = pts[0].x, hy = pts[0].y;
        ctx.fillStyle = '#15803d';
        ctx.shadowColor = '#15803d';
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.arc(hx, hy, bodyW / 2 + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Eyes
        const dir = dirRef.current;
        const ex = hx + dir.x * 5, ey = hy + dir.y * 5;
        const perpX = -dir.y, perpY = dir.x;
        [-1, 1].forEach(side => {
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(ex + perpX * 4 * side, ey + perpY * 4 * side, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#111';
          ctx.beginPath();
          ctx.arc(ex + perpX * 4 * side + dir.x, ey + perpY * 4 * side + dir.y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.globalAlpha = 1.0;
      }

      // Power-up active overlay
      const puNow = activePowerUpRef.current;
      if (puNow && performance.now() < puNow.endsAt) {
        const remaining = ((puNow.endsAt - performance.now()) / 1000).toFixed(1);
        const pct = Math.max(0, (puNow.endsAt - performance.now()) / 15000);
        const colors = { phase: '#00ccff', double: '#ffd700', cluster: '#4ade80' };
        const labels = { phase: '🌀 PHASE', double: '⭐ ×2 SCORE', cluster: '🍀 BONUS' };
        const c = colors[puNow.type];

        // Timer bar at top of canvas
        ctx.fillStyle = `${c}44`;
        ctx.fillRect(0, 0, GRID * CELL * pct, 5);

        // Text
        ctx.fillStyle = c;
        ctx.shadowColor = c;
        ctx.shadowBlur = 10;
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${labels[puNow.type]}  ${remaining}s`, (GRID * CELL) / 2, 22);
        ctx.shadowBlur = 0;
      } else if (puNow) {
        activePowerUpRef.current = null;
      }

      rafRef.current = requestAnimationFrame(draw);
    }
    rafRef.current = requestAnimationFrame(draw);

    // Movement tick — named function kept for clarity
    function moveTick() {
      if (phaseRef.current !== 'game' || deadRef.current) return;

      // Snapshot positions BEFORE moving so the renderer can lerp from here
      prevSnakeRef.current = snakeRef.current.map(s => ({ ...s }));
      tickTimeRef.current  = performance.now();

      dirRef.current = nextDirRef.current;
      const snake = snakeRef.current;
      const head = snake[0];
      const newHead = { x: head.x + dirRef.current.x, y: head.y + dirRef.current.y };

      // Wall collision
      if (newHead.x < 0 || newHead.x >= GRID || newHead.y < 0 || newHead.y >= GRID) {
        return doDie();
      }

      // Self collision — skip if phasing
      const puCheck = activePowerUpRef.current;
      const phasing = puCheck?.type === 'phase' && performance.now() < puCheck.endsAt;
      if (!phasing && snake.some(s => s.x === newHead.x && s.y === newHead.y)) {
        return doDie();
      }

      const apple = appleRef.current;
      const ate = newHead.x === apple.x && newHead.y === apple.y;
      const newSnake = [newHead, ...snake];
      if (!ate) {
        newSnake.pop();
      } else {
        const appleType = appleRef.current.type || 'normal';

        // Score — double points if double power-up active
        const puActive = activePowerUpRef.current;
        if (appleType === 'double' || (puActive?.type === 'double' && performance.now() < puActive.endsAt)) {
          scoreRef.current += 2;
        } else {
          scoreRef.current += 1;
        }
        setMyScore(scoreRef.current);

        // Activate power-up
        if (appleType === 'phase') {
          activePowerUpRef.current = { type: 'phase', endsAt: performance.now() + 15000 };
        } else if (appleType === 'double') {
          activePowerUpRef.current = { type: 'double', endsAt: performance.now() + 15000 };
        } else if (appleType === 'cluster') {
          // Spawn 4 bonus apples on the board
          const bonusApples = [];
          for (let i = 0; i < 4; i++) {
            bonusApples.push({ ...randomApple([...newSnake, ...bonusApples]), type: 'normal' });
          }
          clusterApplesRef.current = bonusApples;
        }

        // Spawn next apple
        appleRef.current = { ...randomApple(newSnake), type: nextAppleType() };

        if (socket && roomIdRef.current) {
          socket.emit('snake_score_ping', { roomId: roomIdRef.current, applesEaten: scoreRef.current });
        }
      }

      // Check if snake head overlaps any cluster apple
      const clusterIdx = clusterApplesRef.current.findIndex(ca => ca.x === newHead.x && ca.y === newHead.y);
      if (clusterIdx !== -1) {
        clusterApplesRef.current.splice(clusterIdx, 1);
        const puActive2 = activePowerUpRef.current;
        const pts2 = (puActive2?.type === 'double' && performance.now() < puActive2.endsAt) ? 2 : 1;
        scoreRef.current += pts2;
        setMyScore(scoreRef.current);
        newSnake.push(newSnake[newSnake.length - 1]); // grow
        if (socket && roomIdRef.current) {
          socket.emit('snake_score_ping', { roomId: roomIdRef.current, applesEaten: scoreRef.current });
        }
      }

      snakeRef.current = newSnake;
    }

    tickRef.current = setInterval(moveTick, TICK_MS);

    function doDie() {
      if (deadRef.current) return;
      deadRef.current = true;
      clearInterval(tickRef.current);
      clearInterval(botTickRef.current);
      if (socket && roomIdRef.current) {
        socket.emit('snake_died', {
          roomId: roomIdRef.current,
          applesEaten: scoreRef.current,
          botScore: isSoloRef.current ? botScoreRef.current : null,
        });
      }
      if (isSoloRef.current) sessionStorage.removeItem('activeGame');
    }
  }

  function stopGame() {
    clearInterval(tickRef.current);
    clearInterval(botTickRef.current);
    cancelAnimationFrame(rafRef.current);
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

    function onMatchFound({ roomId: rid, opponent: opp, entryFee: fee, isSolo: solo }) {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp || null);
      setIsSolo(!!solo);
      if (fee !== undefined) setEntryFee(fee);
      setRoundScore({ me: 0, opp: 0 });
      setCurrentRound(1);
      setRoundResult(null);
      setResult(null);
      setMyScore(0);
      setOppScore(0);
      setPhase('countdown');
      if (!solo) sessionStorage.setItem('activeGame', JSON.stringify({ roomId: rid, gameType: 'snake' }));
    }

    function onCountdown({ count }) {
      setCountdown(count);
      setPhase('countdown');
    }

    function onRoundStart({ round }) {
      setCurrentRound(round);
      setCountdown(null);
      setRoundResult(null);
      setMyScore(0);
      setOppScore(0);
      setPhase('game');
    }

    function onOppScore({ score }) {
      setOppScore(score);
    }

    function onRoundResult({ round, roundWinnerId, scores }) {
      const myId = profileRef.current?.id;
      setRoundResult({ round, won: roundWinnerId === myId });
      setRoundScore({
        me:  scores[myId] ?? 0,
        opp: scores[Object.keys(scores).find(k => k !== myId)] ?? 0,
      });
      setPhase('round_result');
      stopGame();
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
      stopGame();
      sessionStorage.removeItem('activeGame');
      refreshProfile();
    }

    function onDisconnect(data = {}) {
      stopGame();
      sessionStorage.removeItem('activeGame');
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

    let reconnectInterval = null;
    function onOpponentReconnecting({ countdown }) {
      setReconnecting(countdown);
      clearInterval(reconnectInterval);
      reconnectInterval = setInterval(() => {
        setReconnecting(c => {
          if (c <= 1) { clearInterval(reconnectInterval); return null; }
          return c - 1;
        });
      }, 1000);
    }

    function onOpponentReconnected() {
      clearInterval(reconnectInterval);
      setReconnecting(null);
    }

    function onRejoinSuccess({ roomId: rid, gameType }) {
      if (gameType !== 'snake') return;
      setRoomId(rid);
      setPhase('game');
      setReconnecting(null);
    }

    function onError({ message }) { setStatusMsg(message); }

    socket.on('snake_match_found',     onMatchFound);
    socket.on('snake_countdown',       onCountdown);
    socket.on('snake_round_start',     onRoundStart);
    socket.on('snake_opponent_score',  onOppScore);
    socket.on('snake_round_result',    onRoundResult);
    socket.on('snake_result',          onResult);
    socket.on('opponent_disconnected', onDisconnect);
    socket.on('opponent_reconnecting', onOpponentReconnecting);
    socket.on('opponent_reconnected',  onOpponentReconnected);
    socket.on('rejoin_success',        onRejoinSuccess);
    socket.on('error',                 onError);
    socket.on('private_room_created',  ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    // Check for pending rejoin (e.g. navigated away mid-match)
    const stored = sessionStorage.getItem('activeGame');
    if (stored) {
      try {
        const { roomId: rid, gameType } = JSON.parse(stored);
        if (gameType === 'snake' && rid) socket.emit('rejoin_game', { roomId: rid });
      } catch {}
    }

    return () => {
      clearInterval(reconnectInterval);
      socket.off('snake_match_found',     onMatchFound);
      socket.off('snake_countdown',       onCountdown);
      socket.off('snake_round_start',     onRoundStart);
      socket.off('snake_opponent_score',  onOppScore);
      socket.off('snake_round_result',    onRoundResult);
      socket.off('snake_result',          onResult);
      socket.off('opponent_disconnected', onDisconnect);
      socket.off('opponent_reconnecting', onOpponentReconnecting);
      socket.off('opponent_reconnected',  onOpponentReconnected);
      socket.off('rejoin_success',        onRejoinSuccess);
      socket.off('error',                 onError);
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_snake_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_snake_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting solo game...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_snake_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting solo game...');
  }

  function leaveQueue() {
    socket.emit('leave_snake_queue');
    setPhase('lobby');
    setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'snake', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'snake', code });
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
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
    setResult(null);
    socket.emit('snake_rematch_request', { roomId });
    setPhase('queue');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    stopGame();
    sessionStorage.removeItem('activeGame');
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setMyScore(0);
    setOppScore(0);
    setBotScore(0);
    setStatusMsg('');
    setIsSolo(false);
    setReconnecting(null);
    setRoundScore({ me: 0, opp: 0 });
    setCurrentRound(1);
    setRoundResult(null);
  }

  function mobileDir(key) {
    if (phaseRef.current !== 'game') return;
    const d = KEY_DIR[key];
    if (!d) return;
    const cur = dirRef.current;
    if (d.x === -cur.x && d.y === -cur.y) return;
    nextDirRef.current = d;
  }

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);
  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {RejoinOverlay}

      {/* LOBBY */}
      {phase === 'lobby' && (
        <GameLobby
          title="🐍 Snake"
          description="Eat apples to grow — most apples eaten wins"
          controls="Arrow keys or WASD to move"
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

      {/* GAME / ROUND_RESULT */}
      {(phase === 'game' || phase === 'round_result') && (
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          {/* Score header */}
          {isSolo && entryFee > 0 ? (
            <div className="flex items-center gap-6">
              <div className="text-center">
                <div className="text-xs text-muted mb-0.5">{profile?.username}</div>
                <div className="text-2xl font-black text-primary">🍎 {myScore}</div>
              </div>
              <div className="text-xs text-muted font-bold">VS</div>
              <div className="text-center">
                <div className="text-xs text-muted mb-0.5">🤖 Duely Bot</div>
                <div className="text-2xl font-black text-accent">🍎 {botScore}</div>
              </div>
            </div>
          ) : isSolo ? (
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-xs text-muted mb-0.5">{profile?.username}</div>
                <div className="text-2xl font-black text-primary">🍎 {myScore}</div>
              </div>
              <div className="text-xs text-muted italic">Solo Endless</div>
            </div>
          ) : (
            <div className="flex items-center justify-between w-full" style={{ maxWidth: GRID * CELL }}>
              <div className="text-center">
                <div className="text-xs text-muted mb-0.5">{profile?.username}</div>
                <div className="text-xl font-black text-primary">🍎 {myScore}</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-black text-white">{roundScore.me} — {roundScore.opp}</div>
                <div className="text-xs text-muted">Round {currentRound}/3</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-muted mb-0.5">{opponent?.username}</div>
                <div className="text-xl font-black text-accent">🍎 {oppScore}</div>
              </div>
            </div>
          )}

          {/* Round result overlay */}
          {!isSolo && phase === 'round_result' && roundResult && (
            <div className={`text-center px-6 py-2 rounded-xl border ${
              roundResult.won ? 'bg-success/10 border-success/30' : 'bg-danger/10 border-danger/30'
            }`}>
              <div className="font-black">
                {roundResult.won ? '✅ Round Won!' : '❌ Round Lost'}
              </div>
              <div className="text-xs text-muted animate-pulse">Next round starting...</div>
            </div>
          )}

          {/* Canvas */}
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={GRID * CELL}
              height={GRID * CELL}
              className="rounded-xl border border-border block"
              style={{ maxWidth: '100%', height: 'auto' }}
            />
            {phase === 'round_result' && (
              <div className="absolute inset-0 bg-bg/60 rounded-xl" />
            )}
            {reconnecting !== null && (
              <div className="absolute inset-0 bg-bg/80 flex items-center justify-center rounded-xl">
                <div className="text-center">
                  <div className="text-lg font-bold text-warning mb-1">⏳ Opponent reconnecting</div>
                  <div className="text-5xl font-black text-primary">{reconnecting}</div>
                </div>
              </div>
            )}
          </div>

          {/* Mobile D-pad */}
          <div className="grid grid-cols-3 gap-2 mt-3 md:hidden w-full select-none">
            <div />
            <button onPointerDown={() => mobileDir('ArrowUp')}
              className="py-6 bg-surfaceLight border border-border rounded-xl text-white text-2xl font-bold active:bg-primary/30 touch-none">↑</button>
            <div />
            <button onPointerDown={() => mobileDir('ArrowLeft')}
              className="py-6 bg-surfaceLight border border-border rounded-xl text-white text-2xl font-bold active:bg-primary/30 touch-none">←</button>
            <button onPointerDown={() => mobileDir('ArrowDown')}
              className="py-6 bg-surfaceLight border border-border rounded-xl text-white text-2xl font-bold active:bg-primary/30 touch-none">↓</button>
            <button onPointerDown={() => mobileDir('ArrowRight')}
              className="py-6 bg-surfaceLight border border-border rounded-xl text-white text-2xl font-bold active:bg-primary/30 touch-none">→</button>
          </div>
        </div>
      )}

      {/* RESULT */}
      {phase === 'result' && result && (
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          {result.isSolo && result.humanWon !== null ? (
            <>
              <div className={`text-7xl mb-4 animate-pop-in ${result.humanWon ? '' : 'grayscale'}`}>
                {result.humanWon ? '🏆' : '🤖'}
              </div>
              <h2 className={`text-4xl font-black mb-2 animate-pop-in ${result.humanWon ? 'text-success' : 'text-danger'}`} style={{ animationDelay: '0.1s' }}>
                {result.humanWon ? 'You Beat the Bot!' : 'Bot Wins!'}
              </h2>
              <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted">Your apples</span>
                  <span className="text-white font-bold">🍎 {result.playerScore}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Bot apples</span>
                  <span className="text-white font-bold">🍎 {result.botScore ?? '?'}</span>
                </div>
                {result.humanWon && result.balanceChange?.winnerPayout > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-muted">Payout</span>
                    <span className="text-success font-bold">
                      +{result.currency === 'diamonds'
                        ? `${Math.round(result.balanceChange.winnerPayout)} 💎`
                        : `${result.balanceChange.winnerPayout.toFixed(2)} 🪙`}
                    </span>
                  </div>
                ) : !result.humanWon && result.entryFee > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-muted">Entry lost</span>
                    <span className="text-danger font-bold">-{result.entryFee} {result.currency === 'diamonds' ? '💎' : '🪙'}</span>
                  </div>
                ) : null}
              </div>
              <div className="flex gap-3">
                <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
                <GlowButton variant="primary" onClick={playVsBot} className="flex-1">Play Again</GlowButton>
              </div>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
            </>
          ) : result.isSolo ? (
            <>
              <div className="text-7xl mb-4 animate-pop-in">🐍</div>
              <h2 className="text-4xl font-black mb-2 text-white animate-pop-in" style={{ animationDelay: '0.1s' }}>
                Game Over!
              </h2>
              <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">Apples eaten</span>
                  <span className="text-white font-bold text-lg">🍎 {result.playerScore}</span>
                </div>
              </div>
              <div className="flex gap-3">
                <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
                <GlowButton variant="primary" onClick={playVsBot} className="flex-1">Play Again</GlowButton>
              </div>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
            </>
          ) : (
            <>
              <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>{isWinner ? '🏆' : '💀'}</div>
              <h2 className={`text-4xl font-black mb-2 animate-pop-in ${isWinner ? 'text-success' : 'text-danger'}`} style={{ animationDelay: '0.1s' }}>
                {isWinner ? 'You Won!' : 'You Lost!'}
              </h2>
              {result.disconnected && (
                <p className="text-sm text-muted mb-3">Opponent disconnected</p>
              )}
              <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted">Series</span>
                  <span className="text-white font-bold">{roundScore.me} — {roundScore.opp}</span>
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
                        ? `+${resultCurrency === 'diamonds'
                            ? Math.round(result.balanceChange.winnerPayout) + ' 💎'
                            : result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
                        : `-${entryFee} ${resultCurrency === 'diamonds' ? '💎' : '🪙'}`}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
                <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
              </div>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}


