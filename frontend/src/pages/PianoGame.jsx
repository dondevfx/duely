import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';

const COLS = 4;
const CANVAS_W = 520;
const CANVAS_H = 680;
const TILE_W = 111;  // column is 130px, tile is 111px (2px gap each side)
const TILE_H = 175;
const HIT_ZONE = 175; // bottom zone - tiles must enter here to be hittable

const COL_COLORS = ['#ff2d78', '#00eeff', '#7c3aed', '#00ff88'];

const BASE_SPEED   = 270;  // px/sec at level 0
const SPEED_INC    = 38;   // px/sec added per level
const LEVEL_MS     = 5000; // ms per speed level
const BASE_SPAWN   = 920;  // ms between spawns at level 0
const SPAWN_DEC    = 55;   // ms removed per level
const MIN_SPAWN    = 300;  // minimum spawn interval

const COIN_FEES    = [0.5, 1, 2, 5, 10, 25];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

// Static lobby preview pattern
const PREVIEW = [1, 3, 0, 2, 1, 0, 3, 2, 0, 1, 3, 0];

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawFrame(ctx, tiles, flash, feverActive, powerUpRef) {
  const W = CANVAS_W, H = CANVAS_H;
  const colW = W / COLS;

  // Deep black background
  ctx.fillStyle = '#050a12';
  ctx.fillRect(0, 0, W, H);

  // Death flash overlay
  if (flash) {
    ctx.fillStyle = 'rgba(255,30,30,0.5)';
    ctx.fillRect(0, 0, W, H);
  }

  // Vertical neon lane lines (bright cyan, glowing)
  ctx.strokeStyle = 'rgba(0,200,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0,200,255,0.6)';
  ctx.shadowBlur = 8;
  for (let col = 1; col < COLS; col++) {
    const lx = col * (W / COLS);
    ctx.beginPath();
    ctx.moveTo(lx, 0);
    ctx.lineTo(lx, H);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Hit zone — neon floor glow
  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur = 20;
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, H - HIT_ZONE);
  ctx.lineTo(W, H - HIT_ZONE);
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Subtle zone fill
  ctx.fillStyle = 'rgba(0,255,255,0.04)';
  ctx.fillRect(0, H - HIT_ZONE, W, HIT_ZONE);

  // Tiles
  for (const tile of tiles) {
    const x   = tile.col * colW;
    const y   = tile.y;
    const tileW = colW;
    const tileH2 = TILE_H;

    const isHit = tile.hitFlash > 0;
    const neonColor = COL_COLORS[tile.col % COL_COLORS.length];

    if (!tile.hit) {
      if (isHit) {
        // Hit flash — bright white burst then neon fade
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 40;
        ctx.fillRect(x + 2, y + 2, tileW - 4, tileH2 - 4);
        ctx.shadowBlur = 0;
      } else {
        // Normal tile — neon glow effect
        // Dark body
        ctx.fillStyle = neonColor + '18';
        ctx.fillRect(x + 2, y + 2, tileW - 4, tileH2 - 4);

        // Neon border glow
        ctx.strokeStyle = neonColor;
        ctx.lineWidth = 2;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 12;
        ctx.strokeRect(x + 3, y + 3, tileW - 6, tileH2 - 6);
        ctx.shadowBlur = 0;

        // Inner top highlight (horizontal neon stripe near top)
        ctx.fillStyle = neonColor;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 8;
        ctx.fillRect(x + 4, y + 4, tileW - 8, 3);
        ctx.shadowBlur = 0;

        // Inner bottom fade
        ctx.fillStyle = neonColor + '33';
        ctx.fillRect(x + 4, y + tileH2 - 8, tileW - 8, 4);
      }
    }

    // Power-up overlays — glowing dramatic look
    if (tile.type === 'double' || tile.type === 'shield' || tile.type === 'slow') {
      const pu_colors = {
        double: { bg: '#001833', border: '#0088ff', glow: '#0066ff', label1: '×2', label2: 'DOUBLE' },
        shield: { bg: '#001020', border: '#00ccff', glow: '#0088ff', label1: '⬡', label2: 'SHIELD' },
        slow:   { bg: '#0d0020', border: '#aa44ff', glow: '#8800ff', label1: '½', label2: 'SLOW' },
      };
      const pc = pu_colors[tile.type];

      // Outer glow
      ctx.shadowColor = pc.glow;
      ctx.shadowBlur = 18;

      // Background
      ctx.fillStyle = pc.bg;
      ctx.fillRect(x + 2, y + 2, tileW - 4, tileH2 - 4);

      // Pulsing border
      const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 400);
      ctx.strokeStyle = pc.border;
      ctx.lineWidth = 3;
      ctx.globalAlpha = pulse;
      ctx.strokeRect(x + 3, y + 3, tileW - 6, tileH2 - 6);
      ctx.globalAlpha = 1;

      // Inner glow
      ctx.fillStyle = pc.border + '22';
      ctx.fillRect(x + 4, y + 4, tileW - 8, tileH2 - 8);

      // Two-line text label
      ctx.shadowColor = pc.glow;
      ctx.shadowBlur = 12;
      ctx.font = `bold ${Math.floor(tileH2 * 0.35)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(pc.label1, x + tileW / 2, y + tileH2 / 2 - 8);
      ctx.font = `bold ${Math.floor(tileH2 * 0.12)}px monospace`;
      ctx.fillStyle = pc.border;
      ctx.fillText(pc.label2, x + tileW / 2, y + tileH2 / 2 + Math.floor(tileH2 * 0.22));
      ctx.shadowBlur = 0;
    }
    ctx.textBaseline = 'alphabetic';
  }
  ctx.shadowBlur = 0;

  // Fever border overlay
  if (feverActive) {
    const feverPulse = 0.6 + 0.4 * Math.sin(performance.now() / 120);
    ctx.strokeStyle = `rgba(255, 215, 0, ${feverPulse})`;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 18;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.shadowBlur = 0;
  }

  // Power-up active banner
  const pu = powerUpRef ? powerUpRef.current : null;
  if (pu && performance.now() < pu.endsAt) {
    const remaining = ((pu.endsAt - performance.now()) / 1000).toFixed(1);
    const colors = { double: '#00ccff', shield: '#4488ff', slow: '#aa44ff' };
    const labels = { double: '×2 DOUBLE', shield: 'SHIELD ON', slow: '½ SLOW' };
    const c = colors[pu.type];

    // Timer bar at top of canvas
    const pct = (pu.endsAt - performance.now()) / 15000;
    ctx.fillStyle = `${c}44`;
    ctx.fillRect(0, 0, W * pct, 4);

    // Background banner
    ctx.fillStyle = `${c}22`;
    ctx.fillRect(0, 0, W, 32);
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, W, 32);

    // Text
    ctx.fillStyle = c;
    ctx.shadowColor = c;
    ctx.shadowBlur = 14;
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${labels[pu.type]}  ${remaining}s`, W / 2, 16);
    ctx.shadowBlur = 0;
    ctx.textBaseline = 'alphabetic';
  }
}

export default function PianoGame() {
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
  const [countdown, setCountdown]   = useState(3);
  const [tilesHit, setTilesHit]     = useState(0);
  const [speedLevel, setSpeedLevel] = useState(0);
  const [oppTiles, setOppTiles]     = useState(null);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [activePowerUp, setActivePowerUp] = useState(null);

  const canvasRef   = useRef(null);
  const animRef     = useRef(null);
  const roomIdRef    = useRef(null);
  const eloBeforeRef = useRef(null);
  const socketRef    = useRef(null);
  const startDataRef = useRef(null); // { seed, startTime }
  const powerUpRef   = useRef(null); // null | { type, endsAt }
  const powerUpCountdownRef = useRef(0); // tiles since last power-up spawn
  const powerUpIntervalRef = useRef(10 + Math.floor(Math.random() * 45)); // random interval until next power-up
  const gameRef     = useRef({
    tiles: [], nextId: 0, prng: null,
    lastSpawnElapsed: -9999,
    dead: false, tilesHit: 0,
    startTime: 0, prevTime: 0,
    flashTimer: 0,
    streak: 0, feverActive: false, feverEnd: 0,
  });

  roomIdRef.current = roomId;
  socketRef.current = socket;

  const isDiamonds    = betCurrency === 'diamonds';
  const fees          = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currencyLabel = isDiamonds ? '💎' : '🪙';
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient  = entryFee > 0 && myBalance < entryFee;

  useEffect(() => { setEntryFee(isDiamonds ? DIAMOND_FEES[Math.floor(DIAMOND_FEES.length / 2)] : COIN_FEES[Math.floor(COIN_FEES.length / 2)]); }, [betCurrency]);

  // Power-up type helper
  function getNextTileType() {
    powerUpCountdownRef.current++;
    if (powerUpCountdownRef.current >= powerUpIntervalRef.current) {
      powerUpCountdownRef.current = 0;
      powerUpIntervalRef.current = 10 + Math.floor(Math.random() * 45); // 10-55 tiles next
      const roll = Math.random();
      if (roll < 0.34) return 'double';
      if (roll < 0.67) return 'shield';
      return 'slow';
    }
    return 'normal';
  }

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    socket.on('piano_queue_joined',       () => setStatusMsg('Searching for opponent...'));
    socket.on('piano_match_found',        ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      setRoomId(rid);
      setOpponent(opp || null);
      setOppTiles(null);
      setPhase('countdown');
    });
    socket.on('piano_countdown',          ({ count }) => setCountdown(count));
    socket.on('piano_start',              ({ seed }) => {
      // Store seed only — use client-side performance.now() as start reference
      // so it's comparable to the rAF timestamp passed into tick().
      startDataRef.current = { seed };
      setPhase('active');
    });
    socket.on('piano_opponent_progress',  ({ tilesHit: t }) => setOppTiles(t));
    socket.on('piano_rematch_requested',  () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('piano_result',             (data) => {
      cancelAnimationFrame(animRef.current);
      setResult(data);
      setResultCurrency(data.currency || 'coins');
      setPhase('result');
      refreshProfile();
    });
    socket.on('opponent_disconnected', (data = {}) => {
      const myId = profile?.id;
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
    });
    socket.on('error', ({ message }) => setStatusMsg(message));
    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      socket.emit('leave_game');
      socket.off('piano_queue_joined');
      socket.off('piano_match_found');
      socket.off('piano_countdown');
      socket.off('piano_start');
      socket.off('piano_opponent_progress');
      socket.off('piano_rematch_requested');
      socket.off('piano_result');
      socket.off('opponent_disconnected');
      socket.off('error');
      socket.off('private_room_created');
    };
  }, [socket, refreshProfile]);

  // Start game when phase transitions to active
  useEffect(() => {
    if (phase !== 'active' || !startDataRef.current) return;
    const { seed } = startDataRef.current;
    startDataRef.current = null;

    // Reset power-up state
    powerUpRef.current = null;
    powerUpCountdownRef.current = 0;
    powerUpIntervalRef.current = 10 + Math.floor(Math.random() * 45);

    const state = gameRef.current;
    state.tiles            = [];
    state.nextId           = 0;
    state.prng             = mulberry32(seed);
    state.lastSpawnElapsed = -BASE_SPAWN; // spawn immediately on first frame
    state.dead             = false;
    state.tilesHit         = 0;
    state.perfectFlashes   = [];
    state.startTime        = performance.now(); // must match rAF's timestamp
    state.prevTime         = 0;
    state.flashTimer       = 0;
    state.frameCount       = 0;
    state.streak           = 0;
    state.feverActive      = false;
    state.feverEnd         = 0;

    setTilesHit(0);
    setSpeedLevel(0);
    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(tick);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function tick(now) {
    const state  = gameRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // now is performance.now() — matches state.startTime set via performance.now()
    const elapsed = now - state.startTime;
    const dt      = state.prevTime ? Math.min(now - state.prevTime, 50) : 16;
    state.prevTime = now;
    state.frameCount = (state.frameCount || 0) + 1;

    const lvl           = Math.max(0, Math.floor(elapsed / LEVEL_MS));
    const baseSpeed     = (BASE_SPEED + lvl * SPEED_INC) / 1000;
    const spawnInterval = Math.max(MIN_SPAWN, BASE_SPAWN - lvl * SPAWN_DEC);

    // Determine speed multiplier (with gradual recovery after slow power-up)
    const puNow = powerUpRef.current;
    const SLOW_RECOVERY_MS = 2000;
    let speedMultiplier = 1.0;
    if (puNow && puNow.type === 'slow') {
      if (now < puNow.endsAt) {
        speedMultiplier = 0.5;
      } else if (now < puNow.endsAt + SLOW_RECOVERY_MS) {
        const elapsed = now - puNow.endsAt;
        speedMultiplier = 0.5 + (0.5 * elapsed / SLOW_RECOVERY_MS);
      } else {
        // Recovery done — clear the power-up ref
        if (powerUpRef.current?.type === 'slow') powerUpRef.current = null;
      }
    }
    const speedPxMs = baseSpeed * speedMultiplier;

    // Expire non-slow power-ups if time is up
    if (puNow && puNow.type !== 'slow' && now >= puNow.endsAt) {
      powerUpRef.current = null;
    }

    // Spawn tile
    if (elapsed - state.lastSpawnElapsed >= spawnInterval) {
      const col = Math.floor(state.prng() * COLS);
      const type = getNextTileType();
      state.tiles.push({ id: state.nextId++, col, y: -TILE_H, hit: false, hitFlash: 0, type });
      state.lastSpawnElapsed = elapsed;
    }

    // Death flash countdown
    if (state.flashTimer > 0) state.flashTimer -= dt;

    // Move tiles
    for (const t of state.tiles) {
      if (!t.hit) t.y += speedPxMs * dt;
      if (t.hitFlash > 0) t.hitFlash = Math.max(0, t.hitFlash - dt / 150);
    }

    // Miss detection — power-up tiles don't cause death when missed
    if (!state.dead) {
      const missedTiles = state.tiles.filter(t => !t.hit && t.y > CANVAS_H);
      for (const missed of missedTiles) {
        if (missed.type !== 'normal') {
          // Power-up tiles that scroll off — no penalty, just mark as hit to cull
          missed.hit = true;
          state.streak = 0;
          state.feverActive = false;
        } else {
          // Check shield
          const puCurrent = powerUpRef.current;
          const shielded = puCurrent && puCurrent.type === 'shield' && now < puCurrent.endsAt;
          if (shielded) {
            // Shield absorbs the miss — no death, just reset streak
            missed.hit = true;
            state.streak = 0;
          } else {
            // Normal death
            state.dead = true;
            state.flashTimer = 450;
            const rid = roomIdRef.current;
            const sk  = socketRef.current;
            if (sk) sk.emit('piano_died', { roomId: rid, tilesHit: state.tilesHit });
            break;
          }
        }
      }
    }

    // Fever timer
    if (state.feverActive && now >= state.feverEnd) {
      state.feverActive = false;
    }

    // Cull old tiles
    state.tiles = state.tiles.filter(t => !(t.hit && t.hitFlash <= 0) && t.y < CANVAS_H + 20);

    // Draw
    drawFrame(ctx, state.tiles, state.flashTimer > 0, state.feverActive, powerUpRef);

    // Fever text (drawn after drawFrame)
    if (state.feverActive) {
      const remaining = Math.ceil((state.feverEnd - now) / 1000);
      ctx.save();
      ctx.shadowColor = '#ffcc00';
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#ffcc00';
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`FEVER x2  ${remaining}s`, CANVAS_W / 2, 50);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // Perfect flashes — neon burst effect
    for (const pf of state.perfectFlashes) {
      pf.life -= dt / 700;
      if (pf.life <= 0) continue;
      const a = Math.max(0, pf.life);
      const rise = (1 - pf.life) * 90;
      const neonBurst = COL_COLORS[Math.floor(pf.x / (CANVAS_W / COLS)) % COL_COLORS.length];

      ctx.save();
      ctx.globalAlpha = a;

      // Expanding ring
      ctx.beginPath();
      ctx.arc(pf.x, pf.y - rise * 0.3, (1 - pf.life) * 60, 0, Math.PI * 2);
      ctx.strokeStyle = neonBurst;
      ctx.lineWidth = 2;
      ctx.shadowColor = neonBurst;
      ctx.shadowBlur = 20;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Text
      ctx.font = 'bold 20px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = neonBurst;
      ctx.shadowBlur = 16;
      ctx.fillText('PERFECT', pf.x, pf.y - rise - 12);
      ctx.shadowBlur = 0;

      ctx.restore();
    }
    state.perfectFlashes = state.perfectFlashes.filter(pf => pf.life > 0);

    // Update React state ~10 fps to avoid over-rendering
    if (state.frameCount % 6 === 0) {
      setTilesHit(state.tilesHit);
      setSpeedLevel(lvl);
    }

    if (!state.dead || state.flashTimer > 0) {
      animRef.current = requestAnimationFrame(tick);
    }
  }

  const handleInteraction = useCallback((clientX) => {
    const state  = gameRef.current;
    const canvas = canvasRef.current;
    if (state.dead || !canvas) return;
    const rect  = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const x     = (clientX - rect.left) * scaleX;
    const col   = Math.min(COLS - 1, Math.max(0, Math.floor(x * COLS / CANVAS_W)));
    const zoneTop = CANVAS_H - HIT_ZONE;
    let best = null;
    for (const t of state.tiles) {
      if (t.col === col && !t.hit) {
        const inZone = (t.y + TILE_H) >= zoneTop && t.y < CANVAS_H;
        if (inZone && (!best || t.y > best.y)) best = t;
      }
    }
    if (best) {
      best.hit = true;
      best.hitFlash = 1;
      state.streak++;
      if (!state.feverActive && state.streak >= 15) {
        state.feverActive = true;
        state.feverEnd = performance.now() + 5000;
      }

      // Handle power-up tile activation
      if (best.type !== 'normal') {
        const duration = 15000;
        powerUpRef.current = {
          type: best.type,
          endsAt: performance.now() + duration,
        };
        setActivePowerUp(best.type);
        setTimeout(() => setActivePowerUp(null), 2500);
      }

      // Score calculation with power-up multipliers
      const pu = powerUpRef.current;
      const puActive = pu && performance.now() < pu.endsAt;
      if (!puActive) powerUpRef.current = null;

      let multiplier = state.feverActive ? 2 : 1;
      if (puActive && pu.type === 'double') multiplier *= 2;
      if (puActive && pu.type === 'slow')   multiplier *= 3;

      state.tilesHit += multiplier;

      const tileCenterY = best.y + TILE_H / 2;
      const perfectThreshold = CANVAS_H - HIT_ZONE * 0.55;
      if (tileCenterY >= perfectThreshold) {
        const colW = CANVAS_W / COLS;
        state.perfectFlashes.push({ x: best.col * colW + colW / 2, y: CANVAS_H - HIT_ZONE + 40, life: 1 });
      }
      if (state.tilesHit % 10 === 0) {
        const sk = socketRef.current;
        if (sk) sk.emit('piano_progress', { roomId: roomIdRef.current, tilesHit: state.tilesHit });
      }
    } else {
      state.dead = true;
      state.flashTimer = 450;
      state.streak = 0;
      state.feverActive = false;
      const sk = socketRef.current;
      if (sk) sk.emit('piano_died', { roomId: roomIdRef.current, tilesHit: state.tilesHit });
    }
  }, []);
  function handleClick(e) { handleInteraction(e.clientX); }
  function handleTouch(e) {
    e.preventDefault();
    if (e.changedTouches.length > 0) handleInteraction(e.changedTouches[0].clientX);
  }

  function joinQueue() {
    if (!authenticated) { doAuth(); setStatusMsg('Connecting...'); return; }
    socket.emit('join_piano_queue', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Finding an opponent...');
  }

  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_piano_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue');
    setStatusMsg('Starting solo mode...');
  }

  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_piano_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue');
    setStatusMsg('Starting free match...');
  }

  function leaveQueue() {
    socket.emit('leave_piano_queue');
    setPhase('lobby');
    setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'piano', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'piano', code });
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
    socket.emit('piano_rematch_request', { roomId });
    setResult(null);
    setPhase('countdown');
    setStatusMsg('Waiting for opponent...');
  }

  function backToLobby() {
    cancelAnimationFrame(animRef.current);
    setPhase('lobby');
    setResult(null);
    setOpponent(null);
    setRoomId(null);
    setOppTiles(null);
    setTilesHit(0);
    setSpeedLevel(0);
    setStatusMsg('');
  }

  const isWinner = result && result.winnerId === profile?.id;

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);

  // Power-up banner label map
  const puBannerText = { double: '⚡ Double Score!', shield: '🛡 Shield Active!', slow: '❄ Slow + Triple Score!' };

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="🎹 Tile Tap"
          description="Tap falling tiles in time — miss 3 and it's over. Power-up tiles are optional: ⚡ Double points 15s · 🛡 Invincible 15s (misses forgiven) · ❄ Slow tiles + triple points 15s"
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
          gameType="piano"
          liveCount={playerCounts?.piano ?? 0}
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
          <p className="text-muted mb-6 text-sm">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {/* ── COUNTDOWN ── */}
      {phase === 'countdown' && (
        <div className="flex flex-col items-center animate-fade-in">
          {opponent && (
            <p className="text-muted mb-8 text-lg">
              vs <span className="text-white font-bold">{opponent.username}</span>
              <span className="text-muted ml-2">(ELO {opponent.elo})</span>
            </p>
          )}
          <div className="w-48 h-48 rounded-full border-4 border-primary bg-primary/10 shadow-glow flex items-center justify-center mx-auto">
            <span key={countdown} className="text-7xl font-black text-white animate-countdown-pop">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">Get ready to tap!</p>
        </div>
      )}

      {/* ── ACTIVE ── */}
      {phase === 'active' && (
        <div className="flex flex-col items-center gap-3 w-full animate-fade-in">
          {/* Stats row */}
          <div className="flex gap-6 text-center">
            <div>
              <div className="text-2xl font-black text-white font-mono">{tilesHit}</div>
              <div className="text-xs text-muted">Tiles</div>
            </div>
            <div>
              <div className="text-2xl font-black text-accent font-mono">Lv.{speedLevel + 1}</div>
              <div className="text-xs text-muted">Speed</div>
            </div>
            {opponent && (
              <div>
                <div className="text-2xl font-black text-muted font-mono">
                  {oppTiles !== null ? oppTiles : '—'}
                </div>
                <div className="text-xs text-muted">{opponent.username}</div>
              </div>
            )}
          </div>

          {/* Power-up activation banner */}
          {activePowerUp && (
            <div
              className="text-sm font-bold px-4 py-1 rounded-full animate-fade-in"
              style={{
                background: activePowerUp === 'double' ? 'rgba(0,200,255,0.2)' : activePowerUp === 'shield' ? 'rgba(30,100,255,0.2)' : 'rgba(140,40,200,0.2)',
                color: activePowerUp === 'double' ? '#00ccff' : activePowerUp === 'shield' ? '#4488ff' : '#aa44ff',
                border: `1px solid ${activePowerUp === 'double' ? '#00ccff' : activePowerUp === 'shield' ? '#4488ff' : '#aa44ff'}`,
              }}
            >
              {puBannerText[activePowerUp]}
            </div>
          )}

          {/* Canvas */}
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            onClick={(e) => { e.preventDefault(); handleClick(e); }}
            onTouchStart={(e) => { e.preventDefault(); handleTouch(e); }}
            className="touch-none select-none cursor-pointer rounded-lg"
            style={{ width: `min(${CANVAS_W}px, 98vw)`, height: 'auto', touchAction: 'none', display: 'block', border: '1px solid rgba(0,200,255,0.4)', borderRadius: 4, boxShadow: '0 0 40px rgba(0,200,255,0.15), 0 0 80px rgba(0,200,255,0.05)' }}
          />

          <p className="text-xs text-muted">Tap columns to hit the tiles</p>
        </div>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          {result.isEndless ? (
            <>
              <div className={`text-7xl mb-4 ${result.humanWon ? '' : 'grayscale'}`}>{result.humanWon ? '🏆' : '💀'}</div>
              <h2 className={`text-4xl font-black mb-2 ${result.humanWon ? 'text-success' : 'text-danger'}`}>
                {result.humanWon == null ? 'Game Over!' : result.humanWon ? 'You Won!' : 'You Lost!'}
              </h2>
              <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-6 text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted">Your Tiles</span>
                  <span className="text-white font-bold">{result.tilesHit}</span>
                </div>
                {result.botTiles != null && (
                  <div className="flex justify-between">
                    <span className="text-muted">Bot Tiles</span>
                    <span className="text-white font-bold">{result.botTiles}</span>
                  </div>
                )}
                {result.balanceChange && (
                  <div className="flex justify-between">
                    <span className="text-muted">{result.humanWon ? 'Payout' : 'Entry lost'}</span>
                    <span className={result.humanWon ? 'text-success font-bold' : 'text-danger font-bold'}>
                      {result.humanWon
                        ? `+${(result.currency || 'coins') === 'diamonds'
                            ? Math.round(result.balanceChange.winnerPayout) + ' 💎'
                            : result.balanceChange.winnerPayout?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
                        : `-${entryFee} ${(result.currency || 'coins') === 'diamonds' ? '💎' : '🪙'}`}
                    </span>
                  </div>
                )}
              </div>
              <GlowButton variant="primary" onClick={playVsBotFree} className="w-full mb-2">Play Again</GlowButton>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full border border-border">Home</GlowButton>
            </>
          ) : (
            <>
              <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>
                {isWinner ? '🏆' : '💀'}
              </div>
              <h2 className={`text-4xl font-black mb-2 animate-pop-in ${isWinner ? 'text-success' : 'text-danger'}`} style={{ animationDelay: '0.1s' }}>
                {isWinner ? 'You Won!' : 'You Lost!'}
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
              {!isWinner && !result?.isDraw && (
                <p className="text-sm text-muted italic mb-4">
                  {["Your timing is sharpening — faster every game.", "Opponent was in the zone — your reaction time is improving.", "Nearly had it — focus on the rhythm next time."][Math.floor(Date.now() / 1000) % 3]}
                </p>
              )}

              <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-6 text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted">Your ELO</span>
                  <span className="text-white font-bold">{(() => {
                    const elo = isWinner ? result.newWinnerElo : result.newLoserElo;
                    const delta = elo - (eloBeforeRef.current ?? elo);
                    return <>{elo} <span className={delta >= 0 ? 'text-success' : 'text-danger'}>({delta >= 0 ? '+' : ''}{delta})</span></>;
                  })()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Tiles Hit</span>
                  <span className="text-white font-bold">
                    {isWinner ? result.winnerTiles : result.loserTiles}
                  </span>
                </div>
                {result.balanceChange && (
                  <div className="flex justify-between">
                    <span className="text-muted">{isWinner ? 'Payout' : 'Entry lost'}</span>
                    <span className={isWinner ? 'text-2xl font-black text-success' : 'text-danger font-bold'}
                      style={isWinner ? { textShadow: '0 0 12px rgba(74,222,128,0.5)' } : {}}>
                      {isWinner
                        ? `+${resultCurrency === 'diamonds'
                            ? Math.round(result.balanceChange.winnerPayout) + ' 💎'
                            : result.balanceChange.winnerPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 🪙'}`
                        : `-${entryFee} ${resultCurrency === 'diamonds' ? '💎' : '🪙'}`}
                    </span>
                  </div>
                )}
              </div>

              <GlowButton variant="primary" onClick={requestRematch} className="w-full mb-2">Play Again</GlowButton>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full border border-border">Home</GlowButton>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}



