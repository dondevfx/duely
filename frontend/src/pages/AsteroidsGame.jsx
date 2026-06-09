import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import { useGamePageRejoin } from '../hooks/useGamePageRejoin';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

const W = 860, H = 580;
const ROTATE_SPEED = 4.2;   // rad/s
const THRUST       = 370;   // px/s²
const FRICTION     = 0.97;  // velocity damping per frame
const BULLET_SPEED = 520;   // px/s
const FIRE_CD      = 0.22;  // seconds between shots
const INVULN_T     = 2.5;   // seconds after respawn
const SHIP_R       = 14;

// Asteroid size levels: { radius, points, splits }
const A_LEVELS = [
  { radius: 42, points: 100, splits: 2 },
  { radius: 24, points:  50, splits: 2 },
  { radius: 11, points:  25, splits: 0 },
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

function spawnAsteroid(rand, level, x, y) {
  const angle = rand() * Math.PI * 2;
  const speed = A_LEVELS[level].radius === 42
    ? 35 + rand() * 30
    : A_LEVELS[level].radius === 24
      ? 55 + rand() * 40
      : 80 + rand() * 50;
  const sides = 7 + Math.floor(rand() * 5);
  const bumps = Array.from({ length: sides }, () => 0.75 + rand() * 0.5);
  return {
    x: x ?? (rand() < 0.5 ? rand() * W * 0.3 : W - rand() * W * 0.3),
    y: y ?? (rand() < 0.5 ? rand() * H * 0.3 : H - rand() * H * 0.3),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    rot: rand() * Math.PI * 2,
    rotSpeed: (rand() - 0.5) * 1.4,
    level,
    bumps,
    id: rand(),
  };
}

function wrap(x, y) {
  return { x: ((x % W) + W) % W, y: ((y % H) + H) % H };
}

function drawShip(ctx, x, y, angle, thrusting, invuln, now) {
  if (invuln && Math.floor(now / 80) % 2 === 0) return; // blink
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // Engine exhaust
  if (thrusting) {
    const fl = 0.5 + 0.5 * Math.sin(now / 40);
    ctx.shadowColor = '#ff8800';
    ctx.shadowBlur  = 14;
    ctx.fillStyle   = `rgba(255,${100 + fl * 100},0,${0.7 + fl * 0.3})`;
    ctx.beginPath();
    ctx.moveTo(-7, SHIP_R * 0.6);
    ctx.lineTo(0, SHIP_R * 1.5 + fl * 8);
    ctx.lineTo(7, SHIP_R * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  // Hull
  ctx.shadowColor = '#44aaff';
  ctx.shadowBlur  = 12;
  ctx.fillStyle   = '#1a6dcc';
  ctx.beginPath();
  ctx.moveTo(0, -SHIP_R - 3);
  ctx.lineTo(SHIP_R - 2, SHIP_R + 2);
  ctx.lineTo(SHIP_R * 0.35, SHIP_R * 0.5);
  ctx.lineTo(0, SHIP_R - 2);
  ctx.lineTo(-SHIP_R * 0.35, SHIP_R * 0.5);
  ctx.lineTo(-(SHIP_R - 2), SHIP_R + 2);
  ctx.closePath();
  ctx.fill();

  // Cockpit
  ctx.fillStyle   = '#88ccff';
  ctx.shadowColor = '#aaddff';
  ctx.shadowBlur  = 8;
  ctx.beginPath();
  ctx.ellipse(0, -SHIP_R * 0.15, 5, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wing accents
  ctx.fillStyle   = '#2299ff';
  ctx.shadowBlur  = 4;
  ctx.fillRect(-SHIP_R + 2, 4, 9, 3);
  ctx.fillRect(SHIP_R - 11, 4, 9, 3);

  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawAsteroid(ctx, a) {
  const lv = A_LEVELS[a.level];
  const colors = ['#8a7a6a', '#7a8a6a', '#9a8a5a'];
  const edgeC  = ['#c4b49a', '#aac49a', '#c4c49a'];
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(a.rot);

  // Rocky shadow
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur  = 8;
  ctx.fillStyle   = colors[a.level] ?? '#8a7a6a';
  ctx.beginPath();
  for (let i = 0; i < a.bumps.length; i++) {
    const ang = (i / a.bumps.length) * Math.PI * 2;
    const r = lv.radius * a.bumps[i];
    i === 0 ? ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r)
            : ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
  }
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = edgeC[a.level] ?? '#c4b49a';
  ctx.lineWidth   = 1.5;
  ctx.shadowBlur  = 0;
  ctx.stroke();

  // Surface crack lines (large asteroids only)
  if (a.level === 0) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(-lv.radius * 0.3, -lv.radius * 0.2);
    ctx.lineTo(lv.radius * 0.25, lv.radius * 0.15);
    ctx.stroke();
  }

  ctx.restore();
}

function drawBullet(ctx, b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.angle);

  const grad = ctx.createLinearGradient(0, -12, 0, 0);
  grad.addColorStop(0, 'rgba(0,255,120,0)');
  grad.addColorStop(1, '#00ff78');
  ctx.fillStyle   = grad;
  ctx.shadowColor = '#00ff78';
  ctx.shadowBlur  = 16;
  ctx.fillRect(-1.5, -12, 3, 12);
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 4;
  ctx.fillRect(-1, -10, 2, 8);

  ctx.shadowBlur = 0;
  ctx.restore();
}

export default function AsteroidsGame() {
  const ready = usePageReady();
  const { profile, refreshProfile } = useAuth();
  const { socket, authenticated, doAuth } = useSocket();

  const [phase, setPhase]             = useState('lobby');
  const { displayCurrency: betCurrency, setDisplayCurrency: setBetCurrency } = useCurrency();
  const [entryFee, setEntryFee]       = useState(1);
  const [opponent, setOpponent]       = useState(null);
  const [roomId, setRoomId]           = useState(null);
  const [countdown, setCountdown]     = useState(3);
  const [result, setResult]           = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]     = useState('');
  const [dead, setDead]               = useState(false);
  const [isSolo, setIsSolo]           = useState(false);
  const [liveScore, setLiveScore]     = useState(0);
  const [privateCode, setPrivateCode] = useState('');

  const canvasRef         = useRef(null);
  const roomIdRef         = useRef(null);
  const eloBeforeRef      = useRef(null);
  const stateRef          = useRef(null);
  const seedRef           = useRef(null);
  const isSoloRef         = useRef(false);
  const soloStartTimeRef  = useRef(0);

  roomIdRef.current = roomId;

  const isDiamonds    = betCurrency === 'diamonds';
  const fees          = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currencyLabel = isDiamonds ? '💎' : '🪙';
  const myBalance     = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient  = entryFee > 0 && myBalance < entryFee;

  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  const { RejoinOverlay } = useGamePageRejoin('asteroids', phase, roomId,
    (rid) => { setRoomId(rid); setPhase('active'); },
    () => setPhase('lobby'),
  );

  useEffect(() => {
    if (phase !== 'active') return;
    if (seedRef.current === null) return;
    const seed = seedRef.current;
    seedRef.current = null;
    startGame(seed);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local countdown for solo endless mode
  useEffect(() => {
    if (phase !== 'countdown' || !isSoloRef.current) return;
    if (countdown <= 0) {
      setDead(false); setLiveScore(0);
      seedRef.current = Date.now();
      soloStartTimeRef.current = performance.now();
      setPhase('active');
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  useEffect(() => {
    if (!socket) return;

    socket.on('asteroid_queue_joined',   () => setStatusMsg('Searching for opponent...'));
    socket.on('asteroid_match_found',    ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profile?.elo ?? 1000;
      setRoomId(rid); setOpponent(opp); setPhase('countdown');
    });
    socket.on('asteroid_countdown',      ({ count }) => setCountdown(count));
    socket.on('asteroid_start',          ({ seed }) => {
      setDead(false); setLiveScore(0);
      seedRef.current = seed;
      setPhase('active');
    });
    socket.on('asteroid_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('asteroid_result',         (data) => {
      stopGame();
      setResult(data); setResultCurrency(data.currency || 'coins');
      setPhase('result'); refreshProfile();
    });
    socket.on('opponent_disconnected', (data = {}) => {
      stopGame();
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
      setPrivateCode(code); setPhase('private_waiting');
    });

    return () => {
      ['asteroid_queue_joined','asteroid_match_found','asteroid_countdown','asteroid_start',
       'asteroid_rematch_requested','asteroid_result','opponent_disconnected','error',
       'private_room_created'].forEach(e => socket.off(e));
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopGame() {
    const gs = stateRef.current;
    if (!gs) return;
    cancelAnimationFrame(gs.animId);
    gs.cleanup?.();
    gs.alive = false;
    stateRef.current = null;
  }

  function startGame(seed) {
    stopGame();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const rand = makePRNG(seed);

    // Stars with parallax layers
    const stars = Array.from({ length: 120 }, () => ({
      x: rand() * W, y: rand() * H,
      b: 0.15 + rand() * 0.7,
      size: rand() < 0.08 ? 2.5 : rand() < 0.25 ? 1.5 : 1,
    }));

    // Initial asteroids
    const asteroids = Array.from({ length: 4 }, () => spawnAsteroid(rand, 0));

    const gs = {
      ship: {
        x: W / 2, y: H / 2,
        vx: 0, vy: 0,
        angle: -Math.PI / 2, // pointing up
        thrusting: false,
        invuln: false,
        invunlTimer: 0,
        alive: true,
      },
      bullets: [],
      asteroids,
      particles: [],
      score: 0,
      wave: 1,
      lastShot: 0,
      startTime: performance.now(),
      lastFrame: performance.now(),
      animId: null,
      rand, stars,
      keys: {},
      mouseX: W / 2,
      mouseY: H / 2,
    };
    stateRef.current = gs;

    function onKeyDown(e) {
      gs.keys[e.code] = true;
      // Shoot on Space
      if (e.code === 'Space') tryShoot(gs, performance.now());
      e.preventDefault();
    }
    function onKeyUp(e)   { delete gs.keys[e.code]; }
    function onMouseMove(e) {
      const rect = canvas.getBoundingClientRect();
      gs.mouseX = (e.clientX - rect.left) * (W / rect.width);
      gs.mouseY = (e.clientY - rect.top)  * (H / rect.height);
    }
    function onMouseDown(e) {
      if (e.button === 0) tryShoot(gs, performance.now());
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);

    gs.cleanup = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
    };

    function tryShoot(gs, now) {
      if (!gs.ship.alive) return;
      if (now - gs.lastShot < FIRE_CD * 1000) return;
      gs.lastShot = now;
      // Shoot forward along nose direction
      gs.bullets.push({
        x: gs.ship.x + Math.sin(gs.ship.angle) * (SHIP_R + 4),
        y: gs.ship.y - Math.cos(gs.ship.angle) * (SHIP_R + 4),
        vx:  Math.sin(gs.ship.angle) * BULLET_SPEED,
        vy: -Math.cos(gs.ship.angle) * BULLET_SPEED,
        angle: gs.ship.angle,
        life: 1.2,
      });
    }

    function spawnWave(gs) {
      const count = 3 + gs.wave;
      for (let i = 0; i < count; i++) gs.asteroids.push(spawnAsteroid(gs.rand, 0));
      gs.wave++;
    }

    function tick(now) {
      const dt = Math.min((now - gs.lastFrame) / 1000, 0.05);
      gs.lastFrame = now;
      const { ship, keys } = gs;

      // Mobile fire flag
      if (gs.fireNow) { gs.fireNow = false; tryShoot(gs, now); }

      if (ship.alive) {
        // Rotation
        if (keys['KeyA'] || keys['ArrowLeft'])  ship.angle -= ROTATE_SPEED * dt;
        if (keys['KeyD'] || keys['ArrowRight']) ship.angle += ROTATE_SPEED * dt;

        // Thrust (W = forward toward nose, S = brake/reverse)
        ship.thrusting = !!(keys['KeyW'] || keys['ArrowUp']);
        if (ship.thrusting) {
          ship.vx += Math.sin(ship.angle) * THRUST * dt;
          ship.vy -= Math.cos(ship.angle) * THRUST * dt;
        }
        if (keys['KeyS'] || keys['ArrowDown']) {
          ship.vx -= Math.sin(ship.angle) * THRUST * 0.5 * dt;
          ship.vy += Math.cos(ship.angle) * THRUST * 0.5 * dt;
        }

        // Velocity cap
        const spd = Math.hypot(ship.vx, ship.vy);
        if (spd > 400) { ship.vx *= 400 / spd; ship.vy *= 400 / spd; }

        ship.vx *= FRICTION;
        ship.vy *= FRICTION;
        ship.x  += ship.vx * dt;
        ship.y  += ship.vy * dt;

        // Wrap
        ({ x: ship.x, y: ship.y } = wrap(ship.x, ship.y));

        // Invulnerability
        if (ship.invuln) {
          ship.invunlTimer -= dt;
          if (ship.invunlTimer <= 0) ship.invuln = false;
        }
      }

      // Bullets
      for (const b of gs.bullets) {
        b.x    += b.vx * dt;
        b.y    += b.vy * dt;
        b.life -= dt;
        ({ x: b.x, y: b.y } = wrap(b.x, b.y));
      }
      gs.bullets = gs.bullets.filter(b => b.life > 0);

      // Asteroids
      for (const a of gs.asteroids) {
        a.x   += a.vx * dt;
        a.y   += a.vy * dt;
        a.rot += a.rotSpeed * dt;
        ({ x: a.x, y: a.y } = wrap(a.x, a.y));
      }

      // Bullet vs asteroid
      const toAdd = [];
      const hitAsteroids = new Set(), hitBullets = new Set();
      for (let bi = 0; bi < gs.bullets.length; bi++) {
        const b = gs.bullets[bi];
        for (let ai = 0; ai < gs.asteroids.length; ai++) {
          const a = gs.asteroids[ai];
          if (hitAsteroids.has(ai)) continue;
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          if (dist < A_LEVELS[a.level].radius * 0.85) {
            hitBullets.add(bi);
            hitAsteroids.add(ai);
            gs.score += A_LEVELS[a.level].points;
            setLiveScore(gs.score);
            if (!isSoloRef.current && socket && roomIdRef.current)
              socket.emit('asteroid_score_ping', { roomId: roomIdRef.current, score: gs.score });
            // Particles
            const col = ['#c4b49a','#aac49a','#c4c49a'][a.level];
            for (let p = 0; p < 8; p++) {
              const ang = rand() * Math.PI * 2;
              const spd = 40 + rand() * 80;
              gs.particles.push({ x: a.x, y: a.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, life: 1, color: col, size: 2 + rand() * 3 });
            }
            // Split
            if (A_LEVELS[a.level].splits > 0) {
              for (let s = 0; s < A_LEVELS[a.level].splits; s++) {
                toAdd.push(spawnAsteroid(gs.rand, a.level + 1, a.x, a.y));
              }
            }
          }
        }
      }
      gs.bullets    = gs.bullets.filter((_, i) => !hitBullets.has(i));
      gs.asteroids  = gs.asteroids.filter((_, i) => !hitAsteroids.has(i)).concat(toAdd);

      // Ship vs asteroid collision
      if (ship.alive && !ship.invuln) {
        for (const a of gs.asteroids) {
          const dist = Math.hypot(a.x - ship.x, a.y - ship.y);
          if (dist < A_LEVELS[a.level].radius * 0.8 + SHIP_R) {
            ship.alive = false;
            // Big explosion particles
            for (let p = 0; p < 16; p++) {
              const ang = rand() * Math.PI * 2;
              const spd = 60 + rand() * 140;
              gs.particles.push({ x: ship.x, y: ship.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, life: 1.2, color: '#44aaff', size: 3 + rand() * 4 });
            }
            if (isSoloRef.current) {
              gs.cleanup?.();
              const finalScore = gs.score;
              const survivalMs = performance.now() - soloStartTimeRef.current;
              const animId = gs.animId;
              setTimeout(() => {
                cancelAnimationFrame(animId);
                setResult({ isSolo: true, isEndless: true, score: finalScore, survivalMs });
                setPhase('result');
              }, 800);
            } else {
              setDead(true);
              socket.emit('asteroid_died', { roomId: roomIdRef.current, score: gs.score });
              gs.cleanup?.();
            }
            break;
          }
        }
      }

      // Spawn next wave when all asteroids gone
      if (gs.asteroids.length === 0) spawnWave(gs);

      // Particles
      for (const p of gs.particles) {
        p.x    += p.vx * dt;
        p.y    += p.vy * dt;
        p.vy   += 30 * dt;
        p.life -= dt * 1.5;
      }
      gs.particles = gs.particles.filter(p => p.life > 0);

      // ── Draw ──
      // Deep space background
      const bgGrad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W);
      bgGrad.addColorStop(0, '#08101f');
      bgGrad.addColorStop(1, '#020508');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // Nebula hint
      ctx.fillStyle = 'rgba(30,50,100,0.06)';
      ctx.beginPath();
      ctx.ellipse(W * 0.3, H * 0.4, W * 0.4, H * 0.35, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(60,20,80,0.05)';
      ctx.beginPath();
      ctx.ellipse(W * 0.7, H * 0.6, W * 0.35, H * 0.3, -0.4, 0, Math.PI * 2);
      ctx.fill();

      // Stars
      for (const st of gs.stars) {
        ctx.fillStyle = `rgba(255,255,255,${st.b})`;
        ctx.fillRect(st.x, st.y, st.size, st.size);
      }

      // Asteroids
      for (const a of gs.asteroids) drawAsteroid(ctx, a);

      // Bullets
      for (const b of gs.bullets) drawBullet(ctx, b);

      // Ship
      if (ship.alive) {
        drawShip(ctx, ship.x, ship.y, ship.angle, ship.thrusting, ship.invuln, now);
      } else {
        // Explosion ring fading
        ctx.beginPath();
        ctx.arc(ship.x, ship.y, 30, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(68,170,255,0.6)';
        ctx.lineWidth   = 3;
        ctx.shadowColor = '#44aaff';
        ctx.shadowBlur  = 20;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // Particles
      for (const p of gs.particles) {
        ctx.globalAlpha = Math.max(0, p.life * 0.9);
        ctx.fillStyle   = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur  = 6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur  = 0;

      // HUD
      const elapsed = ((now - gs.startTime) / 1000).toFixed(1);
      ctx.font      = 'bold 15px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.textAlign = 'left';
      ctx.fillText(`Score: ${gs.score}`, 14, 28);
      ctx.textAlign = 'right';
      ctx.fillText(`${elapsed}s  Wave ${gs.wave}`, W - 14, 28);
      ctx.textAlign = 'center';

      // Control hint (first 4 seconds)
      if (now - gs.startTime < 4000) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '13px monospace';
        ctx.fillText('WASD / Arrow Keys — Move   Click / Space — Shoot', W / 2, H - 16);
      }

      gs.animId = requestAnimationFrame(tick);
    }

    gs.animId = requestAnimationFrame(tick);
  }

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_asteroid_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_asteroid_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playVsBotFree() {
    isSoloRef.current = true;
    setIsSolo(true);
    setOpponent(null); setResult(null);
    setDead(false); setLiveScore(0);
    setPhase('countdown'); setCountdown(3);
  }
  function leaveQueue() {
    socket.emit('leave_asteroid_queue'); setPhase('lobby'); setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'asteroids', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'asteroids', code });
    setPhase('queue'); setStatusMsg('Joining private room...');
  }
  function cancelPrivate() {
    socket.emit('cancel_private_room');
    setPhase('lobby'); setPrivateCode(''); setStatusMsg('');
  }
  function requestRematch() {
    if (isSoloRef.current) {
      playVsBotFree();
      return;
    }
    if (result?.isBotMode) {
      playVsBot();
      return;
    }
    socket.emit('asteroid_rematch_request', { roomId });
    setResult(null); setPhase('countdown'); setDead(false); setLiveScore(0);
    setStatusMsg('Waiting for opponent...');
  }
  function backToLobby() {
    stopGame(); setPhase('lobby'); setResult(null);
    isSoloRef.current = false; setIsSolo(false);
    setOpponent(null); setRoomId(null); setDead(false); setLiveScore(0); setStatusMsg('');
  }

  const isWinner = result && result.winnerId === profile?.id;

  return (
    <div className="min-h-[calc(100vh-56px)] bg-bg flex flex-col items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>

      {RejoinOverlay}

      {phase === 'lobby' && (
        <GameLobby
          title="☄️ Asteroids"
          description="Destroy asteroids — survive as long as possible and score big"
          controls="WASD / Arrow Keys to fly · Left Click or Space to shoot"
          betCurrency={betCurrency} setBetCurrency={setBetCurrency}
          entryFee={entryFee} setEntryFee={setEntryFee}
          balance={myBalance}
          authenticated={authenticated} doAuth={doAuth}
          onQueue={joinQueue}
          onBot={playVsBot}
          onBotFree={playVsBotFree}
          botLabel="☄️ Bet vs Bot"
          onCreatePrivate={createPrivate}
          onJoinPrivate={joinPrivate}
          statusMsg={statusMsg}
        />
      )}

      {phase === 'private_waiting' && (
        <div className="text-center animate-fade-in">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-white mb-2">Private Room Created</h2>
          <p className="text-muted mb-6 text-sm">Share this code with a friend</p>
          <div className="bg-surface border-2 border-primary rounded-2xl p-8 mb-6 shadow-glow inline-block min-w-[200px]">
            <div className="text-4xl font-black font-mono tracking-[0.25em] text-primary">{privateCode}</div>
            <button onClick={() => navigator.clipboard.writeText(privateCode)} className="text-xs text-muted hover:text-primary mt-3 block mx-auto transition-colors">📋 Copy</button>
          </div>
          <p className="text-muted text-sm animate-pulse mb-6">Waiting for opponent...</p>
          <GlowButton variant="ghost" onClick={cancelPrivate} className="border border-border">Cancel</GlowButton>
        </div>
      )}

      {phase === 'queue' && (
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-2">Searching...</h2>
          <p className="text-muted mb-6 text-sm">{statusMsg}</p>
          <GlowButton variant="ghost" onClick={leaveQueue}>Cancel</GlowButton>
        </div>
      )}

      {phase === 'countdown' && (
        <div className="flex flex-col items-center animate-fade-in">
          {opponent && (
            <p className="text-muted mb-8 text-lg text-center">
              vs <span className="text-white font-bold">{opponent.username}</span>
            </p>
          )}
          <div className="w-48 h-48 rounded-full border-4 border-primary bg-primary/10 shadow-glow flex items-center justify-center mx-auto">
            <span className="text-7xl font-black text-white">{countdown}</span>
          </div>
          <p className="text-muted mt-6 text-sm">WASD to fly · Click to shoot</p>
        </div>
      )}

      {phase === 'active' && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center justify-between w-full px-1" style={{ maxWidth: W }}>
            <span className="text-sm font-black font-mono text-success">Score: {liveScore}</span>
            <span className="text-center">
              {isSolo
                ? <span className="text-xs text-muted">∞ Solo Endless</span>
                : <span className="text-xs text-accent font-bold">Score Race</span>
              }
              {opponent && <div className="text-xs text-muted">vs {opponent.username}</div>}
            </span>
            {dead
              ? <span className="text-danger font-bold text-xs animate-pulse">Destroyed!</span>
              : <span className="text-success text-xs">● Alive</span>
            }
          </div>
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              className="rounded-2xl border border-slate-700 block"
              style={{ maxWidth: '100%', maxHeight: '65vh', cursor: 'crosshair' }}
            />
          </div>
          {/* Mobile touch controls */}
          <div className="md:hidden w-full mt-2 select-none" style={{ maxWidth: W }}>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <button onPointerDown={() => { if (stateRef.current) stateRef.current.keys['KeyA'] = true; }} onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['KeyA']; }} onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['KeyA']; }} className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-2xl font-bold active:bg-primary/30 touch-none">↺</button>
              <button onPointerDown={() => { if (stateRef.current) stateRef.current.keys['KeyW'] = true; }} onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['KeyW']; }} onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['KeyW']; }} className="py-5 rounded-xl bg-primary/20 border border-primary/40 text-white text-2xl font-bold active:bg-primary/50 touch-none">▲</button>
              <button onPointerDown={() => { if (stateRef.current) stateRef.current.keys['KeyD'] = true; }} onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['KeyD']; }} onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['KeyD']; }} className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-2xl font-bold active:bg-primary/30 touch-none">↻</button>
            </div>
            <button onPointerDown={() => { if (stateRef.current) stateRef.current.fireNow = true; }} className="w-full py-4 rounded-xl bg-success/20 border border-success/40 text-success text-xl font-bold active:bg-success/50 touch-none">🔫 SHOOT</button>
          </div>
        </div>
      )}

      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          {result.isSolo ? (
            <>
              <div className="text-7xl mb-4">💥</div>
              <h2 className="text-4xl font-black mb-2 text-danger">Destroyed!</h2>
              <div className="text-6xl font-black text-white mb-1 font-mono">{liveScore}</div>
              <p className="text-muted mb-1 text-sm">points scored</p>
              <div className="text-2xl font-mono text-muted mb-8">{((result.survivalMs ?? 0) / 1000).toFixed(1)}s survived</div>
              <div className="flex gap-3">
                <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
                <GlowButton variant="primary" onClick={() => {
                  stopGame();
                  playVsBotFree();
                  setResult(null);
                }} className="flex-1">Try Again</GlowButton>
              </div>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
            </>
          ) : result.isBotMode ? (
            <>
              <div className="text-7xl mb-4 animate-pop-in">{result.humanWon ? '🚀' : '💥'}</div>
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
                        ? `+${result.currency === 'diamonds' ? Math.round(result.balanceChange.winnerPayout) + ' 💎' : result.balanceChange.winnerPayout.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) + ' 🪙'}`
                        : `-${result.entryFee ?? 0} ${result.currency === 'diamonds' ? '💎' : '🪙'}`}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <GlowButton variant="outline" onClick={backToLobby} className="flex-1">Back</GlowButton>
                <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Play Again</GlowButton>
              </div>
              <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
            </>
          ) : (
            <>
              <div className={`text-7xl mb-4 ${!isWinner ? 'grayscale' : ''}`}>{isWinner ? '🚀' : '💥'}</div>
              <h2 className={`text-4xl font-black mb-2 ${isWinner ? 'text-success' : 'text-danger'}`}>
                {isWinner ? 'You Survived!' : 'You Crashed!'}
              </h2>
              {result.disconnected ? (
                <p className="text-sm text-muted mb-6">Opponent disconnected</p>
              ) : (
                <p className="text-muted mb-6">
                  {isWinner ? `${result.winnerUsername} outlasted ${result.loserUsername}` : `${result.winnerUsername} outlasted you`}
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



