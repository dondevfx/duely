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

const W = 820, H = 600;
const SHIP_SPEED  = 2;         // px/frame (smooth per-frame movement)
const BULLET_SPEED = 480;      // px/s
const FIRE_CD      = 0.25;     // seconds
const ENEMY_BULLET_SPEED = 160;
const MAX_LIVES    = 3;
const INVINC_T     = 2.5;      // seconds
const DIVE_CHANCE  = 0.0008;
const MAX_DIVERS   = 2;
const BASE_ROWS = 3, BASE_COLS = 8;

// ── Power-up constants ───────────────────────────────────────────────────────
const ORB_TYPES = ['laser', 'invincible', 'freeze'];
const ORB_SPAWN_MIN = 35; // seconds
const ORB_SPAWN_MAX = 45;
const ORB_FALL_SPEED = 60; // px/s
const ORB_COLLECT_DIST = 25;
const POWERUP_LASER_DURATION = 15;
const POWERUP_INVINCIBLE_DURATION = 20;
const POWERUP_FREEZE_DURATION = 15;

// Difficulty config per level (level = Math.floor(score / 1000))
function getDifficulty(score) {
  const lv = Math.min(Math.floor(score / 1000), 8);
  return {
    level:       lv,
    rows:        Math.min(BASE_ROWS + Math.floor(lv / 2), 5),
    cols:        Math.min(BASE_COLS + Math.floor(lv / 3), 10),
    diveChance:  DIVE_CHANCE * (1 + lv * 0.4),
    maxDivers:   Math.min(MAX_DIVERS + Math.floor(lv / 2), 5),
    bulletSpeed: ENEMY_BULLET_SPEED + lv * 20,
    shootChance: 0.007 * (1 + lv * 0.3),
    formSpeed:   35 + lv * 8,
  };
}

function makePRNG(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFormation(rows = BASE_ROWS, cols = BASE_COLS) {
  const enemies = [];
  const colSpacing = Math.min(72, Math.floor((W - 120) / cols));
  const startX = Math.floor((W - (cols - 1) * colSpacing) / 2);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let typeRoll = 'bee';
      if (row === 0) typeRoll = 'boss';
      else if (row === 1) typeRoll = 'butterfly';
      enemies.push({
        id: row * cols + col,
        row, col,
        type: typeRoll,
        homeX: startX + col * colSpacing,
        homeY: 80 + row * 60,
        x: startX + col * colSpacing,
        y: -200 - row * 60,
        alive: true,
        diving: false,
        diveT: 0,
        diveStartX: 0,
        diveStartY: 0,
        diveCtrlX: 0,
        diveCtrlY: 0,
        diveEndX: 0,
        diveEndY: -60,
        entryDone: false,
        entryT: 0,
      });
    }
  }
  return enemies;
}

function quadBezier(p0x, p0y, p1x, p1y, p2x, p2y, t) {
  const it = 1 - t;
  return {
    x: it * it * p0x + 2 * it * t * p1x + t * t * p2x,
    y: it * it * p0y + 2 * it * t * p1y + t * t * p2y,
  };
}

function enemyColor(type) {
  if (type === 'boss') return '#ff4466';
  if (type === 'butterfly') return '#44aaff';
  return '#ffcc00';
}

// ── New alien enemy designs ──────────────────────────────────────────────────
function drawEnemy(ctx, e, frameCount) {
  ctx.save();
  ctx.translate(e.x, e.y);

  // Slow pulse oscillation using frameCount
  const pulse = 0.5 + 0.5 * Math.sin(frameCount * 0.04 + e.id * 0.7);

  if (e.type === 'boss') {
    // Angular alien command ship — red-tinted
    ctx.shadowColor = '#ff2244';
    ctx.shadowBlur = 14 + pulse * 6;

    // Main hull body
    ctx.fillStyle = '#3a0a0a';
    ctx.beginPath();
    ctx.moveTo(0, -20);
    ctx.lineTo(8, -12); ctx.lineTo(20, -6);
    ctx.lineTo(22, 2);  ctx.lineTo(16, 10);
    ctx.lineTo(20, 18); ctx.lineTo(0, 12);
    ctx.lineTo(-20, 18); ctx.lineTo(-16, 10);
    ctx.lineTo(-22, 2); ctx.lineTo(-20, -6);
    ctx.lineTo(-8, -12);
    ctx.closePath();
    ctx.fill();

    // Hull trim lines
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Forward swept wings
    ctx.fillStyle = '#5a1010';
    ctx.beginPath();
    ctx.moveTo(-14, -2); ctx.lineTo(-28, -10); ctx.lineTo(-26, 4); ctx.lineTo(-16, 6);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(14, -2); ctx.lineTo(28, -10); ctx.lineTo(26, 4); ctx.lineTo(16, 6);
    ctx.closePath();
    ctx.fill();

    // Wing trim
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-14, -2); ctx.lineTo(-28, -10);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(14, -2); ctx.lineTo(28, -10);
    ctx.stroke();

    // Red cockpit glow
    ctx.fillStyle = '#ff0044';
    ctx.shadowColor = '#ff0044';
    ctx.shadowBlur = 8 + pulse * 4;
    ctx.beginPath();
    ctx.ellipse(0, -6, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner cockpit highlight
    ctx.fillStyle = `rgba(255,120,150,${0.5 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(0, -7, 3.5, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Engine glow dots
    ctx.fillStyle = '#ffaa00';
    ctx.shadowColor = '#ffaa00';
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(-8, 14, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(8, 14, 3, 0, Math.PI * 2); ctx.fill();

  } else if (e.type === 'butterfly') {
    // Mid-tier alien — red/dark angular shape
    ctx.shadowColor = '#ff2244';
    ctx.shadowBlur = 10 + pulse * 5;

    ctx.fillStyle = '#3a0a0a';
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(6, -8); ctx.lineTo(16, -4);
    ctx.lineTo(13, 5); ctx.lineTo(15, 13);
    ctx.lineTo(0, 9); ctx.lineTo(-15, 13);
    ctx.lineTo(-13, 5); ctx.lineTo(-16, -4);
    ctx.lineTo(-6, -8);
    ctx.closePath();
    ctx.fill();

    // Hull trim
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Wing nubs — swept forward
    ctx.fillStyle = '#5a1010';
    ctx.beginPath();
    ctx.moveTo(-10, -1); ctx.lineTo(-22, -7); ctx.lineTo(-20, 5); ctx.lineTo(-12, 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(10, -1); ctx.lineTo(22, -7); ctx.lineTo(20, 5); ctx.lineTo(12, 4);
    ctx.closePath();
    ctx.fill();

    // Wing trim lines
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-10, -1); ctx.lineTo(-22, -7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10, -1); ctx.lineTo(22, -7); ctx.stroke();

    // Red cockpit center dot
    ctx.fillStyle = '#ff0044';
    ctx.shadowColor = '#ff0044';
    ctx.shadowBlur = 8 + pulse * 3;
    ctx.beginPath();
    ctx.arc(0, -3, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,100,130,${0.5 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.arc(0, -4, 2.5, 0, Math.PI * 2);
    ctx.fill();

  } else {
    // Bee fighter — small angular red alien
    ctx.shadowColor = '#ff2244';
    ctx.shadowBlur = 8 + pulse * 4;

    ctx.fillStyle = '#3a0a0a';
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(5, -5); ctx.lineTo(11, -1);
    ctx.lineTo(8, 7);  ctx.lineTo(0, 4);
    ctx.lineTo(-8, 7); ctx.lineTo(-11, -1);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();

    // Hull trim
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Small swept wing nubs
    ctx.fillStyle = '#5a1010';
    ctx.beginPath();
    ctx.moveTo(-7, 0); ctx.lineTo(-16, -4); ctx.lineTo(-14, 5); ctx.lineTo(-9, 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(7, 0); ctx.lineTo(16, -4); ctx.lineTo(14, 5); ctx.lineTo(9, 4);
    ctx.closePath();
    ctx.fill();

    // Trim lines on wings
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(-16, -4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(16, -4); ctx.stroke();

    // Red cockpit center dot
    ctx.fillStyle = '#ff0044';
    ctx.shadowColor = '#ff0044';
    ctx.shadowBlur = 6 + pulse * 3;
    ctx.beginPath();
    ctx.arc(0, -3, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,100,130,${0.4 + pulse * 0.4})`;
    ctx.beginPath();
    ctx.arc(0, -4, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.restore();
}

// ── New player ship design ────────────────────────────────────────────────────
function drawPlayerShip(ctx, ship, now, frameCount, thrusterParticles) {
  if (!ship.alive) {
    ctx.fillStyle = '#ff4444';
    ctx.shadowColor = '#ff4444';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    return;
  }

  const blink = ship.invincible && Math.floor(now / 100) % 2 === 0;
  if (blink) return;

  ctx.save();
  ctx.translate(ship.x, ship.y);

  // Engine flicker based on frameCount
  const flickerIdx = frameCount % 6;
  const engineFlicker = [0.6, 1.0, 0.7, 0.9, 0.5, 1.0][flickerIdx];

  // ── Thruster trail particles (draw behind ship) ──
  for (const p of thrusterParticles) {
    ctx.globalAlpha = Math.max(0, p.life * 0.7);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x - ship.x, p.y - ship.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ── Engine cones (bottom of ship, drawn before hull) ──
  // Left engine
  const engGradL = ctx.createLinearGradient(-8, 16, -8, 28 + engineFlicker * 10);
  engGradL.addColorStop(0, '#ff6600');
  engGradL.addColorStop(0.5, `rgba(255,${Math.floor(170 * engineFlicker)},0,0.8)`);
  engGradL.addColorStop(1, 'rgba(255,200,0,0)');
  ctx.fillStyle = engGradL;
  ctx.shadowColor = '#ff6600';
  ctx.shadowBlur = 10 * engineFlicker;
  ctx.beginPath();
  ctx.moveTo(-12, 16); ctx.lineTo(-4, 16); ctx.lineTo(-8, 28 + engineFlicker * 10); ctx.closePath();
  ctx.fill();

  // Right engine
  const engGradR = ctx.createLinearGradient(8, 16, 8, 28 + engineFlicker * 10);
  engGradR.addColorStop(0, '#ff6600');
  engGradR.addColorStop(0.5, `rgba(255,${Math.floor(170 * engineFlicker)},0,0.8)`);
  engGradR.addColorStop(1, 'rgba(255,200,0,0)');
  ctx.fillStyle = engGradR;
  ctx.beginPath();
  ctx.moveTo(4, 16); ctx.lineTo(12, 16); ctx.lineTo(8, 28 + engineFlicker * 10); ctx.closePath();
  ctx.fill();

  // Center engine (smaller)
  const engGradC = ctx.createLinearGradient(0, 14, 0, 22 + engineFlicker * 7);
  engGradC.addColorStop(0, '#ffaa00');
  engGradC.addColorStop(1, 'rgba(255,170,0,0)');
  ctx.fillStyle = engGradC;
  ctx.beginPath();
  ctx.moveTo(-3, 14); ctx.lineTo(3, 14); ctx.lineTo(0, 22 + engineFlicker * 7); ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // ── Side wings (swept back, angular) ──
  ctx.fillStyle = '#2a4a7a';
  ctx.shadowColor = '#4a9eff';
  ctx.shadowBlur = 6;
  // Left wing
  ctx.beginPath();
  ctx.moveTo(-10, -4); ctx.lineTo(-28, 8); ctx.lineTo(-26, 18); ctx.lineTo(-14, 14); ctx.lineTo(-10, 6);
  ctx.closePath();
  ctx.fill();
  // Right wing
  ctx.beginPath();
  ctx.moveTo(10, -4); ctx.lineTo(28, 8); ctx.lineTo(26, 18); ctx.lineTo(14, 14); ctx.lineTo(10, 6);
  ctx.closePath();
  ctx.fill();

  // Wing trim lines
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1.2;
  ctx.shadowColor = '#4a9eff';
  ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.moveTo(-10, -4); ctx.lineTo(-28, 8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-14, 14); ctx.lineTo(-26, 18); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(10, -4); ctx.lineTo(28, 8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(14, 14); ctx.lineTo(26, 18); ctx.stroke();

  // ── Main hull body (elongated pointed diamond, ~40px tall, 28px wide) ──
  ctx.fillStyle = '#1a2a4a';
  ctx.shadowColor = '#4a9eff';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(0, -20);        // tip top
  ctx.lineTo(10, -8);        // upper right
  ctx.lineTo(14, 4);         // mid right
  ctx.lineTo(10, 14);        // lower right shoulder
  ctx.lineTo(0, 18);         // bottom center
  ctx.lineTo(-10, 14);       // lower left shoulder
  ctx.lineTo(-14, 4);        // mid left
  ctx.lineTo(-10, -8);       // upper left
  ctx.closePath();
  ctx.fill();

  // Outer hull neon lines
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = '#4a9eff';
  ctx.shadowBlur = 10;
  ctx.stroke();

  // Hull panel detail lines
  ctx.strokeStyle = 'rgba(74,158,255,0.4)';
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(-10, 10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(6, -2); ctx.lineTo(10, 10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(6, -2); ctx.stroke();

  // ── Cockpit (centered oval, neon blue glow) ──
  ctx.fillStyle = '#00ccff';
  ctx.shadowColor = '#00ccff';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.ellipse(0, -8, 5, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  // Inner cockpit highlight
  ctx.fillStyle = 'rgba(200,240,255,0.7)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.ellipse(-1, -11, 2, 3.5, -0.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.restore();
}

// ── Power-up orb rendering ────────────────────────────────────────────────────
function drawOrb(ctx, orb, now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);
  const colors = {
    laser:      { main: '#ffdd00', shadow: '#ffaa00', label: '⚡' },
    invincible: { main: '#ff44ff', shadow: '#cc00cc', label: '🛡' },
    freeze:     { main: '#44ddff', shadow: '#00aacc', label: '❄' },
  };
  const cfg = colors[orb.type] || colors.laser;

  ctx.save();
  // Outer glow ring
  ctx.shadowColor = cfg.shadow;
  ctx.shadowBlur = 15 + pulse * 10;
  ctx.strokeStyle = cfg.main;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(orb.x, orb.y, 15 + pulse * 2, 0, Math.PI * 2);
  ctx.stroke();

  // Filled circle
  ctx.fillStyle = `rgba(${hexToRgb(cfg.main)},${0.18 + pulse * 0.18})`;
  ctx.beginPath();
  ctx.arc(orb.x, orb.y, 15, 0, Math.PI * 2);
  ctx.fill();

  // Icon
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#ffffff';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.label, orb.x, orb.y);
  ctx.textBaseline = 'alphabetic';
  ctx.shadowBlur = 0;
  ctx.restore();
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

// ── Active power-up HUD bar ───────────────────────────────────────────────────
function drawPowerUpHUD(ctx, activePowerUp, now) {
  if (!activePowerUp) return;
  const remaining = (activePowerUp.endsAt - now / 1000).toFixed(1);
  if (remaining <= 0) return;

  const colors = {
    laser:      { bg: 'rgba(255,200,0,0.2)', border: '#ffdd00', text: '#ffdd00', label: '⚡ LASER' },
    invincible: { bg: 'rgba(255,68,255,0.2)', border: '#ff44ff', text: '#ff44ff', label: '🛡 INVINCIBLE' },
    freeze:     { bg: 'rgba(68,221,255,0.2)', border: '#44ddff', text: '#44ddff', label: '❄ FREEZE' },
  };
  const cfg = colors[activePowerUp.type] || colors.laser;

  const barW = 140, barH = 32;
  const bx = W - barW - 10, by = 34;

  ctx.save();
  ctx.fillStyle = cfg.bg;
  ctx.strokeStyle = cfg.border;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = cfg.border;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, barW, barH, 6);
  else ctx.rect(bx, by, barW, barH);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = cfg.text;
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.label, bx + 8, by + barH / 2 - 7);
  ctx.font = '10px monospace';
  ctx.fillText(`${remaining}s`, bx + 8, by + barH / 2 + 7);
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

export default function GalagaGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();
  const location = useLocation();

  const [phase, setPhase]       = useState(location.state?.autoQueue ? 'queue' : 'lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  useEffect(() => { if (location.state?.betCurrency) setBetCurrency(location.state.betCurrency); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [entryFee, setEntryFee] = useState(location.state?.entryFee ?? 0);
  const [opponent, setOpponent] = useState(null);
  const [roomId, setRoomId]     = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [result, setResult]     = useState(null);
  const [liveScore, setLiveScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [livesLeft, setLivesLeft] = useState(MAX_LIVES);
  const [dead, setDead]         = useState(false);
  const [isSolo, setIsSolo]     = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [privateCode, setPrivateCode] = useState('');
  const [shieldActive, setShieldActive] = useState(false);
  const [activePowerUpDisplay, setActivePowerUpDisplay] = useState(null);

  const canvasRef    = useRef(null);
  const oppScoreRef  = useRef(0);
  const isSoloRef    = useRef(false);
  const stateRef     = useRef(null);
  const phaseRef     = useRef('lobby');
  const roomIdRef    = useRef(null);
  const profileRef   = useRef(profile);
  const eloBeforeRef = useRef(null);
  const seedRef      = useRef(null);

  // 4-direction keysDown set (held-key tracking)
  const keysDown = useRef(new Set());

  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

  const { RejoinOverlay } = useGamePageRejoin('galaga', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('active'); },
    () => setPhase('lobby'),
  );

  // Start game after canvas mounts
  useEffect(() => {
    if (phase !== 'active' || seedRef.current === null) return;
    startGame(seedRef.current);
  }, [phase]);

  // Local countdown for solo endless mode
  useEffect(() => {
    if (phase !== 'countdown' || !isSoloRef.current) return;
    if (countdown <= 0) {
      setDead(false); setLiveScore(0); setLivesLeft(MAX_LIVES);
      setPhase('active');
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const isDiamonds = betCurrency === 'diamonds';
  const fees       = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel  = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const balance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && balance < entryFee;

  // ── Socket listeners ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    socket.on('galaga_match_found', ({ roomId: rid, opponent: opp, entryFee: fee }) => {
      eloBeforeRef.current = profileRef.current?.elo ?? null;
      setRoomId(rid); setOpponent(opp);
      setOppScore(0); oppScoreRef.current = 0;
      setPhase('countdown'); setCountdown(3);
    });

    socket.on('galaga_countdown', ({ count }) => {
      setCountdown(count);
    });

    socket.on('galaga_start', ({ seed }) => {
      seedRef.current = seed;
      setDead(false); setLiveScore(0); setLivesLeft(MAX_LIVES);
      setOppScore(0); oppScoreRef.current = 0;
      setPhase('active');
    });

    socket.on('galaga_opponent_score', ({ score: s }) => {
      oppScoreRef.current = s;
      setOppScore(s);
    });

    socket.on('galaga_result', (res) => {
      stopGame();
      setResult(res);
      setPhase('result');
      if (!res.isBotMode || res.entryFee > 0) refreshProfile();
    });

    socket.on('opponent_disconnected', (data = {}) => {
      stopGame();
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
        currency:       data.currency || 'coins',
        newWinnerElo:   data.newWinnerElo,
        newLoserElo:    data.newLoserElo,
      });
      setPhase('result');
      refreshProfile();
    });

    socket.on('private_room_created', ({ code }) => {
      setPrivateCode(code);
      setPhase('private_waiting');
    });

    return () => {
      socket.off('galaga_match_found');
      socket.off('galaga_countdown');
      socket.off('galaga_start');
      socket.off('galaga_result');
      socket.off('galaga_opponent_score');
      socket.off('opponent_disconnected');
      socket.off('private_room_created');
    };
  }, [socket]);

  // ── Game engine ───────────────────────────────────────────────────────────

  function stopGame() {
    const gs = stateRef.current;
    if (!gs) return;
    if (gs.animId) cancelAnimationFrame(gs.animId);
    if (gs.cleanup) gs.cleanup();
    stateRef.current = null;
    setShieldActive(false);
    setActivePowerUpDisplay(null);
  }

  function startGame(seed) {
    setShieldActive(false);
    setActivePowerUpDisplay(null);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const rand = makePRNG(seed);
    const diff = getDifficulty(0);
    const enemies = makeFormation(diff.rows, diff.cols);

    // Static star field (80 stars, computed once)
    const staticStars = Array.from({ length: 80 }, () => ({
      x: rand() * W,
      y: rand() * H,
      r: 0.5 + rand() * 1.0,   // radius 0.5–1.5
      b: 0.4 + rand() * 0.5,   // brightness
    }));

    // Scrolling star layers (parallax)
    const makeStarLayer = (count, minVy, maxVy, minB, maxB, maxSize) =>
      Array.from({ length: count }, () => ({
        x: rand() * W, y: rand() * H,
        b: minB + rand() * (maxB - minB),
        size: rand() < 0.2 ? maxSize : 1,
        vy: minVy + rand() * (maxVy - minVy),
      }));

    const gs = {
      ship: {
        x: W / 2, y: H - 60,
        alive: true,
        lives: MAX_LIVES,
        invincible: false,
        invincTimer: 0,
      },
      enemies,
      playerBullets: [],
      enemyBullets: [],
      score: 0,
      startTime: performance.now(),
      lastShot: 0,
      lastFrame: performance.now(),
      animId: null,
      rand,
      staticStars,
      starsBack:  makeStarLayer(60,  8, 20, 0.08, 0.25, 1.5),
      starsMid:   makeStarLayer(40, 22, 45, 0.25, 0.55, 2),
      starsFront: makeStarLayer(20, 48, 80, 0.5,  0.9,  2.5),
      particles: [],
      thrusterParticles: [],
      keys: {},
      mouseShoot: false,
      formDir: 1,
      formX: 0,
      formSpeed: diff.formSpeed,
      entryPhase: true,
      entryT: 0,
      wave: 0,
      shield: 0,
      shieldOrbs: [],
      lastOrbWave: -1,
      frameCount: 0,
      // Power-up state
      orb: null,              // { x, y, type } or null
      orbTimer: ORB_SPAWN_MIN + rand() * (ORB_SPAWN_MAX - ORB_SPAWN_MIN), // seconds until next spawn
      activePowerUp: null,    // { type, endsAt } (endsAt in seconds since game start)
    };

    stateRef.current = gs;

    // Key listeners — use keysDown Set for smooth held-key movement
    // Also keep gs.keys for Space/shoot compatibility
    function onKeyDown(e) {
      keysDown.current.add(e.key);
      gs.keys[e.code] = true;
      // Prevent page scroll for arrow keys and space
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
        e.preventDefault();
      }
    }
    function onKeyUp(e) {
      keysDown.current.delete(e.key);
      delete gs.keys[e.code];
    }
    function onMouseDown(e) { if (e.button === 0) gs.mouseShoot = true; }
    function onMouseUp(e)   { if (e.button === 0) gs.mouseShoot = false; }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup',   onMouseUp);

    gs.cleanup = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup',   onMouseUp);
      keysDown.current.clear();
    };

    function tick(now) {
      const dt = Math.min((now - gs.lastFrame) / 1000, 0.05);
      gs.lastFrame = now;
      gs.frameCount++;
      const { ship } = gs;
      const gameTimeSec = (now - gs.startTime) / 1000;

      // ── Entry animation: drop enemies to formation ──
      if (gs.entryPhase) {
        gs.entryT += dt * 0.8;
        const t = Math.min(gs.entryT, 1);
        for (const e of gs.enemies) {
          e.x = e.homeX + gs.formX;
          e.y = -200 - e.row * 60 + (e.homeY - (-200 - e.row * 60)) * t;
        }
        if (gs.entryT >= 1) gs.entryPhase = false;
      } else {
        // ── Formation drift ──
        gs.formX += gs.formDir * gs.formSpeed * dt;
        const liveEnemies = gs.enemies.filter(e => e.alive && !e.diving);
        if (liveEnemies.length > 0) {
          const leftmost  = Math.min(...liveEnemies.map(e => e.homeX + gs.formX));
          const rightmost = Math.max(...liveEnemies.map(e => e.homeX + gs.formX));
          if (rightmost > W - 60) gs.formDir = -1;
          if (leftmost  < 60)    gs.formDir =  1;
        }
        for (const e of gs.enemies) {
          if (e.alive && !e.diving) {
            e.x = e.homeX + gs.formX;
            e.y = e.homeY;
          }
        }

        // ── Dive initiation ──
        const curDiff = getDifficulty(gs.score);
        const currentDivers = gs.enemies.filter(e => e.alive && e.diving).length;
        const nonDiving = gs.enemies.filter(e => e.alive && !e.diving);
        for (const e of nonDiving) {
          if (currentDivers < curDiff.maxDivers && gs.rand() < curDiff.diveChance) {
            e.diving = true;
            e.diveT  = 0;
            e.diveStartX = e.x;
            e.diveStartY = e.y;
            e.diveCtrlX  = ship.x + (gs.rand() - 0.5) * 200;
            e.diveCtrlY  = H * 0.5;
            e.diveEndX   = ship.x + (gs.rand() - 0.5) * 80;
            e.diveEndY   = H + 40;
          }
        }

        // ── Dive movement ──
        const divingEnemies = gs.enemies.filter(e => e.alive && e.diving);
        for (const e of divingEnemies) {
          // Freeze power-up: stop enemy movement
          if (gs.activePowerUp && gs.activePowerUp.type === 'freeze' && gs.activePowerUp.endsAt > gameTimeSec) {
            // Frozen — skip movement
          } else {
            e.diveT += dt * 0.55;
            const t = Math.min(e.diveT, 1);
            const pos = quadBezier(e.diveStartX, e.diveStartY, e.diveCtrlX, e.diveCtrlY, e.diveEndX, e.diveEndY, t);
            e.x = pos.x; e.y = pos.y;
            if (e.diveT >= 1) {
              e.diving = false;
              e.diveT  = 0;
              e.x = e.homeX + gs.formX;
              e.y = e.homeY;
            }
          }
        }

        // ── Enemy shooting (scales with difficulty) ──
        // Freeze stops shooting too
        const isFrozen = gs.activePowerUp && gs.activePowerUp.type === 'freeze' && gs.activePowerUp.endsAt > gameTimeSec;
        if (!isFrozen) {
          const shooters = gs.enemies.filter(e => e.alive && e.diving);
          for (const e of shooters) {
            if (gs.rand() < curDiff.shootChance) {
              gs.enemyBullets.push({ x: e.x, y: e.y + 10, vy: curDiff.bulletSpeed });
            }
          }
          const aliveList = gs.enemies.filter(e => e.alive);
          if (aliveList.length > 0 && gs.rand() < 0.003 * (1 + curDiff.level * 0.2)) {
            const shooter = aliveList[Math.floor(gs.rand() * aliveList.length)];
            gs.enemyBullets.push({ x: shooter.x, y: shooter.y + 10, vy: curDiff.bulletSpeed });
          }
        }
      }

      // ── Formation drift also frozen ──
      if (gs.activePowerUp && gs.activePowerUp.type === 'freeze' && gs.activePowerUp.endsAt > gameTimeSec) {
        // formation enemies stay put (already set above, no further drift applied)
      }

      // ── Shield orbs — move and pulse ──
      for (const orb of gs.shieldOrbs) {
        orb.y += orb.vy * dt;
        orb.pulse += dt * 3;
      }

      // Player bullets hit shield orb — collect
      for (const b of gs.playerBullets) {
        for (const orb of gs.shieldOrbs) {
          if (Math.hypot(b.x - orb.x, b.y - orb.y) < 18) {
            orb.y = 9999;
            b.y = -9999;
            gs.shield = 1;
            setShieldActive(true);
          }
        }
      }
      gs.shieldOrbs = gs.shieldOrbs.filter(o => o.y < H + 30);

      // ── Power-up orb spawn timer ──
      if (!gs.orb) {
        gs.orbTimer -= dt;
        if (gs.orbTimer <= 0) {
          gs.orb = {
            x: 40 + gs.rand() * (W - 80),
            y: -20,
            type: ORB_TYPES[Math.floor(gs.rand() * ORB_TYPES.length)],
          };
          gs.orbTimer = ORB_SPAWN_MIN + gs.rand() * (ORB_SPAWN_MAX - ORB_SPAWN_MIN);
        }
      }

      // ── Power-up orb movement ──
      if (gs.orb) {
        gs.orb.y += ORB_FALL_SPEED * dt;
        if (gs.orb.y > H + 30) {
          gs.orb = null; // fell off screen
        }
      }

      // ── Power-up orb collision with player ──
      if (gs.orb && ship.alive) {
        const dist = Math.hypot(ship.x - gs.orb.x, ship.y - gs.orb.y);
        if (dist < ORB_COLLECT_DIST) {
          const type = gs.orb.type;
          gs.orb = null;
          let duration = POWERUP_LASER_DURATION;
          if (type === 'invincible') duration = POWERUP_INVINCIBLE_DURATION;
          else if (type === 'freeze') duration = POWERUP_FREEZE_DURATION;
          gs.activePowerUp = { type, endsAt: gameTimeSec + duration };
          setActivePowerUpDisplay({ type, endsAt: gameTimeSec + duration });
          // Visual feedback particles
          const orbColor = type === 'laser' ? '#ffdd00' : type === 'invincible' ? '#ff44ff' : '#44ddff';
          for (let p = 0; p < 12; p++) {
            const angle = (p / 12) * Math.PI * 2;
            const spd = 60 + gs.rand() * 100;
            gs.particles.push({ x: ship.x, y: ship.y, vx: Math.cos(angle)*spd, vy: Math.sin(angle)*spd, life: 1, color: orbColor, size: 2 + gs.rand() * 2, ring: false });
          }
        }
      }

      // ── Power-up expiry ──
      if (gs.activePowerUp && gs.activePowerUp.endsAt <= gameTimeSec) {
        gs.activePowerUp = null;
        setActivePowerUpDisplay(null);
      }

      // ── 4-Direction ship movement ──
      if (ship.alive) {
        if (keysDown.current.has('ArrowLeft') || keysDown.current.has('a') || keysDown.current.has('A'))
          ship.x = Math.max(20, ship.x - SHIP_SPEED);
        if (keysDown.current.has('ArrowRight') || keysDown.current.has('d') || keysDown.current.has('D'))
          ship.x = Math.min(W - 20, ship.x + SHIP_SPEED);
        if (keysDown.current.has('ArrowUp') || keysDown.current.has('w') || keysDown.current.has('W'))
          ship.y = Math.max(H * 0.55, ship.y - SHIP_SPEED);  // constrain to bottom 45%
        if (keysDown.current.has('ArrowDown') || keysDown.current.has('s') || keysDown.current.has('S'))
          ship.y = Math.min(H - 30, ship.y + SHIP_SPEED);

        if (ship.invincible) {
          ship.invincTimer -= dt;
          if (ship.invincTimer <= 0) ship.invincible = false;
        }

        // Invincible power-up — acts as extended invincibility
        const isInvincPU = gs.activePowerUp && gs.activePowerUp.type === 'invincible' && gs.activePowerUp.endsAt > gameTimeSec;

        // Shoot — laser power-up fires 3 shots
        if ((gs.mouseShoot || gs.keys['Space']) && now - gs.lastShot > FIRE_CD * 1000) {
          gs.lastShot = now;
          const isLaser = gs.activePowerUp && gs.activePowerUp.type === 'laser' && gs.activePowerUp.endsAt > gameTimeSec;
          if (isLaser) {
            // 3 shots: center, left, right
            gs.playerBullets.push({ x: ship.x,      y: ship.y - 15, vy: -BULLET_SPEED });
            gs.playerBullets.push({ x: ship.x - 14, y: ship.y - 10, vy: -BULLET_SPEED });
            gs.playerBullets.push({ x: ship.x + 14, y: ship.y - 10, vy: -BULLET_SPEED });
          } else {
            gs.playerBullets.push({ x: ship.x, y: ship.y - 15, vy: -BULLET_SPEED });
          }
        }

        // ── Thruster trail particles ──
        if (gs.frameCount % 3 === 0) {
          const flicker = gs.frameCount % 6;
          const colors = ['#ff6600', '#ffaa00', '#ff8800', '#ff5500', '#ffcc00'];
          gs.thrusterParticles.push({
            x: ship.x + (gs.rand() - 0.5) * 10,
            y: ship.y + 14 + gs.rand() * 6,
            vx: (gs.rand() - 0.5) * 15,
            vy: 30 + gs.rand() * 40,
            life: 0.5 + gs.rand() * 0.3,
            color: colors[flicker % colors.length],
            size: 1.5 + gs.rand() * 2,
          });
          // Limit thruster particles count
          if (gs.thrusterParticles.length > 40) gs.thrusterParticles.splice(0, 5);
        }
      }

      // ── Update thruster particles ──
      for (const p of gs.thrusterParticles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt * 2.5;
      }
      gs.thrusterParticles = gs.thrusterParticles.filter(p => p.life > 0);

      // ── Move player bullets ──
      for (const b of gs.playerBullets) { b.y += b.vy * dt; }
      gs.playerBullets = gs.playerBullets.filter(b => b.y > -20);

      // ── Move enemy bullets ──
      for (const b of gs.enemyBullets) { b.y += b.vy * dt; }
      gs.enemyBullets = gs.enemyBullets.filter(b => b.y < H + 20);

      // ── Player bullet vs enemy collision ──
      for (const b of gs.playerBullets) {
        for (const e of gs.enemies) {
          if (!e.alive) continue;
          const dist = Math.hypot(b.x - e.x, b.y - e.y);
          const hitR = e.type === 'boss' ? 18 : e.type === 'butterfly' ? 15 : 13;
          if (dist < hitR) {
            e.alive = false;
            b.y = -9999;
            const pts = e.type === 'boss' ? 200 : e.type === 'butterfly' ? 100 : 50;
            gs.score += pts;
            setLiveScore(gs.score);
            if (socket && roomIdRef.current) socket.emit('galaga_score_ping', { roomId: roomIdRef.current, score: gs.score });
            const col = enemyColor(e.type);
            for (let p = 0; p < 16; p++) {
              const angle = (p / 16) * Math.PI * 2 + gs.rand() * 0.5;
              const spd = 60 + gs.rand() * 150;
              gs.particles.push({
                x: e.x, y: e.y,
                vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
                life: 1, color: col, size: 2 + gs.rand() * 3,
                ring: false,
              });
            }
            gs.particles.push({
              x: e.x, y: e.y,
              vx: 0, vy: 0,
              life: 1, color: col, size: 4,
              ring: true, ringR: 0,
            });
          }
        }
      }

      // ── Enemy bullet vs ship collision ──
      const isInvincPU = gs.activePowerUp && gs.activePowerUp.type === 'invincible' && gs.activePowerUp.endsAt > gameTimeSec;
      if (ship.alive && !ship.invincible && !isInvincPU) {
        for (const b of gs.enemyBullets) {
          const dist = Math.hypot(b.x - ship.x, b.y - ship.y);
          if (dist < 15) {
            b.y = 9999;
            if (gs.shield > 0) {
              gs.shield = 0;
              setShieldActive(false);
              for (let p = 0; p < 8; p++) {
                const angle = (p / 8) * Math.PI * 2;
                gs.particles.push({
                  x: ship.x, y: ship.y,
                  vx: Math.cos(angle) * 80, vy: Math.sin(angle) * 80,
                  life: 0.8, color: '#00ccff', size: 2.5, ring: false,
                });
              }
            } else {
              ship.lives--;
              setLivesLeft(ship.lives);
              if (ship.lives <= 0) {
                ship.alive = false;
                if (isSoloRef.current) {
                  const finalScore = gs.score;
                  cancelAnimationFrame(gs.animId);
                  gs.animId = null;
                  setTimeout(() => { setResult({ isSolo: true, isEndless: true, score: finalScore }); setPhase('result'); }, 800);
                } else {
                  const rid = roomIdRef.current;
                  if (rid && socket) socket.emit('galaga_died', { roomId: rid, score: gs.score });
                  setDead(true);
                }
              } else {
                ship.invincible   = true;
                ship.invincTimer  = INVINC_T;
                ship.x = W / 2;
              }
            }
            break;
          }
        }
      }

      // ── Enemy dive vs ship collision ──
      if (ship.alive && !ship.invincible && !isInvincPU) {
        for (const e of gs.enemies) {
          if (!e.alive || !e.diving) continue;
          const dist = Math.hypot(e.x - ship.x, e.y - ship.y);
          if (dist < 22) {
            e.alive = false;
            if (gs.shield > 0) {
              gs.shield = 0;
              setShieldActive(false);
              for (let p = 0; p < 8; p++) {
                const angle = (p / 8) * Math.PI * 2;
                gs.particles.push({ x: ship.x, y: ship.y, vx: Math.cos(angle)*80, vy: Math.sin(angle)*80, life: 0.8, color: '#00ccff', size: 2.5, ring: false });
              }
            } else {
              ship.lives--;
              setLivesLeft(ship.lives);
              if (ship.lives <= 0) {
                ship.alive = false;
                if (isSoloRef.current) {
                  const finalScore = gs.score;
                  cancelAnimationFrame(gs.animId);
                  gs.animId = null;
                  setTimeout(() => { setResult({ isSolo: true, isEndless: true, score: finalScore }); setPhase('result'); }, 800);
                } else {
                  const rid = roomIdRef.current;
                  if (rid && socket) socket.emit('galaga_died', { roomId: rid, score: gs.score });
                  setDead(true);
                }
              } else {
                ship.invincible  = true;
                ship.invincTimer = INVINC_T;
                ship.x = W / 2;
              }
            }
            break;
          }
        }
      }

      // ── Check all enemies cleared — respawn wave ──
      const anyAlive = gs.enemies.some(e => e.alive);
      if (!anyAlive && !gs.entryPhase) {
        gs.wave++;
        const bonus = 500 + gs.wave * 100;
        gs.score += bonus;
        setLiveScore(gs.score);
        if (socket && roomIdRef.current) socket.emit('galaga_score_ping', { roomId: roomIdRef.current, score: gs.score });
        gs.bonusText = { text: `FORMATION CLEARED! +${bonus}`, life: 1.4 };
        const waveDiff = getDifficulty(gs.score);
        gs.formSpeed = waveDiff.formSpeed + gs.wave * 3;
        const fresh = makeFormation(waveDiff.rows, waveDiff.cols);
        gs.enemies = fresh;
        gs.entryT  = 0;
        gs.entryPhase = true;
        gs.formX = 0;
        if (gs.wave % 3 === 0 && gs.wave !== gs.lastOrbWave && gs.shield < 1) {
          gs.lastOrbWave = gs.wave;
          gs.shieldOrbs.push({
            x: 80 + gs.rand() * (W - 160),
            y: -20,
            vy: 90,
            pulse: 0,
          });
        }
      }

      // ── Scroll stars — 3 layers ──
      for (const layer of [gs.starsBack, gs.starsMid, gs.starsFront]) {
        for (const st of layer) {
          st.y += st.vy * dt;
          if (st.y > H + 4) { st.y = -4; st.x = gs.rand() * W; }
        }
      }

      // ── Update particles ──
      for (const p of gs.particles) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (!p.ring) p.vy += 80 * dt;
        p.life -= dt * 2;
      }
      gs.particles = gs.particles.filter(p => p.life > 0);

      // ── DRAW ─────────────────────────────────────────────────────────────────

      // Background — dark space
      ctx.fillStyle = '#000008';
      ctx.fillRect(0, 0, W, H);

      // Static stars (background layer)
      for (const st of gs.staticStars) {
        ctx.fillStyle = `rgba(255,255,255,${st.b})`;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Scrolling parallax stars
      for (const layer of [gs.starsBack, gs.starsMid, gs.starsFront]) {
        for (const st of layer) {
          ctx.fillStyle = `rgba(255,255,255,${st.b})`;
          ctx.fillRect(st.x, st.y, st.size, st.size);
        }
      }

      // Freeze overlay tint
      const isFrozenDraw = gs.activePowerUp && gs.activePowerUp.type === 'freeze' && gs.activePowerUp.endsAt > gameTimeSec;
      if (isFrozenDraw) {
        ctx.fillStyle = 'rgba(50,200,255,0.04)';
        ctx.fillRect(0, 0, W, H);
      }

      // Enemies
      for (const e of gs.enemies) {
        if (e.alive) drawEnemy(ctx, e, gs.frameCount);
      }

      // Player bullets — dual laser beams with glow
      for (const b of gs.playerBullets) {
        const isLaserShot = gs.activePowerUp && gs.activePowerUp.type === 'laser' && gs.activePowerUp.endsAt > gameTimeSec;
        const bulletColor = isLaserShot ? '#ffee44' : '#00ff99';
        const bulletGlow  = isLaserShot ? '#ffcc00' : '#00ff99';
        const grad = ctx.createLinearGradient(b.x, b.y, b.x, b.y - 18);
        grad.addColorStop(0, `rgba(0,0,0,0)`);
        grad.addColorStop(0.4, `${bulletColor}dd`);
        grad.addColorStop(1, '#ffffff');
        ctx.fillStyle = grad;
        ctx.shadowColor = bulletGlow;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.roundRect(b.x - 2, b.y - 18, 4, 18, 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.roundRect(b.x - 1, b.y - 16, 2, 14, 1);
        ctx.fill();
      }

      // Enemy bullets — orange plasma blobs
      for (const b of gs.enemyBullets) {
        ctx.fillStyle = '#ff6600';
        ctx.shadowColor = '#ff4400';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.ellipse(b.x, b.y, 3, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffcc00';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.ellipse(b.x, b.y, 1.5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // Old shield orbs
      for (const orb of gs.shieldOrbs) {
        const orbPulse = 0.5 + 0.5 * Math.sin(orb.pulse);
        ctx.shadowColor = '#00eeff';
        ctx.shadowBlur = 12 + orbPulse * 10;
        ctx.strokeStyle = '#00eeff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, 14 + orbPulse * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(0,200,255,${0.15 + orbPulse * 0.2})`;
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 4;
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🛡', orb.x, orb.y);
        ctx.textBaseline = 'alphabetic';
        ctx.shadowBlur = 0;
      }

      // Power-up orb
      if (gs.orb) {
        drawOrb(ctx, gs.orb, now);
      }

      // Player ship
      drawPlayerShip(ctx, ship, now, gs.frameCount, gs.thrusterParticles);

      // Invincible power-up flash effect (purple outline)
      const isInvincDraw = gs.activePowerUp && gs.activePowerUp.type === 'invincible' && gs.activePowerUp.endsAt > gameTimeSec;
      if (isInvincDraw && ship.alive) {
        const invFlash = Math.floor(now / 120) % 2 === 0;
        if (invFlash) {
          ctx.strokeStyle = '#ff44ff';
          ctx.shadowColor = '#ff44ff';
          ctx.shadowBlur = 16;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(ship.x, ship.y, 30, 0, Math.PI * 2);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }

      // Shield aura
      if (gs.shield > 0 && ship.alive) {
        const shieldPulse = 0.5 + 0.5 * Math.sin(now / 150);
        ctx.strokeStyle = `rgba(0,200,255,${0.5 + shieldPulse * 0.4})`;
        ctx.shadowColor = '#00ccff';
        ctx.shadowBlur = 18 + shieldPulse * 8;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(ship.x, ship.y, 28, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // HUD
      const hudDiff = getDifficulty(gs.score);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`Score: ${gs.score}`, 12, 24);
      ctx.textAlign = 'right';
      ctx.fillText(`Wave: ${gs.wave + 1}  Lv ${hudDiff.level + 1}`, W - 12, 24);
      ctx.textAlign = 'center';

      // Lives — mini ship icons
      for (let i = 0; i < ship.lives; i++) {
        const lx = W / 2 - (ship.lives - 1) * 16 + i * 32;
        const ly = H - 16;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.fillStyle = '#1a2a4a';
        ctx.shadowColor = '#4a9eff';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(0, -9); ctx.lineTo(4, -4); ctx.lineTo(6, 2);
        ctx.lineTo(0, 6); ctx.lineTo(-6, 2); ctx.lineTo(-4, -4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      ctx.shadowBlur = 0;

      // Active power-up HUD bar (top-right)
      drawPowerUpHUD(ctx, gs.activePowerUp, gameTimeSec);

      // Particles
      for (const p of gs.particles) {
        ctx.globalAlpha = Math.max(0, p.life);
        if (p.ring) {
          p.ringR += 80 * dt;
          ctx.strokeStyle = p.color;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 6;
          ctx.lineWidth = 2 * p.life;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.ringR, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = p.color;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Formation clear bonus text
      if (gs.bonusText) {
        gs.bonusText.life -= dt * 0.8;
        const a = Math.min(1, gs.bonusText.life);
        const rise = (1.4 - gs.bonusText.life) * 55;
        ctx.save();
        ctx.globalAlpha = Math.max(0, a);
        ctx.font = 'bold 26px monospace';
        ctx.textAlign = 'center';
        ctx.shadowColor = '#00d4ff';
        ctx.shadowBlur = 22;
        ctx.fillStyle = '#00d4ff';
        ctx.fillText(gs.bonusText.text, W / 2, H / 2 - rise);
        ctx.shadowBlur = 0;
        ctx.restore();
        if (gs.bonusText.life <= 0) gs.bonusText = null;
      }

      gs.animId = requestAnimationFrame(tick);
    }

    gs.animId = requestAnimationFrame(tick);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_galaga_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_galaga_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playSolo() {
    isSoloRef.current = true;
    setIsSolo(true);
    seedRef.current = Date.now();
    setOpponent(null);
    setResult(null);
    setDead(false); setLiveScore(0); setLivesLeft(MAX_LIVES);
    setOppScore(0); oppScoreRef.current = 0;
    setPhase('countdown'); setCountdown(3);
  }
  function leaveQueue() {
    socket.emit('leave_galaga_queue'); setPhase('lobby'); setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'galaga', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'galaga', code });
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
    if (isSoloRef.current) {
      playSolo();
      return;
    }
    if (result?.isBotMode) {
      playVsBot();
      return;
    }
    socket.emit('galaga_rematch_request', { roomId });
    setResult(null); setPhase('countdown'); setDead(false); setLiveScore(0); setLivesLeft(MAX_LIVES);
    setStatusMsg('Waiting for opponent...');
  }
  function backToLobby() {
    stopGame(); setPhase('lobby'); setResult(null);
    isSoloRef.current = false; setIsSolo(false);
    setOpponent(null); setRoomId(null); setDead(false); setLiveScore(0); setLivesLeft(MAX_LIVES); setStatusMsg('');
    setShieldActive(false);
    setActivePowerUpDisplay(null);
  }

  const isWinner = result && result.winnerId === profile?.id;

  // ── Render ────────────────────────────────────────────────────────────────

  const _randomQueueFired = useRef(false);
  useEffect(() => {
    if (!location.state?.autoQueue || _randomQueueFired.current || !authenticated || !socket) return;
    _randomQueueFired.current = true;
    joinQueue();
  }, [socket, authenticated]);

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {RejoinOverlay}

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="👾 Space Wars"
          description="Shoot down waves of diving enemies — last pilot standing wins"
          controls="WASD / Arrows move — Left Click or Space shoot — 3 lives — collect power-up orbs!"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={balance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playSolo}
          botLabel="👾 Bet vs Bot"
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
          {countdown > 0 ? (
            <>
              <div key={countdown} className="text-8xl font-black text-primary mb-4 animate-countdown-pop" style={{ textShadow: '0 0 40px #1E90FF' }}>
                {countdown}
              </div>
              <p className="text-muted">Get ready...</p>
              {opponent && <p className="text-xs text-muted mt-2">vs {opponent.username}</p>}
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
        <div className="flex flex-col items-center gap-3 animate-fade-in w-full">
          <div className="flex items-center justify-between w-full" style={{ maxWidth: `${W}px` }}>
            {/* My score */}
            <div className="flex flex-col items-start min-w-[90px]">
              <span className="text-xs text-muted uppercase tracking-wide">Score</span>
              <span className="text-xl font-black font-mono text-success">{liveScore}</span>
            </div>
            {/* Center: lives + mode label + power-up + shield */}
            <div className="flex flex-col items-center gap-1">
              <div className="flex gap-1">
                {Array.from({ length: MAX_LIVES }).map((_, i) => (
                  <span key={i} className={`text-lg ${i < livesLeft ? 'opacity-100' : 'opacity-20'}`}>🚀</span>
                ))}
              </div>
              {isSolo
                ? <span className="text-xs text-muted">Solo Endless</span>
                : <span className="text-xs text-accent font-bold">Score Race</span>
              }
              {shieldActive && (
                <span className="text-xs font-bold" style={{ color: '#00eeff', textShadow: '0 0 8px #00eeff' }}>
                  🛡 SHIELD
                </span>
              )}
              {activePowerUpDisplay && (
                <span className="text-xs font-bold" style={{
                  color: activePowerUpDisplay.type === 'laser' ? '#ffdd00'
                       : activePowerUpDisplay.type === 'invincible' ? '#ff44ff'
                       : '#44ddff',
                }}>
                  {activePowerUpDisplay.type === 'laser' ? '⚡ LASER'
                   : activePowerUpDisplay.type === 'invincible' ? '🛡 INVINCIBLE'
                   : '❄ FREEZE'}
                </span>
              )}
            </div>
            {/* Opponent score (hidden in solo) */}
            {isSolo ? <div className="min-w-[90px]" /> : (
              <div className="flex flex-col items-end min-w-[90px]">
                <span className="text-xs text-muted uppercase tracking-wide">{opponent?.username ?? 'Opp'}</span>
                <span className={`text-xl font-black font-mono ${oppScore > liveScore ? 'text-danger' : oppScore < liveScore ? 'text-success' : 'text-accent'}`}>{oppScore}</span>
              </div>
            )}
          </div>
          {dead && (
            <div className="text-danger font-bold text-sm animate-pulse">
              Ship destroyed! Waiting for opponent...
            </div>
          )}
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className="rounded-xl border border-surfaceLight shadow-2xl"
            style={{ maxWidth: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
          />
          <p className="text-muted text-xs hidden md:block">WASD / Arrows move — Space or Click shoot — collect ⚡🛡❄ power-ups!</p>

          {/* Mobile touch controls */}
          <div className="md:hidden w-full mt-3 select-none">
            <div className="grid grid-cols-3 gap-3">
              <button
                onPointerDown={() => { if (stateRef.current) stateRef.current.keys['ArrowLeft'] = true; keysDown.current.add('ArrowLeft'); }}
                onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['ArrowLeft']; keysDown.current.delete('ArrowLeft'); }}
                onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['ArrowLeft']; keysDown.current.delete('ArrowLeft'); }}
                className="py-6 rounded-xl bg-surfaceLight border border-border text-white text-3xl font-bold active:bg-primary/30 touch-none"
              >←</button>
              <button
                onPointerDown={() => { if (stateRef.current) stateRef.current.mouseShoot = true; }}
                onPointerUp={() => { if (stateRef.current) stateRef.current.mouseShoot = false; }}
                onPointerLeave={() => { if (stateRef.current) stateRef.current.mouseShoot = false; }}
                className="py-6 rounded-xl bg-danger/20 border border-danger/40 text-danger text-2xl font-bold active:bg-danger/40 touch-none"
              >🔥</button>
              <button
                onPointerDown={() => { if (stateRef.current) stateRef.current.keys['ArrowRight'] = true; keysDown.current.add('ArrowRight'); }}
                onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['ArrowRight']; keysDown.current.delete('ArrowRight'); }}
                onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['ArrowRight']; keysDown.current.delete('ArrowRight'); }}
                className="py-6 rounded-xl bg-surfaceLight border border-border text-white text-3xl font-bold active:bg-primary/30 touch-none"
              >→</button>
            </div>
          </div>
        </div>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-surface border border-surfaceLight rounded-3xl p-8 text-center animate-scale-in shadow-2xl overflow-y-auto max-h-[90vh]">
          {result.isBotMode ? (
            <>
              <div className="text-7xl mb-4 animate-pop-in">{result.humanWon ? '🏆' : '👾'}</div>
              <h2 className={`text-4xl font-black mb-2 ${result.humanWon ? 'text-success' : 'text-danger'}`}>
                {result.humanWon ? 'You Won!' : 'You Lost!'}
              </h2>
              <div className="bg-bg rounded-xl p-4 mb-4 text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted">Your Score</span>
                  <span className="text-white font-bold">{(result.playerScore ?? 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Bot Target</span>
                  <span className="text-muted font-bold">{(result.botTargetScore ?? 0).toLocaleString()}</span>
                </div>
                {result.balanceChange && (
                  <div className="flex justify-between">
                    <span className="text-muted">{result.humanWon ? 'Payout' : 'Entry lost'}</span>
                    <span className={result.humanWon ? 'text-success font-bold' : 'text-danger font-bold'}>
                      {result.humanWon
                        ? result.currency === 'diamonds'
                          ? `+${Math.round(result.balanceChange.winnerPayout)} 💎`
                          : <span className="inline-flex items-center gap-1">+{result.balanceChange.winnerPayout.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})} <CoinIcon size="0.8em" /></span>
                        : result.currency === 'diamonds'
                          ? `-${result.entryFee ?? 0} 💎`
                          : <span className="inline-flex items-center gap-1">-{result.entryFee ?? 0} <CoinIcon size="0.8em" /></span>}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-3">
                <GlowButton onClick={requestRematch} variant="primary" size="lg" className="w-full">Play Again</GlowButton>
                <GlowButton onClick={backToLobby} variant="ghost" size="lg" className="w-full border border-border">Back to Lobby</GlowButton>
                <GlowButton onClick={() => { window.location.href = '/'; }} variant="ghost" size="lg" className="w-full border border-border">Home</GlowButton>
              </div>
            </>
          ) : result.isSolo ? (
            <>
              <div className="text-7xl mb-4 animate-pop-in">👾</div>
              <h2 className="text-4xl font-black mb-2 animate-pop-in text-primary" style={{ animationDelay: '0.1s' }}>
                Game Over
              </h2>
              <div className="bg-bg rounded-xl p-5 mb-6">
                <p className="text-muted text-xs mb-1 uppercase tracking-wide">Final Score</p>
                <p className="text-white font-black text-4xl font-mono">{result.score.toLocaleString()}</p>
              </div>
              <div className="flex flex-col gap-3">
                <GlowButton onClick={requestRematch} variant="primary" size="lg" className="w-full">
                  Play Again
                </GlowButton>
                <GlowButton onClick={backToLobby} variant="ghost" size="lg" className="w-full border border-border">
                  Back to Lobby
                </GlowButton>
                <GlowButton onClick={() => { window.location.href = '/'; }} variant="ghost" size="lg" className="w-full border border-border">
                  Home
                </GlowButton>
              </div>
            </>
          ) : (
            <>
              <div className="text-7xl mb-4 animate-pop-in">
                {isWinner ? '🏆' : '💀'}
              </div>
              <h2 className={`text-4xl font-black mb-2 animate-pop-in ${isWinner ? 'text-success' : 'text-danger'}`} style={{ animationDelay: '0.1s' }}>
                {isWinner ? 'You Win!' : 'You Lose'}
              </h2>
              {result.disconnected && (
                <p className="text-sm text-muted mb-3">Opponent disconnected</p>
              )}

              <div className="bg-bg rounded-xl p-5 mb-6">
                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <div>
                    <p className="text-muted text-xs mb-1">{result.winnerUsername}</p>
                    <p className="text-white font-bold text-lg">{isWinner ? result.winnerScore ?? '—' : result.loserScore ?? '—'} pts</p>
                  </div>
                  <div>
                    <p className="text-muted text-xs mb-1">{result.loserUsername}</p>
                    <p className="text-white font-bold text-lg">{result.loserScore ?? '—'} pts</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-xs border-t border-border pt-3">
                  <div>
                    <p className="text-muted">ELO</p>
                    <p className="text-white font-semibold">
                      {isWinner ? result.newWinnerElo : result.newLoserElo}
                      {eloBeforeRef.current != null && (
                        <span className={`ml-1 ${isWinner ? 'text-success' : 'text-danger'}`}>
                          ({isWinner
                            ? `+${result.newWinnerElo - eloBeforeRef.current}`
                            : `${result.newLoserElo - eloBeforeRef.current}`})
                        </span>
                      )}
                    </p>
                  </div>
                  {(result.balanceChange?.winnerPayout ?? 0) > 0 && (
                    <div>
                      <p className="text-muted">Balance</p>
                      <p className={`font-semibold ${isWinner ? 'text-success' : 'text-danger'}`}>
                        {isWinner
                          ? result.currency === 'diamonds'
                            ? `+${Math.round(result.balanceChange.winnerPayout ?? 0)} 💎`
                            : <span className="inline-flex items-center gap-1">+{(result.balanceChange.winnerPayout ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <CoinIcon size="0.8em" /></span>
                          : result.currency === 'diamonds'
                            ? `-${result.entryFee ?? 0} 💎`
                            : <span className="inline-flex items-center gap-1">-{result.entryFee ?? 0} <CoinIcon size="0.8em" /></span>}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <GlowButton onClick={requestRematch} variant="primary" size="lg" className="w-full">
                  Rematch
                </GlowButton>
                <GlowButton onClick={backToLobby} variant="ghost" size="lg" className="w-full border border-border">
                  Back to Lobby
                </GlowButton>
                <GlowButton onClick={() => { window.location.href = '/'; }} variant="ghost" size="lg" className="w-full border border-border">
                  Home
                </GlowButton>
              </div>
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}


