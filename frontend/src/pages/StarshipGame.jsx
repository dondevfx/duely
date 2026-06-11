import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useCurrency } from '../context/CurrencyContext';
import GlowButton from '../components/GlowButton';
import GameLobby from '../components/GameLobby';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';

const COIN_FEES    = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const DIAMOND_FEES = [50, 100, 250, 500, 1000];

const W = 800, H = 500;
const SHIP_R       = 13;
const ROTATE_SPEED = 3.5;   // rad/s
const THRUST       = 260;   // px/s—
const FRICTION     = 0.985; // velocity decay per 60-fps frame
const MAX_SPEED    = 340;   // px/s
const BULLET_SPEED = 500;   // px/s
const BULLET_LIFE  = 1.3;   // seconds
const FIRE_CD      = 0.20;  // seconds between shots
const INVINC_T     = 2.0;   // invincibility seconds after a hit
const MAX_LIVES    = 3;

const AST = {
  large:  { r: 44, score: 20,  next: 'medium', count: 2 },
  medium: { r: 22, score: 50,  next: 'small',  count: 2 },
  small:  { r: 11, score: 100, next: null,      count: 0 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePRNG(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnAsteroid(rand, elapsed, sizeKey = 'large') {
  const edge = Math.floor(rand() * 4);
  let x, y;
  if      (edge === 0) { x = rand() * W; y = -60; }
  else if (edge === 1) { x = W + 60;    y = rand() * H; }
  else if (edge === 2) { x = rand() * W; y = H + 60; }
  else                 { x = -60;       y = rand() * H; }
  const cx  = W / 2 + (rand() - 0.5) * W * 0.6;
  const cy  = H / 2 + (rand() - 0.5) * H * 0.6;
  const ang = Math.atan2(cy - y, cx - x);
  const spd = (50 + elapsed / 1600) * (0.7 + rand() * 0.65);
  return {
    id:       rand(),
    x, y,
    vx:       Math.cos(ang) * spd,
    vy:       Math.sin(ang) * spd,
    r:        AST[sizeKey].r,
    rotation: rand() * Math.PI * 2,
    rotSpeed: (rand() - 0.5) * 2.0,
    sides:    Math.floor(6 + rand() * 5),
    sizeKey,
  };
}

function splitAsteroid(a, elapsed) {
  const sz = AST[a.sizeKey];
  if (!sz.next) return [];
  const spd = 65 + elapsed / 1400;
  return Array.from({ length: sz.count }, (_, i) => {
    const ang = Math.random() * Math.PI * 2 + i * Math.PI;
    return {
      id:       Math.random(),
      x:        a.x + Math.cos(ang) * (a.r + AST[sz.next].r + 2),
      y:        a.y + Math.sin(ang) * (a.r + AST[sz.next].r + 2),
      vx:       Math.cos(ang) * spd * (0.8 + Math.random() * 0.6),
      vy:       Math.sin(ang) * spd * (0.8 + Math.random() * 0.6),
      r:        AST[sz.next].r,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 2.5,
      sides:    Math.floor(5 + Math.random() * 4),
      sizeKey:  sz.next,
    };
  });
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function drawShip(ctx, ship) {
  if (!ship.alive) {
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, 28, 0, Math.PI * 2);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth   = 2.5;
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur  = 22;
    ctx.stroke();
    ctx.shadowBlur  = 0;
    return;
  }
  if (ship.invincible && Math.floor(ship.invincTimer * 8) % 2 === 0) return;

  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  if (ship.thrusting) {
    const fl = SHIP_R * 0.6 + Math.random() * SHIP_R * 0.7;
    ctx.beginPath();
    ctx.moveTo(-SHIP_R * 0.35, SHIP_R * 0.88);
    ctx.lineTo(0, SHIP_R * 0.88 + fl);
    ctx.lineTo(SHIP_R * 0.35, SHIP_R * 0.88);
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#f97316';
    ctx.shadowBlur  = 12;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }

  ctx.beginPath();
  ctx.moveTo(0, -SHIP_R);
  ctx.lineTo(SHIP_R * 0.65, SHIP_R * 0.85);
  ctx.lineTo(0, SHIP_R * 0.44);
  ctx.lineTo(-SHIP_R * 0.65, SHIP_R * 0.85);
  ctx.closePath();
  ctx.fillStyle   = '#3b82f6';
  ctx.shadowColor = '#60a5fa';
  ctx.shadowBlur  = 18;
  ctx.fill();
  ctx.strokeStyle = '#93c5fd';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  ctx.restore();
}

function drawBullet(ctx, b) {
  ctx.beginPath();
  ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle   = '#fde047';
  ctx.shadowColor = '#fde047';
  ctx.shadowBlur  = 10;
  ctx.fill();
  ctx.shadowBlur  = 0;
}

function drawAsteroid(ctx, a) {
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(a.rotation);
  ctx.beginPath();
  for (let i = 0; i < a.sides; i++) {
    const ang = (i / a.sides) * Math.PI * 2;
    const r   = a.r * (0.78 + Math.sin(ang * 3 + a.id * 10) * 0.22);
    i === 0 ? ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r)
            : ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
  }
  ctx.closePath();
  const fills   = { large: '#374151', medium: '#4b5563', small: '#6b7280' };
  const strokes = { large: '#6b7280', medium: '#9ca3af', small: '#d1d5db' };
  ctx.fillStyle   = fills[a.sizeKey]   || '#374151';
  ctx.strokeStyle = strokes[a.sizeKey] || '#6b7280';
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawStars(ctx, stars) {
  stars.forEach(s => {
    ctx.fillStyle = `rgba(255,255,255,${s.b})`;
    ctx.fillRect(s.x, s.y, s.size, s.size);
  });
}

function drawHUD(ctx, score, lives, elapsed) {
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, 0, W, 44);

  ctx.font = '16px sans-serif';
  for (let i = 0; i < MAX_LIVES; i++) {
    ctx.fillStyle = i < lives ? '#ef4444' : 'rgba(255,255,255,0.12)';
    ctx.fillText('♥', 14 + i * 22, 28);
  }

  ctx.font      = 'bold 22px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'center';
  ctx.fillText(score, W / 2, 30);

  ctx.font      = '14px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'right';
  ctx.fillText(`${(elapsed / 1000).toFixed(1)}s`, W - 14, 28);
  ctx.textAlign = 'left';
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StarshipGame() {
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
  const [countdown, setCountdown]   = useState(3);
  const [result, setResult]         = useState(null);
  const [resultCurrency, setResultCurrency] = useState('coins');
  const [statusMsg, setStatusMsg]   = useState('');
  const [dead, setDead]             = useState(false);
  const [privateCode, setPrivateCode] = useState('');
  const [liveScore, setLiveScore]   = useState(0);

  const canvasRef    = useRef(null);
  const roomIdRef    = useRef(null);
  const eloBeforeRef = useRef(null);
  const stateRef     = useRef(null);
  const seedRef      = useRef(null);
  const profileRef   = useRef(profile);

  roomIdRef.current  = roomId;
  profileRef.current = profile;

  const isDiamonds   = betCurrency === 'diamonds';
  const fees         = isDiamonds ? DIAMOND_FEES : COIN_FEES;
  const currLabel    = isDiamonds ? '💎' : <CoinIcon size="0.85em" />;
  const myBalance    = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const insufficient = entryFee > 0 && myBalance < entryFee;

  useEffect(() => { setEntryFee(isDiamonds ? 50 : 1); }, [betCurrency]);

  // Start game after canvas mounts (phase 'active' → re-render → canvas present → this fires)
  useEffect(() => {
    if (phase !== 'active' || seedRef.current === null) return;
    const seed = seedRef.current;
    seedRef.current = null;
    startGame(seed);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket) return;

    socket.on('starship_match_found', ({ roomId: rid, opponent: opp }) => {
      eloBeforeRef.current = profileRef.current?.elo ?? 1000;
      setRoomId(rid); setOpponent(opp); setPhase('countdown');
    });
    socket.on('starship_countdown', ({ count }) => setCountdown(count));
    socket.on('starship_start', ({ seed }) => {
      setDead(false); setLiveScore(0);
      seedRef.current = seed;
      setPhase('active');
    });
    socket.on('starship_rematch_requested', () => setStatusMsg('Opponent wants a rematch!'));
    socket.on('starship_result', data => {
      stopGame();
      setResult(data); setResultCurrency(data.currency || 'coins');
      setPhase('result'); refreshProfile();
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
        currency:       data.currency,
        newWinnerElo:   data.newWinnerElo,
        newLoserElo:    data.newLoserElo,
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
      ['starship_match_found','starship_countdown','starship_start',
       'starship_rematch_requested','starship_result','opponent_disconnected','error',
       'private_room_created']
        .forEach(e => socket.off(e));
    };
  }, [socket, refreshProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Game loop ─────────────────────────────────────────────────────────────

  function startGame(seed) {
    stopGame();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rand  = makePRNG(seed);
    const stars = Array.from({ length: 120 }, () => ({
      x:    Math.random() * W,
      y:    Math.random() * H,
      b:    0.1 + Math.random() * 0.5,
      size: Math.random() < 0.2 ? 2 : 1,
      vy:   8 + Math.random() * 28,
    }));

    const gs = {
      ship: {
        x: W / 2, y: H / 2,
        angle: -Math.PI / 2,
        vx: 0, vy: 0,
        alive:       true,
        thrusting:   false,
        lives:       MAX_LIVES,
        invincible:  false,
        invincTimer: 0,
      },
      bullets:   [],
      asteroids: [],
      score:     0,
      startTime: performance.now(),
      lastSpawn: performance.now(),
      lastShot:  0,
      lastFrame: performance.now(),
      animId:    null,
      rand, stars,
      particles: [],
      keys: {},
      mouseShoot: false,
    };

    // Spawn 4 large asteroids to start
    for (let i = 0; i < 4; i++) gs.asteroids.push(spawnAsteroid(rand, 0));

    stateRef.current = gs;

    function onKeyDown(e) {
      gs.keys[e.code] = true;
    }
    function onKeyUp(e) { delete gs.keys[e.code]; }
    function onMouseDown(e) {
      if (e.button === 0) gs.mouseShoot = true;
    }
    function onMouseUp(e) {
      if (e.button === 0) gs.mouseShoot = false;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup',   onMouseUp);
    gs.cleanup = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup',   onMouseUp);
    };

    function tick(now) {
      const dt = Math.min((now - gs.lastFrame) / 1000, 0.05);
      gs.lastFrame = now;
      const elapsed = now - gs.startTime;
      const { ship, keys } = gs;

      if (ship.alive) {
        // Rotation
        if (keys['ArrowLeft']  || keys['KeyA']) ship.angle -= ROTATE_SPEED * dt;
        if (keys['ArrowRight'] || keys['KeyD']) ship.angle += ROTATE_SPEED * dt;

        // Thrust
        ship.thrusting = !!(keys['ArrowUp'] || keys['KeyW']);
        if (ship.thrusting) {
          ship.vx += Math.sin(ship.angle) * THRUST * dt;
          ship.vy -= Math.cos(ship.angle) * THRUST * dt;
        }

        // Friction
        const ff = Math.pow(FRICTION, dt * 60);
        ship.vx *= ff; ship.vy *= ff;

        // Speed cap
        const spd = Math.hypot(ship.vx, ship.vy);
        if (spd > MAX_SPEED) { const f = MAX_SPEED / spd; ship.vx *= f; ship.vy *= f; }

        // Move + wrap
        ship.x += ship.vx * dt;
        ship.y += ship.vy * dt;
        if (ship.x < -SHIP_R)     ship.x = W + SHIP_R;
        if (ship.x > W + SHIP_R)  ship.x = -SHIP_R;
        if (ship.y < -SHIP_R)     ship.y = H + SHIP_R;
        if (ship.y > H + SHIP_R)  ship.y = -SHIP_R;

        // Shoot
        if ((gs.mouseShoot || keys['ShiftLeft']) && now - gs.lastShot > FIRE_CD * 1000) {
          gs.lastShot = now;
          const dx = Math.sin(ship.angle), dy = -Math.cos(ship.angle);
          gs.bullets.push({
            x:    ship.x + dx * (SHIP_R + 4),
            y:    ship.y + dy * (SHIP_R + 4),
            vx:   ship.vx + dx * BULLET_SPEED,
            vy:   ship.vy + dy * BULLET_SPEED,
            life: BULLET_LIFE,
          });
        }

        // Invincibility countdown
        if (ship.invincible) {
          ship.invincTimer -= dt;
          if (ship.invincTimer <= 0) { ship.invincible = false; ship.invincTimer = 0; }
        }
      }

      // Bullets: move + wrap + lifetime
      for (const b of gs.bullets) {
        b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
        if (b.x < 0) b.x += W; if (b.x > W) b.x -= W;
        if (b.y < 0) b.y += H; if (b.y > H) b.y -= H;
      }
      gs.bullets = gs.bullets.filter(b => b.life > 0);

      // Asteroids: move + wrap
      for (const a of gs.asteroids) {
        a.x += a.vx * dt; a.y += a.vy * dt; a.rotation += a.rotSpeed * dt;
        const pad = a.r + 12;
        if (a.x < -pad) a.x = W + a.r; if (a.x > W + pad) a.x = -a.r;
        if (a.y < -pad) a.y = H + a.r; if (a.y > H + pad) a.y = -a.r;
      }

      // Spawn new asteroids
      const spawnInterval = Math.max(400, 2200 - elapsed / 28);
      if (now - gs.lastSpawn > spawnInterval) {
        gs.lastSpawn = now;
        gs.asteroids.push(spawnAsteroid(gs.rand, elapsed, 'large'));
      }

      // Bullet ↔ asteroid collisions
      let gained    = 0;
      const nextAst = [];
      const hitB    = new Set();

      for (const a of gs.asteroids) {
        let hit = false;
        for (let bi = 0; bi < gs.bullets.length; bi++) {
          if (hitB.has(bi)) continue;
          if (Math.hypot(gs.bullets[bi].x - a.x, gs.bullets[bi].y - a.y) < a.r + 4) {
            hit = true;
            hitB.add(bi);
            gained += AST[a.sizeKey].score;
            nextAst.push(...splitAsteroid(a, elapsed));
            // Explosion particles
            const pCount = a.sizeKey === 'large' ? 14 : a.sizeKey === 'medium' ? 9 : 6;
            const pColors = ['#9ca3af', '#d1d5db', '#6b7280', '#f97316'];
            for (let p = 0; p < pCount; p++) {
              const ang = Math.random() * Math.PI * 2;
              const spd = 40 + Math.random() * (a.sizeKey === 'large' ? 130 : 90);
              gs.particles.push({ x: a.x, y: a.y, vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd, life: 1, color: pColors[Math.floor(Math.random()*pColors.length)], size: 1.5 + Math.random() * 3 });
            }
            break;
          }
        }
        if (!hit) nextAst.push(a);
      }
      gs.asteroids = nextAst;
      gs.bullets   = gs.bullets.filter((_, i) => !hitB.has(i));

      if (gained > 0) { gs.score += gained; setLiveScore(gs.score); }

      // Ship ↔ asteroid collision
      if (ship.alive && !ship.invincible) {
        for (const a of gs.asteroids) {
          if (Math.hypot(a.x - ship.x, a.y - ship.y) < a.r * 0.82 + SHIP_R) {
            // Ship hit flash particles
            for (let p = 0; p < 14; p++) {
              const ang = Math.random() * Math.PI * 2;
              const spd = 80 + Math.random() * 180;
              gs.particles.push({ x: ship.x, y: ship.y, vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd, life: 1, color: '#ef4444', size: 2.5 });
            }
            ship.lives--;
            if (ship.lives <= 0) {
              ship.alive = false;
              setDead(true);
              socket?.emit('starship_died', { roomId: roomIdRef.current, score: gs.score });
              gs.cleanup?.();
              draw(gs);
              return;
            }
            ship.invincible  = true;
            ship.invincTimer = INVINC_T;
            ship.vx = 0; ship.vy = 0;
            break;
          }
        }
      }

      // Update particles
      for (const p of gs.particles) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.97; p.vy *= 0.97;
        p.life -= dt * 1.8;
      }
      gs.particles = gs.particles.filter(p => p.life > 0);

      // Scroll stars
      for (const st of gs.stars) {
        st.y += st.vy * dt;
        if (st.y > H + 2) { st.y = -2; st.x = Math.random() * W; }
      }

      draw(gs);
      gs.animId = requestAnimationFrame(tick);
    }

    gs.animId = requestAnimationFrame(tick);
  }

  function draw(gs) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#050b18';
    ctx.fillRect(0, 0, W, H);
    drawStars(ctx, gs.stars);
    gs.asteroids.forEach(a => drawAsteroid(ctx, a));
    gs.bullets.forEach(b => drawBullet(ctx, b));
    drawShip(ctx, gs.ship);
    // Particles
    for (const p of gs.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    drawHUD(ctx, gs.score, gs.ship.lives, gs.ship.alive ? performance.now() - gs.startTime : 0);
  }

  function stopGame() {
    const gs = stateRef.current;
    if (!gs) return;
    cancelAnimationFrame(gs.animId);
    gs.cleanup?.();
    gs.ship.alive = false;
    stateRef.current = null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function joinQueue() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_starship_queue', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Finding an opponent...');
  }
  function playVsBot() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_starship_vs_bot', { entryFee, currency: betCurrency });
    setPhase('queue'); setStatusMsg('Starting bot match...');
  }
  function playVsBotFree() {
    if (!authenticated) { doAuth(); return; }
    socket.emit('play_starship_vs_bot', { entryFee: 0, currency: 'coins' });
    setPhase('queue'); setStatusMsg('Starting free match...');
  }
  function leaveQueue() {
    socket.emit('leave_starship_queue'); setPhase('lobby'); setStatusMsg('');
  }
  function createPrivate(fee, cur) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('create_private_room', { gameType: 'starship', entryFee: fee, currency: cur });
  }
  function joinPrivate(code) {
    if (!authenticated) { doAuth(); return; }
    socket.emit('join_private_room', { gameType: 'starship', code });
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
    socket.emit('starship_rematch_request', { roomId });
    setResult(null); setPhase('countdown'); setDead(false); setLiveScore(0);
    setStatusMsg('Waiting for opponent...');
  }
  function backToLobby() {
    stopGame(); setPhase('lobby'); setResult(null);
    setOpponent(null); setRoomId(null); setDead(false); setLiveScore(0); setStatusMsg('');
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

      {/* ── LOBBY ── */}
      {phase === 'lobby' && (
        <GameLobby
          title="🚀 Asteroids"
          description="Pilot your ship, shoot asteroids, outlast your opponent"
          controls="A/D rotate — W thrust — Left Click shoot — 3 lives — last ship flying wins"
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
            <span className="text-sm text-muted">
              vs <span className="text-white font-semibold">{opponent?.username ?? 'Bot'}</span>
            </span>
            {dead && <span className="text-danger font-bold text-sm animate-pulse">You were destroyed!</span>}
            <span className="text-sm text-muted font-mono">
              Score: <span className="text-white font-bold">{liveScore}</span>
            </span>
          </div>
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className="rounded-xl border border-surfaceLight shadow-2xl"
            style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
          />
          <p className="text-muted text-xs hidden md:block">A/D rotate — W thrust — Left Click shoot</p>

          {/* Mobile touch controls */}
          <div className="md:hidden w-full mt-2 select-none">
            <div className="grid grid-cols-3 gap-2 mb-2">
              <button
                onPointerDown={() => { if (stateRef.current) stateRef.current.keys['KeyA'] = true; }}
                onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['KeyA']; }}
                onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['KeyA']; }}
                className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-2xl font-bold active:bg-primary/30 touch-none"
              >↺</button>
              <button
                onPointerDown={() => { if (stateRef.current) stateRef.current.keys['KeyW'] = true; }}
                onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['KeyW']; }}
                onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['KeyW']; }}
                className="py-5 rounded-xl bg-primary/20 border border-primary/40 text-white text-2xl font-bold active:bg-primary/50 touch-none"
              >▲</button>
              <button
                onPointerDown={() => { if (stateRef.current) stateRef.current.keys['KeyD'] = true; }}
                onPointerUp={() => { if (stateRef.current) delete stateRef.current.keys['KeyD']; }}
                onPointerLeave={() => { if (stateRef.current) delete stateRef.current.keys['KeyD']; }}
                className="py-5 rounded-xl bg-surfaceLight border border-border text-white text-2xl font-bold active:bg-primary/30 touch-none"
              >↻</button>
            </div>
            <button
              onPointerDown={() => { if (stateRef.current) stateRef.current.mouseShoot = true; }}
              onPointerUp={() => { if (stateRef.current) stateRef.current.mouseShoot = false; }}
              onPointerLeave={() => { if (stateRef.current) stateRef.current.mouseShoot = false; }}
              className="w-full py-4 rounded-xl bg-danger/20 border border-danger/40 text-danger text-xl font-bold active:bg-danger/40 touch-none"
            >🔥 SHOOT</button>
          </div>
        </div>
      )}

      {/* ── RESULT ── */}
      {phase === 'result' && result && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="text-center animate-scale-in max-w-md w-full bg-surface border border-surfaceLight rounded-3xl p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div className={`text-7xl mb-4 animate-pop-in ${isWinner ? '' : 'grayscale'}`}>
            {result.draw ? '🤝' : isWinner ? '🏆' : '💀'}
          </div>
          <h2 className={`text-4xl font-black mb-2 animate-pop-in ${result.draw ? 'text-accent' : isWinner ? 'text-success' : 'text-danger'}`} style={{ animationDelay: '0.1s' }}>
            {result.draw ? 'Draw!' : isWinner ? 'You Won!' : 'You Lost!'}
          </h2>
          {result.disconnected ? (
            <p className="text-sm text-muted mb-3">Opponent disconnected</p>
          ) : (
            <p className="text-sm text-muted mb-3">
              {isWinner ? 'Opponent scored' : 'Final score'}:{' '}
              <span className="text-white font-bold font-mono">{result.loserScore ?? 0}</span>
            </p>
          )}

          <div className="bg-surface border border-surfaceLight rounded-xl p-4 mb-4 text-sm space-y-2">
            {!result.draw && (() => {
              const myNewElo = isWinner ? result.newWinnerElo : result.newLoserElo;
              const eloDelta = myNewElo - (eloBeforeRef.current ?? myNewElo);
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
            {result.isEndless
              ? <GlowButton variant="primary" onClick={playVsBot} className="flex-1">Play Again</GlowButton>
              : <GlowButton variant="primary" onClick={requestRematch} className="flex-1">Rematch</GlowButton>
            }
          </div>
          <GlowButton variant="ghost" onClick={() => { window.location.href = '/'; }} className="w-full mt-2 border border-border">Home</GlowButton>
          {statusMsg && <p className="text-muted text-xs mt-3">{statusMsg}</p>}
        </div>
      </div>
      )}
    </div>
  );
}



