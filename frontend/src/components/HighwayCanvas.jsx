import { useEffect, useRef } from 'react';
import { isMuted } from '../utils/sound';

/**
 * Highway Dash — gameplay canvas only.
 *
 * Portrait, top-down ~60° camera. The road scrolls downward, the player sits in
 * the bottom third, traffic is approached from behind. Everything is world-space
 * simulated (lane + distance) and projected to screen, so collisions are fair
 * and independent of resolution.
 *
 * In-canvas UI is deliberately limited to SCORE and TIME — every other screen
 * (lobby, countdown, result) is owned by the page and untouched.
 *
 * Reports upward via onProgress(score, ms) and onCrash(score, ms).
 */

// ── Tuning ──────────────────────────────────────────────────────────────────
const LANES        = 4;
const ROAD_FRAC    = 0.90;   // road width as a fraction of canvas width
const PLAYER_Y     = 0.72;   // player position (fraction of canvas height)
const TOP_Y        = 0.05;
const CAM_D        = 1500;   // perspective depth — higher = flatter/more top-down
const VIEW         = 1000;   // world units visible ahead

const SPEED_START  = 430;
const SPEED_MAX    = 1180;
const SPEED_RAMP   = 62_000; // ms to reach max speed
const LANE_SNAP    = 13;     // lane-change responsiveness

const PTS_DIST     = 0.06;   // per world unit travelled
const PTS_TIME     = 8;      // per second survived
const PTS_NEARMISS = 75;

const FREEZE_MS    = 150;    // crash freeze-frame

const VEHICLES = [
  { k: 'sedan',  len: 92,  w: 0.62, spd: [0.42, 0.62] },
  { k: 'suv',    len: 104, w: 0.68, spd: [0.38, 0.56] },
  { k: 'pickup', len: 110, w: 0.66, spd: [0.36, 0.54] },
  { k: 'sports', len: 86,  w: 0.60, spd: [0.60, 0.80] },
  { k: 'van',    len: 124, w: 0.70, spd: [0.32, 0.48] },
  { k: 'semi',   len: 215, w: 0.80, spd: [0.26, 0.40] },
];
const PAINT = [
  '#D64545', '#E0873A', '#E8C34A', '#43A15E', '#3D8FD1', '#7B5BD6',
  '#C94F86', '#D9DEE6', '#8A929E', '#2F3742', '#2AA9A0', '#E56A3B',
];

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function makePRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Audio: engine + wind + whoosh + crash (Web Audio, no assets) ────────────
function createAudio() {
  if (isMuted()) return null;
  let ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  if (!ctx) return null;

  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  // Engine — two detuned saws through a lowpass that opens with speed
  const eg = ctx.createGain(); eg.gain.value = 0.0;
  const ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 500;
  const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 60;
  const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 91;
  o1.connect(ef); o2.connect(ef); ef.connect(eg); eg.connect(master);
  o1.start(); o2.start();

  // Wind — filtered noise that rises with speed
  const nBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const wind = ctx.createBufferSource(); wind.buffer = nBuf; wind.loop = true;
  const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 900; wf.Q.value = 0.7;
  const wg = ctx.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); wg.connect(master);
  wind.start();

  return {
    ctx,
    resume() { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    setSpeed(t) { // t = 0..1
      const now = ctx.currentTime;
      eg.gain.setTargetAtTime(0.055 + t * 0.05, now, 0.15);
      o1.frequency.setTargetAtTime(58 + t * 72, now, 0.2);
      o2.frequency.setTargetAtTime(88 + t * 108, now, 0.2);
      ef.frequency.setTargetAtTime(420 + t * 1500, now, 0.25);
      wg.gain.setTargetAtTime(0.012 + t * 0.075, now, 0.2);
      wf.frequency.setTargetAtTime(760 + t * 1100, now, 0.25);
    },
    whoosh() {
      const s = ctx.createBufferSource(); s.buffer = nBuf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.6;
      const g = ctx.createGain();
      const t0 = ctx.currentTime;
      f.frequency.setValueAtTime(1500, t0);
      f.frequency.exponentialRampToValueAtTime(320, t0 + 0.26);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.24, t0 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0); s.stop(t0 + 0.32);
    },
    crash() {
      const t0 = ctx.currentTime;
      const s = ctx.createBufferSource(); s.buffer = nBuf;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(2600, t0);
      f.frequency.exponentialRampToValueAtTime(160, t0 + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.7, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0); s.stop(t0 + 0.65);
      const th = ctx.createOscillator(); th.type = 'sine';
      const tg = ctx.createGain();
      th.frequency.setValueAtTime(150, t0);
      th.frequency.exponentialRampToValueAtTime(38, t0 + 0.42);
      tg.gain.setValueAtTime(0.65, t0);
      tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      th.connect(tg); tg.connect(master);
      th.start(t0); th.stop(t0 + 0.52);
      eg.gain.setTargetAtTime(0, t0, 0.08);
      wg.gain.setTargetAtTime(0, t0, 0.08);
    },
    stop() { try { o1.stop(); o2.stop(); wind.stop(); ctx.close(); } catch { /* noop */ } },
  };
}

export default function HighwayCanvas({ seed, onProgress, onCrash }) {
  const canvasRef = useRef(null);
  const cbRef = useRef({ onProgress, onCrash });
  useEffect(() => { cbRef.current = { onProgress, onCrash }; }, [onProgress, onCrash]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || seed == null) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    const rand = makePRNG(seed);
    const audio = createAudio();

    let W = 0, H = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      W = canvas.clientWidth || 360;
      H = canvas.clientHeight || 640;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const onResize = () => { resize(); render(performance.now()); };
    window.addEventListener('resize', onResize);

    // ── Pools (no per-frame allocation) ──
    const CAR_POOL = 40, PART_POOL = 220, FLOAT_POOL = 14, SMOKE_POOL = 60;
    const cars   = Array.from({ length: CAR_POOL },  () => ({ on: false, y: 0, lane: 0, v: null, color: '#fff', spd: 0, passed: false, near: false, brake: 0 }));
    const parts  = Array.from({ length: PART_POOL }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, age: 0, c: '#fff', s: 2, kind: 0 }));
    const floats = Array.from({ length: FLOAT_POOL }, () => ({ on: false, x: 0, y: 0, age: 0, life: 0, txt: '' }));
    const smoke  = Array.from({ length: SMOKE_POOL }, () => ({ on: false, x: 0, y: 0, age: 0, life: 0, r: 0 }));
    const take = (pool) => { for (let i = 0; i < pool.length; i++) if (!pool[i].on) return pool[i]; return null; };

    // ── State ──
    const S = {
      t0: performance.now(), elapsed: 0,
      dist: 0, speed: SPEED_START, score: 0,
      lane: 2, target: 2, tilt: 0,
      spawnIn: 1.0, lastFreeLane: 2,
      dead: false, deadAt: 0, freezeUntil: 0, shake: 0, flash: 0, fade: 0,
      lastPing: 0, combo: 0, comboAt: 0,
      lights: Array.from({ length: 9 }, (_, i) => ({ y: i * 260, side: i % 2 ? 1 : -1 })),
      reported: false,
    };

    // ── Projection ──
    const scaleMin = CAM_D / (CAM_D + VIEW);
    const scaleAt  = (y) => CAM_D / (CAM_D + clamp(y, -260, VIEW * 1.4));
    const screenYAt = (y) => {
      const pY = H * PLAYER_Y, tY = H * TOP_Y;
      const n = (1 - scaleAt(y)) / (1 - scaleMin);
      return pY - (pY - tY) * n;
    };
    const halfAt   = (y) => (W * ROAD_FRAC * 0.5) * scaleAt(y);
    const laneFrac = (lane) => ((lane + 0.5) / LANES) * 2 - 1;
    const laneXAt  = (lane, y) => W / 2 + laneFrac(lane) * halfAt(y) + S.tilt * 12;

    // ── Input ──
    const move = (d) => {
      if (S.dead) return;
      const n = clamp(Math.round(S.target) + d, 0, LANES - 1);
      if (n !== S.target) { S.target = n; S.tilt = d * 1; }
    };
    const onKey = (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { move(-1); e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { move(1); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);

    let tStartX = null, tStartT = 0;
    const onTS = (e) => { tStartX = e.touches[0].clientX; tStartT = performance.now(); audio?.resume(); };
    const onTE = (e) => {
      if (tStartX == null) return;
      const ex = e.changedTouches?.[0]?.clientX ?? tStartX;
      const dx = ex - tStartX;
      if (Math.abs(dx) > 22 && performance.now() - tStartT < 500) move(dx > 0 ? 1 : -1);
      else move(tStartX < canvas.getBoundingClientRect().width / 2 ? -1 : 1);
      tStartX = null;
    };
    canvas.addEventListener('touchstart', onTS, { passive: true });
    canvas.addEventListener('touchend', onTE, { passive: true });
    const onMD = (e) => {
      audio?.resume();
      const r = canvas.getBoundingClientRect();
      move(e.clientX - r.left < r.width / 2 ? -1 : 1);
    };
    canvas.addEventListener('mousedown', onMD);

    // ── Spawning ──
    // Cadence is TIME based: traffic closes at only ~half the player's speed, so
    // spacing by player-distance made real gaps ~45% tighter than intended.
    // We also guarantee an escape lane that is reachable from where the player is.
    function spawn() {
      const diff = clamp(S.elapsed / SPEED_RAMP, 0, 1);
      const maxBlock = diff < 0.2 ? 1 : diff < 0.45 ? 2 : LANES - 1;
      const n = 1 + Math.floor(rand() * maxBlock);

      // Keep a lane free that the player can actually reach: bias it toward the
      // lane they're in now.
      const cur = clamp(Math.round(S.lane), 0, LANES - 1);
      let free = cur;
      if (n >= LANES - 1) {
        // Hard wave: escape lane must be adjacent at most.
        const opts = [cur, cur - 1, cur + 1].filter(l => l >= 0 && l < LANES);
        free = opts[Math.floor(rand() * opts.length)];
      } else {
        free = Math.floor(rand() * LANES);
      }
      S.lastFreeLane = free;

      const lanes = [];
      for (let l = 0; l < LANES; l++) if (l !== free) lanes.push(l);
      for (let i = lanes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      }

      for (const ln of lanes.slice(0, Math.min(n, LANES - 1))) {
        const c = take(cars);
        if (!c) continue;
        const v = VEHICLES[Math.floor(rand() * VEHICLES.length)];
        c.on = true;
        c.y = VIEW + 140 + rand() * 120;
        c.lane = ln;
        c.v = v;
        c.color = PAINT[Math.floor(rand() * PAINT.length)];
        c.spd = SPEED_START * (v.spd[0] + rand() * (v.spd[1] - v.spd[0])) * (1 + diff * 0.4);
        c.near = false;
        c.brake = rand() < 0.2 ? 1 : 0;
      }

      // Waves get closer together as the run progresses, with a floor that keeps
      // the game readable at top speed.
      S.spawnIn = (1.35 - diff * 0.62) + rand() * (0.85 - diff * 0.45);
    }

    function addFloat(x, y, txt) {
      const f = take(floats); if (!f) return;
      f.on = true; f.x = x; f.y = y; f.age = 0; f.life = 0.9; f.txt = txt;
    }
    function burst(x, y) {
      for (let i = 0; i < 46; i++) {
        const p = take(parts); if (!p) break;
        const ang = rand() * Math.PI * 2, sp = 60 + rand() * 420;
        p.on = true; p.x = x; p.y = y;
        p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp - 90;
        p.life = 0.45 + rand() * 0.75; p.age = 0;
        p.kind = i < 16 ? 0 : i < 34 ? 1 : 2;           // spark | glass | smoke
        p.c = p.kind === 0 ? (rand() < 0.5 ? '#FFD84D' : '#FF8A3D')
            : p.kind === 1 ? '#CFE9FF' : '#6A6A72';
        p.s = p.kind === 2 ? 5 + rand() * 8 : 2 + rand() * 2.6;
      }
    }

    // ── Update ──
    function update(dt, now) {
      S.elapsed = now - S.t0;
      const diff = clamp(S.elapsed / SPEED_RAMP, 0, 1);
      S.speed = SPEED_START + (SPEED_MAX - SPEED_START) * (diff * diff * (3 - 2 * diff));
      S.dist += S.speed * dt;

      S.lane += (S.target - S.lane) * Math.min(1, dt * LANE_SNAP);
      S.tilt += (0 - S.tilt) * Math.min(1, dt * 6);

      S.score += S.speed * dt * PTS_DIST + dt * PTS_TIME;

      audio?.setSpeed(diff);

      // Street lights scroll toward the camera
      for (const l of S.lights) {
        l.y -= S.speed * dt;
        if (l.y < -140) { l.y += 260 * S.lights.length; l.side = -l.side; }
      }

      // Tyre smoke while changing lanes
      if (Math.abs(S.target - S.lane) > 0.12 && rand() < 0.5) {
        const sm = take(smoke);
        if (sm) {
          sm.on = true; sm.age = 0; sm.life = 0.45;
          sm.x = laneXAt(S.lane, 0) + (rand() - 0.5) * 16;
          sm.y = screenYAt(0) + 10;
          sm.r = 4 + rand() * 5;
        }
      }

      // Traffic
      for (const c of cars) {
        if (!c.on) continue;
        c.y -= (S.speed - c.spd) * dt;
        if (c.y < -300) { c.on = false; continue; }

        const dLane = Math.abs(c.lane - S.lane);
        const overlap = Math.abs(c.y) < (c.v.len + 92) * 0.5;

        // Collision — same lane and bodies overlapping
        if (!S.dead && dLane < 0.72 && overlap) {
          S.dead = true; S.deadAt = now;
          S.freezeUntil = now + FREEZE_MS;
          S.shake = 1; S.flash = 1;
          burst(laneXAt(S.lane, 0), screenYAt(0));
          audio?.crash();
          break;
        }
        // Near miss — adjacent lane, passing close
        if (!c.near && !S.dead && dLane >= 0.72 && dLane < 1.35 && overlap) {
          c.near = true;
          S.combo = (now - S.comboAt < 1400) ? S.combo + 1 : 1;
          S.comboAt = now;
          const pts = PTS_NEARMISS * Math.min(S.combo, 4);
          S.score += pts;
          S.flash = Math.max(S.flash, 0.32);
          addFloat(laneXAt(c.lane, c.y), screenYAt(c.y), `+${pts}`);
          audio?.whoosh();
        }
      }

      S.spawnIn -= dt;
      if (S.spawnIn <= 0) spawn();

      // Progress upstream (score + time)
      if (S.elapsed - S.lastPing > 320) {
        S.lastPing = S.elapsed;
        cbRef.current.onProgress?.(Math.floor(S.score), Math.floor(S.elapsed));
      }
    }

    function updateFX(dt) {
      S.shake = Math.max(0, S.shake - dt * 2.4);
      S.flash = Math.max(0, S.flash - dt * 3.4);
      for (const p of parts) {
        if (!p.on) continue;
        p.age += dt;
        if (p.age >= p.life) { p.on = false; continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vy += (p.kind === 2 ? -60 : 900) * dt;
        p.vx *= 0.99;
      }
      for (const f of floats) {
        if (!f.on) continue;
        f.age += dt; f.y -= 46 * dt;
        if (f.age >= f.life) f.on = false;
      }
      for (const sm of smoke) {
        if (!sm.on) continue;
        sm.age += dt; sm.r += 26 * dt; sm.y += 40 * dt;
        if (sm.age >= sm.life) sm.on = false;
      }
    }

    // ── Render ──
    function render(now) {
      const sx = S.shake ? (Math.random() - 0.5) * 18 * S.shake : 0;
      const sy = S.shake ? (Math.random() - 0.5) * 14 * S.shake : 0;

      ctx.fillStyle = '#05060A';
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(sx, sy);

      drawGround();
      drawRoad(now);
      drawStreetLights();

      // Smoke sits under the cars
      for (const sm of smoke) {
        if (!sm.on) continue;
        ctx.globalAlpha = 0.28 * (1 - sm.age / sm.life);
        ctx.fillStyle = '#9AA3AF';
        ctx.beginPath(); ctx.arc(sm.x, sm.y, sm.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Traffic far → near so nearer cars overlap correctly
      const list = [];
      for (const c of cars) if (c.on && c.y < VIEW * 1.25) list.push(c);
      list.sort((a, b) => b.y - a.y);
      for (const c of list) drawVehicle(c.y, c.lane, c.v, c.color, false, c.brake);

      if (!S.dead) drawVehicle(0, S.lane, { k: 'player', len: 96, w: 0.64 }, '#1250B4', true, 0);

      drawParticles();
      drawFloats();

      ctx.restore();

      if (S.flash > 0) {
        ctx.fillStyle = `rgba(190,230,255,${0.42 * S.flash})`;
        ctx.fillRect(0, 0, W, H);
      }
      drawVignette();
      drawHUD();

      if (S.fade > 0) {
        ctx.fillStyle = `rgba(0,0,0,${clamp(S.fade, 0, 1)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function drawGround() {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#080B14');
      g.addColorStop(1, '#04050A');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    function drawRoad(now) {
      const steps = 26;
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const y = VIEW * (i / steps);
        pts.push({ y, sy: screenYAt(y), half: halfAt(y) });
      }

      // Asphalt
      ctx.beginPath();
      ctx.moveTo(W / 2 - pts[0].half + S.tilt * 12, pts[0].sy);
      for (const p of pts) ctx.lineTo(W / 2 - p.half + S.tilt * 12, p.sy);
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(W / 2 + pts[i].half + S.tilt * 12, pts[i].sy);
      ctx.closePath();
      const rg = ctx.createLinearGradient(0, screenYAt(VIEW), 0, H);
      rg.addColorStop(0, '#14161C');
      rg.addColorStop(1, '#20232B');
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.save();
      ctx.clip();

      // Animated texture — scrolling darker bands
      const band = 150;
      const off = S.dist % band;
      ctx.fillStyle = 'rgba(0,0,0,0.13)';
      for (let y = -off; y < VIEW + band; y += band) {
        const a = screenYAt(y), b = screenYAt(y + band * 0.5);
        ctx.fillRect(0, b, W, a - b);
      }

      // Wet sheen / reflection down the middle
      const sheen = ctx.createLinearGradient(W / 2 - W * 0.3, 0, W / 2 + W * 0.3, 0);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.5, 'rgba(120,180,255,0.045)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, screenYAt(VIEW), W, H);

      // Lane markings — dashed, perspective-correct
      const dash = 120;
      const doff = S.dist % (dash * 2);
      for (let l = 1; l < LANES; l++) {
        for (let y = -doff; y < VIEW; y += dash * 2) {
          const y2 = y + dash;
          if (y2 < 0) continue;
          const a = Math.max(y, 0);
          const s1 = screenYAt(a), s2 = screenYAt(y2);
          const h1 = halfAt(a), h2 = halfAt(y2);
          const f = (l / LANES) * 2 - 1;
          const x1 = W / 2 + f * h1 + S.tilt * 12, x2 = W / 2 + f * h2 + S.tilt * 12;
          const w1 = Math.max(1.2, h1 * 0.016), w2 = Math.max(0.9, h2 * 0.016);
          ctx.fillStyle = 'rgba(232,238,246,0.82)';
          ctx.beginPath();
          ctx.moveTo(x1 - w1, s1); ctx.lineTo(x1 + w1, s1);
          ctx.lineTo(x2 + w2, s2); ctx.lineTo(x2 - w2, s2);
          ctx.closePath(); ctx.fill();
        }
      }
      ctx.restore();

      // Solid edge lines
      for (const side of [-1, 1]) {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = W / 2 + side * (p.half - p.half * 0.03) + S.tilt * 12;
          i === 0 ? ctx.moveTo(x, p.sy) : ctx.lineTo(x, p.sy);
        });
        ctx.strokeStyle = 'rgba(236,242,250,0.9)';
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }

      // Guard rails with a subtle brand-blue top edge
      for (const side of [-1, 1]) {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = W / 2 + side * (p.half * 1.055) + S.tilt * 12;
          i === 0 ? ctx.moveTo(x, p.sy) : ctx.lineTo(x, p.sy);
        });
        ctx.strokeStyle = '#3A414D';
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(18,80,180,0.75)';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Posts
        const postGap = 130;
        const poff = S.dist % postGap;
        for (let y = -poff; y < VIEW; y += postGap) {
          if (y < 0) continue;
          const sYa = screenYAt(y), ha = halfAt(y), sc = scaleAt(y);
          const x = W / 2 + side * ha * 1.055 + S.tilt * 12;
          ctx.fillStyle = '#2A303A';
          ctx.fillRect(x - 2 * sc, sYa, 4 * sc, 13 * sc);
        }
      }
    }

    function drawStreetLights() {
      for (const l of S.lights) {
        if (l.y < -60 || l.y > VIEW) continue;
        const sy = screenYAt(l.y), sc = scaleAt(l.y), half = halfAt(l.y);
        const baseX = W / 2 + l.side * half * 1.16 + S.tilt * 12;
        const poleH = 92 * sc;
        const armLen = half * 0.34;
        // Pool of light on the asphalt
        ctx.save();
        ctx.globalAlpha = 0.16;
        const lg = ctx.createRadialGradient(baseX - l.side * armLen, sy, 0, baseX - l.side * armLen, sy, half * 0.75);
        lg.addColorStop(0, '#FFE9B8');
        lg.addColorStop(1, 'rgba(255,233,184,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.ellipse(baseX - l.side * armLen, sy, half * 0.62, half * 0.3, 0, 0, 6.283);
        ctx.fill();
        ctx.restore();
        // Pole + arm
        ctx.strokeStyle = '#39404B';
        ctx.lineWidth = Math.max(1.4, 3 * sc);
        ctx.beginPath();
        ctx.moveTo(baseX, sy);
        ctx.lineTo(baseX, sy - poleH);
        ctx.lineTo(baseX - l.side * armLen, sy - poleH);
        ctx.stroke();
        // Lamp
        ctx.save();
        ctx.shadowColor = '#FFD98A'; ctx.shadowBlur = 14 * sc;
        ctx.fillStyle = '#FFE9B8';
        ctx.fillRect(baseX - l.side * armLen - 4 * sc, sy - poleH - 2 * sc, 8 * sc, 4 * sc);
        ctx.restore();
      }
    }

    // Top-down-ish vehicle: roof + glass + lights + wheels + shadow
    function drawVehicle(y, lane, v, color, isPlayer, brake) {
      const sc = scaleAt(y);
      if (sc <= 0.02) return;
      const frontY = screenYAt(y + v.len * 0.5);
      const rearY  = screenYAt(y - v.len * 0.5);
      const h = Math.max(6, rearY - frontY);
      const half = halfAt(y);
      const laneW = (half * 2) / LANES;
      const w = laneW * v.w;
      const cx = laneXAt(lane, y);
      const cy = (frontY + rearY) / 2;
      const isSemi = v.k === 'semi';

      // Shadow
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = '#000';
      rr(cx - w / 2 + w * 0.06, frontY + h * 0.05, w, h, Math.min(w, h) * 0.18);
      ctx.fill();
      ctx.restore();

      if (isSemi) {
        // Trailer
        const tH = h * 0.66;
        const body = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
        body.addColorStop(0, sh(color, -34)); body.addColorStop(0.42, sh(color, 6)); body.addColorStop(1, sh(color, -44));
        ctx.fillStyle = body;
        rr(cx - w / 2, frontY + h * 0.34, w, tH, w * 0.1); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
        // Ribs
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        for (let i = 1; i < 6; i++) ctx.fillRect(cx - w / 2, frontY + h * 0.34 + (tH / 6) * i, w, Math.max(0.7, h * 0.006));
        // Cab
        const cH = h * 0.3;
        ctx.fillStyle = sh(color, 16);
        rr(cx - w * 0.46, frontY, w * 0.92, cH, w * 0.12); ctx.fill();
        ctx.fillStyle = 'rgba(150,205,255,0.5)';
        rr(cx - w * 0.34, frontY + cH * 0.26, w * 0.68, cH * 0.42, w * 0.06); ctx.fill();
      } else {
        // Body
        const body = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
        body.addColorStop(0, sh(color, -30));
        body.addColorStop(0.4, sh(color, 10));
        body.addColorStop(0.72, color);
        body.addColorStop(1, sh(color, -40));
        ctx.fillStyle = body;
        rr(cx - w / 2, frontY, w, h, Math.min(w, h) * 0.2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.32)'; ctx.lineWidth = 1; ctx.stroke();

        // Wheels peeking at the sides
        ctx.fillStyle = '#121418';
        const ww = Math.max(1.5, w * 0.1), wh = Math.max(2.5, h * 0.17);
        ctx.fillRect(cx - w / 2 - ww * 0.45, frontY + h * 0.18, ww, wh);
        ctx.fillRect(cx + w / 2 - ww * 0.55, frontY + h * 0.18, ww, wh);
        ctx.fillRect(cx - w / 2 - ww * 0.45, frontY + h * 0.66, ww, wh);
        ctx.fillRect(cx + w / 2 - ww * 0.55, frontY + h * 0.66, ww, wh);

        // Roof — inset panel reads as height from 60°
        const rw = w * (v.k === 'sports' ? 0.62 : 0.7), rh = h * (v.k === 'van' ? 0.6 : 0.46);
        ctx.fillStyle = sh(color, -14);
        rr(cx - rw / 2, frontY + h * (v.k === 'van' ? 0.2 : 0.28), rw, rh, rw * 0.14); ctx.fill();

        // Windscreen + rear glass
        ctx.fillStyle = 'rgba(160,210,255,0.42)';
        rr(cx - rw * 0.46, frontY + h * 0.15, rw * 0.92, h * 0.13, rw * 0.06); ctx.fill();
        ctx.fillStyle = 'rgba(140,190,240,0.3)';
        rr(cx - rw * 0.44, frontY + h * (v.k === 'van' ? 0.78 : 0.72), rw * 0.88, h * 0.11, rw * 0.06); ctx.fill();

        // Roof highlight
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(cx - rw * 0.36, frontY + h * 0.3, rw * 0.2, rh * 0.72);
      }

      // Headlights (cast forward, up-screen)
      if (sc > 0.28) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        const hg = ctx.createLinearGradient(0, frontY, 0, frontY - h * 1.3);
        hg.addColorStop(0, 'rgba(255,248,214,0.55)');
        hg.addColorStop(1, 'rgba(255,248,214,0)');
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.36, frontY);
        ctx.lineTo(cx - w * 0.7, frontY - h * 1.25);
        ctx.lineTo(cx + w * 0.7, frontY - h * 1.25);
        ctx.lineTo(cx + w * 0.36, frontY);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#FFF6D0';
      const hw = Math.max(1.4, w * 0.17), hh = Math.max(1.2, h * 0.045);
      ctx.fillRect(cx - w * 0.4, frontY, hw, hh);
      ctx.fillRect(cx + w * 0.4 - hw, frontY, hw, hh);

      // Tail lights — brighter when braking
      const tOn = brake ? '#FF3B2F' : '#C42B22';
      ctx.save();
      if (brake) { ctx.shadowColor = '#FF3B2F'; ctx.shadowBlur = 12 * sc; }
      ctx.fillStyle = isPlayer ? '#FF5A47' : tOn;
      ctx.fillRect(cx - w * 0.4, rearY - Math.max(1.4, h * 0.055), hw, Math.max(1.4, h * 0.05));
      ctx.fillRect(cx + w * 0.4 - hw, rearY - Math.max(1.4, h * 0.055), hw, Math.max(1.4, h * 0.05));
      ctx.restore();

      // Player underglow — brand blue, sells "your car"
      if (isPlayer) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        const ug = ctx.createRadialGradient(cx, rearY, 0, cx, rearY, w * 1.1);
        ug.addColorStop(0, 'rgba(0,191,255,0.5)');
        ug.addColorStop(1, 'rgba(0,191,255,0)');
        ctx.fillStyle = ug;
        ctx.beginPath(); ctx.ellipse(cx, cy + h * 0.4, w * 0.95, h * 0.34, 0, 0, 6.283); ctx.fill();
        ctx.restore();
      }
    }

    function drawParticles() {
      for (const p of parts) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = clamp(a, 0, 1) * (p.kind === 2 ? 0.4 : 1);
        ctx.fillStyle = p.c;
        if (p.kind === 0) { ctx.shadowColor = p.c; ctx.shadowBlur = 8; }
        if (p.kind === 2) { ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 6.283); ctx.fill(); }
        else ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    }

    function drawFloats() {
      ctx.textAlign = 'center';
      for (const f of floats) {
        if (!f.on) continue;
        const a = 1 - f.age / f.life;
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.font = '900 19px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#00BFFF';
        ctx.shadowColor = '#00BFFF'; ctx.shadowBlur = 12;
        ctx.fillText(f.txt, f.x, f.y);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    }

    function drawVignette() {
      const v = ctx.createRadialGradient(W / 2, H * 0.6, Math.min(W, H) * 0.34, W / 2, H * 0.6, Math.max(W, H) * 0.82);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.66)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);
    }

    // Only score + time, per spec.
    function drawHUD() {
      const score = Math.floor(S.score);
      ctx.textAlign = 'left';
      ctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = '#F2F8FF';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 8;
      ctx.fillText(score.toLocaleString(), 18, 46);
      ctx.font = '800 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(190,215,240,0.85)';
      ctx.fillText('SCORE', 19, 62);

      ctx.textAlign = 'right';
      ctx.font = '900 22px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = '#F2F8FF';
      ctx.fillText((S.elapsed / 1000).toFixed(1) + 's', W - 18, 44);
      ctx.font = '800 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(190,215,240,0.85)';
      ctx.fillText('TIME', W - 19, 62);
      ctx.shadowBlur = 0;
    }

    // ── Loop ──
    // One simulation step. Shared by the render loop and by tests.
    function tick(dt, now) {
      if (!S.dead) {
        update(dt, now);
        updateFX(dt);
        return;
      }
      // Freeze frame, then FX + fade, then hand the run to the page.
      if (now >= S.freezeUntil) {
        updateFX(dt);
        S.fade = Math.min(1, S.fade + dt * 1.5);
        if (!S.reported && now - S.deadAt > FREEZE_MS + 420) {
          S.reported = true;
          cbRef.current.onCrash?.(Math.floor(S.score), Math.floor(S.elapsed));
        }
      }
    }

    let raf = 0, last = performance.now();
    function loop(now) {
      raf = requestAnimationFrame(loop);
      let dt = (now - last) / 1000;
      last = now;
      dt = Math.min(dt, 1 / 30); // clamp so a stall can't teleport the player
      tick(dt, now);
      render(now);
    }

    function rr(x, y, w, h, r) {
      const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    }

    render(performance.now());
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('touchstart', onTS);
      canvas.removeEventListener('touchend', onTE);
      canvas.removeEventListener('mousedown', onMD);
      audio?.stop();
    };
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative w-full" style={{ height: 'calc(100dvh - 56px)', background: '#05060A' }}>
      <canvas ref={canvasRef} className="w-full h-full block touch-none select-none" />
    </div>
  );
}

function sh(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
  return `rgb(${c(((n >> 16) & 255) + amt)},${c(((n >> 8) & 255) + amt)},${c((n & 255) + amt)})`;
}
