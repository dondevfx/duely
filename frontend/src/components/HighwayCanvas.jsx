import { useEffect, useRef } from 'react';
import { isMuted } from '../utils/sound';
import { sedanSVG, rasterize } from './rushHourArt';

// ── Authored sprite cache ───────────────────────────────────────────────────
// Vehicles authored as SVG are rasterized once per (class, paint, size) and
// then blitted like any other sprite. Rasterizing is asynchronous, so a flat
// placeholder is drawn until the real art resolves — a frame or two at load,
// and never mid-run because the size only changes on resize.
const SVG_ART = { sedan: sedanSVG };
const svgCache = new Map();
function authoredSprite(kind, paint, wpx, lpx, dpr) {
  const build = SVG_ART[kind];
  if (!build) return null;
  const key = `${kind}|${paint}|${Math.round(wpx)}x${Math.round(lpx)}@${dpr}`;
  const hit = svgCache.get(key);
  if (hit) return hit === 'pending' ? null : hit;
  svgCache.set(key, 'pending');
  // Rasterize at DEVICE pixels and blit at CSS size. Baking at CSS size and
  // letting the 2x backing store scale it up is what makes sprites look soft
  // on a phone or a retina display.
  rasterize(build(paint), wpx * dpr, lpx * dpr)
    .then((c) => svgCache.set(key, c))
    .catch(() => svgCache.delete(key));
  return null;
}

/**
 * HIGHWAY DASH — gameplay canvas. Complete rebuild.
 *
 * Premium arcade lane-weaver. Near top-down camera, close to the action.
 * One responsive game: identical world units, hitboxes, spawning and scoring on
 * every device — only pixel scale differs.
 *
 * Art system: every vehicle and road tile is BAKED to an offscreen sprite once
 * (high detail: panel lines, glass with reflections, baked bloom on emissives),
 * then the frame loop is pure drawImage + gradients. No shadowBlur per frame.
 *
 * Fairness: traffic comes from the shared server seed via a "snaking corridor"
 * spawner — the guaranteed-free lane random-walks one lane per wave, so a
 * survivable path always exists and BOTH players face identical traffic.
 * AI lane changes fire on deterministic thresholds (never conditioned on the
 * local player), keeping the two simulations in lockstep.
 *
 * Integration (unchanged): props { seed, onProgress(score,ms), onCrash(score,ms) }.
 * In-canvas UI only: score, time, GO flash, small pause button, game-over overlay.
 */

// ── World tuning (units: 1 lane = 100u, sedan ≈ 95u long) ───────────────────
const LANES        = 4;
const LANE_U       = 100;
const VIEW_AHEAD   = 700;    // world units visible above the player — fixed on all devices
const PLAYER_YF    = 0.78;   // player screen position (fraction of height)
const SPAWN_Y      = 880;    // > VIEW_AHEAD + longest vehicle, so nothing pops in
const DESPAWN_Y    = -280;

const SPD_START    = 585;    // u/s
const SPD_MAX      = 1150;
const RAMP_S       = 48;     // seconds to reach max speed
// Past RAMP_S the run keeps escalating instead of flat-lining.
const OD_S         = 70;     // seconds per unit of "overdrive"
const OD_MAX       = 1.8;
const OD_SPEED     = 300;    // extra u/s at full overdrive
const OD_CLOSE     = 170;    // extra closing speed at full overdrive
const CLOSE_MIN    = 225;    // closing speed floor (u/s)
const CLOSE_MAX    = 565;    // closing speed at full difficulty
const VISUAL_SCROLL = 1.0;   // road MUST scroll with the world or it slides under the cars

const PTS_DIST     = 0.06;
const PTS_TIME     = 8;
const PTS_NEAR     = 75;

const FREEZE_S     = 0.15;
const REPORT_S     = 0.55;   // report as soon as the crash FX has read
const OVERLAY_S    = 1.05;   // only show GAME OVER if we're still here (i.e. waiting)

const HIT_FORGIVE  = 0.88;   // hitbox forgiveness factor

// Duely palette
const CYAN  = '#00BFFF';
const BLUE  = '#1250B4';

// ── Lane marking cadence ────────────────────────────────────────────────────
// Chosen from the frame budget, not by eye. Top speed is SPD_MAX + OD_SPEED =
// 1450 u/s, i.e. ~24.2u of travel per frame at 60fps. A marking cycle shorter
// than ~6 frames beats against the refresh rate and the road appears to blink
// out, which is exactly what the previous art did. 70 + 80 = 150u gives 6.2
// frames per cycle at maximum speed, with margin.
const MARK_LEN = 70;
const MARK_GAP = 80;
const MARK_CYCLE = MARK_LEN + MARK_GAP;
const ICE   = '#9FDCFF';

// Sizes are in world units and drive BOTH the sprite and the hitbox, so art and
// collision can never drift apart.
const VEHICLES = {
  sedan:  { len: 81,  wid: 53, close: 1.00, weight: 26 },
  suv:    { len: 90,  wid: 58, close: 1.05, weight: 20 },
  pickup: { len: 95,  wid: 56, close: 1.05, weight: 14 },
  sports: { len: 75,  wid: 51, close: 0.78, weight: 14 },
  van:    { len: 107, wid: 60, close: 1.12, weight: 14 },
  semi:   { len: 174, wid: 66, close: 1.22, weight: 8  },
};
const PLAYER_W_U = 56;   // player world width  (sprite + hitbox)
const PLAYER_L_U = 117;  // player world length (sprite + hitbox)
const VKEYS = Object.keys(VEHICLES);
const VTOTAL = VKEYS.reduce((a, k) => a + VEHICLES[k].weight, 0);

const PAINTS = [
  '#B33A3A', '#C77B2F', '#C9B33B', '#3E8E57', '#3D74B8', '#6E56C4',
  '#B04A7E', '#C9CFD8', '#6E7580', '#23282F', '#2E9E96', '#C2542E',
];

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = (t) => t * t * (3 - 2 * t);

function makePRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SPRITE BAKERY — draw once, blit forever
// ─────────────────────────────────────────────────────────────────────────────
function bake(w, h, fn) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.ceil(w));
  c.height = Math.max(2, Math.ceil(h));
  const g = c.getContext('2d');
  fn(g, c.width, c.height);
  return c;
}

function rr(g, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
  return `rgb(${c(((n >> 16) & 255) + amt)},${c(((n >> 8) & 255) + amt)},${c((n & 255) + amt)})`;
}

// Baked glow disc (runtime bloom without shadowBlur)
function bakeGlow(hex, r) {
  const n = parseInt(hex.slice(1), 16);
  const rc = (n >> 16) & 255, gc = (n >> 8) & 255, bc = n & 255;
  return bake(r * 2, r * 2, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, `rgba(${rc},${gc},${bc},0.9)`);
    gr.addColorStop(0.4, `rgba(${rc},${gc},${bc},0.32)`);
    gr.addColorStop(1, `rgba(${rc},${gc},${bc},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
}

function bakeSoftShadow(w, h) {
  return bake(w, h, (g, W, H) => {
    const gr = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)');
    gr.addColorStop(0.7, 'rgba(0,0,0,0.28)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(1, H / W);
    g.translate(-W / 2, -W / 2);
    g.fillStyle = gr;
    g.fillRect(0, H / 2 - W / 2, W, W);
    g.restore();
  });
}

// -- Traffic vehicle sprite ------------------------------------------------
// House style: graphite hulls with hard chamfered geometry and a single bold
// livery wrap, lit by the road's neon (cool rim on the left, warm bounce on the
// right). Colour identifies a vehicle at a glance without turning the highway
// into a rainbow -- they read as one fleet, clearly distinct from the player's
// glowing blue Interceptor.
// ─────────────────────────────────────────────────────────────────────────────
//  PLACEHOLDER VEHICLE ART
//  Intentionally flat. Real authored sprite art lands in the next step; these
//  exist only so the road and lighting can be judged on their own.
// ─────────────────────────────────────────────────────────────────────────────
function bakeVehicle(kind, paint, wpx, lpx) {
  return bake(wpx, lpx, (g, w, l) => {
    g.fillStyle = paint;
    rr(g, 0, 0, w, l, Math.min(w, l) * 0.16); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2;
    rr(g, 1, 1, w - 2, l - 2, Math.min(w, l) * 0.16); g.stroke();
    // a lighter band at the nose so orientation stays readable
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.fillRect(w * 0.12, l * 0.06, w * 0.76, l * 0.1);
  });
}

function bakePlayer(wpx, lpx) {
  return bake(wpx, lpx, (g, w, l) => {
    g.fillStyle = BLUE;
    rr(g, 0, 0, w, l, Math.min(w, l) * 0.16); g.fill();
    g.strokeStyle = CYAN; g.lineWidth = 2;
    rr(g, 1, 1, w - 2, l - 2, Math.min(w, l) * 0.16); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.fillRect(w * 0.12, l * 0.06, w * 0.76, l * 0.1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUDIO — engine, wind, whoosh, crash (Web Audio synth; respects site mute)
// ─────────────────────────────────────────────────────────────────────────────
function createAudio() {
  if (isMuted()) return null;
  let actx;
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  if (!actx) return null;
  const master = actx.createGain(); master.gain.value = 0.5; master.connect(actx.destination);

  const eg = actx.createGain(); eg.gain.value = 0;
  const ef = actx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 480;
  const o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 58;
  const o2 = actx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 89;
  o1.connect(ef); o2.connect(ef); ef.connect(eg); eg.connect(master);
  o1.start(); o2.start();

  const nBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const wind = actx.createBufferSource(); wind.buffer = nBuf; wind.loop = true;
  const wf = actx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 850; wf.Q.value = 0.7;
  const wg = actx.createGain(); wg.gain.value = 0;
  wind.connect(wf); wf.connect(wg); wg.connect(master);
  wind.start();

  return {
    resume() { if (actx.state === 'suspended') actx.resume().catch(() => {}); },
    setSpeed(t) {
      const now = actx.currentTime;
      eg.gain.setTargetAtTime(0.05 + t * 0.055, now, 0.15);
      o1.frequency.setTargetAtTime(56 + t * 78, now, 0.2);
      o2.frequency.setTargetAtTime(86 + t * 116, now, 0.2);
      ef.frequency.setTargetAtTime(420 + t * 1600, now, 0.25);
      wg.gain.setTargetAtTime(0.012 + t * 0.08, now, 0.2);
      wf.frequency.setTargetAtTime(720 + t * 1200, now, 0.25);
    },
    duck() {
      eg.gain.setTargetAtTime(0, actx.currentTime, 0.06);
      wg.gain.setTargetAtTime(0, actx.currentTime, 0.06);
    },
    whoosh() {
      const t0 = actx.currentTime;
      const s = actx.createBufferSource(); s.buffer = nBuf;
      const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.7;
      f.frequency.setValueAtTime(1600, t0);
      f.frequency.exponentialRampToValueAtTime(300, t0 + 0.24);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.26, t0 + 0.035);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0); s.stop(t0 + 0.3);
    },
    crash() {
      const t0 = actx.currentTime;
      const s = actx.createBufferSource(); s.buffer = nBuf;
      const f = actx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(2800, t0);
      f.frequency.exponentialRampToValueAtTime(150, t0 + 0.5);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.75, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0); s.stop(t0 + 0.7);
      const th = actx.createOscillator(); th.type = 'sine';
      const tg = actx.createGain();
      th.frequency.setValueAtTime(140, t0);
      th.frequency.exponentialRampToValueAtTime(34, t0 + 0.44);
      tg.gain.setValueAtTime(0.7, t0);
      tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.52);
      th.connect(tg); tg.connect(master);
      th.start(t0); th.stop(t0 + 0.55);
      this.duck();
    },
    stop() { try { o1.stop(); o2.stop(); wind.stop(); actx.close(); } catch { /* noop */ } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function HighwayCanvas({ seed, onProgress, onCrash }) {
  const canvasRef = useRef(null);
  const cbRef = useRef({ onProgress, onCrash });
  useEffect(() => { cbRef.current = { onProgress, onCrash }; }, [onProgress, onCrash]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || seed == null) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    const rand = makePRNG(seed);        // gameplay randomness — identical for both players
    const frand = Math.random;          // FX-only randomness
    const audio = createAudio();

    // ── Layout (fixed view distance in units ⇒ identical gameplay everywhere) ──
    let W = 0, H = 0, u2p = 1, roadW = 0, laneW = 0, roadX = 0, playerY = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let sprites = null;

    function layout() {
      W = canvas.clientWidth || 360;
      H = canvas.clientHeight || 640;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      playerY = H * PLAYER_YF;
      u2p = Math.min((playerY - H * 0.02) / VIEW_AHEAD, (W * 0.965) / (LANES * LANE_U));
      laneW = LANE_U * u2p;
      roadW = laneW * LANES;
      roadX = (W - roadW) / 2;
      bakeAll();
    }

    // Site theme — the off-road surround must match the page behind it.
    // Checked per frame so switching theme applies without a re-bake.
    const isLight = () => document.documentElement.classList.contains('light');

    function bakeAll() {
      const vs = {};
      const playerW = PLAYER_W_U * u2p, playerL = PLAYER_L_U * u2p;
      sprites = {
        vs,
        vkey(kind, paint) {
          const wpx = VEHICLES[kind].wid * u2p, lpx = VEHICLES[kind].len * u2p;
          const art = authoredSprite(kind, paint, wpx, lpx, dpr);
          if (art) return art;
          const k = kind + '|' + paint;
          if (!vs[k]) vs[k] = bakeVehicle(kind, paint, wpx, lpx);
          return vs[k];
        },
        player: bakePlayer(playerW, playerL),
        playerW, playerL,
        shadow: bakeSoftShadow(140, 210),
        glowCyan: bakeGlow(CYAN, 60),
        glowRed: bakeGlow('#FF3B30', 34),
        glowAmber: bakeGlow('#FFB020', 26),
        glowWhite: bakeGlow('#FFF6D8', 40),
        smokePuff: bake(48, 48, (g, w, h) => {
          const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
          gr.addColorStop(0, 'rgba(176,190,210,0.5)');
          gr.addColorStop(1, 'rgba(176,190,210,0)');
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
        }),
        vignette: bake(W, H, (g) => {
          const v = g.createRadialGradient(W / 2, H * 0.62, Math.min(W, H) * 0.34, W / 2, H * 0.62, Math.max(W, H) * 0.82);
          v.addColorStop(0, 'rgba(0,0,0,0)');
          v.addColorStop(1, 'rgba(0,0,0,0.62)');
          g.fillStyle = v; g.fillRect(0, 0, W, H);
        }),
        edgeFlash: bake(W, H, (g) => {
          const v = g.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.3, W / 2, H * 0.55, Math.max(W, H) * 0.72);
          v.addColorStop(0, 'rgba(0,191,255,0)');
          v.addColorStop(1, 'rgba(0,191,255,0.5)');
          g.fillStyle = v; g.fillRect(0, 0, W, H);
        }),

      };
    }
    layout();
    let resizeT = 0;
    const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(layout, 120); };
    window.addEventListener('resize', onResize);

    // ── Pools ──
    const cars = Array.from({ length: 34 }, () => ({
      on: false, kind: 'sedan', paint: PAINTS[0], y: 0, lane: 0, laneF: 0,
      spd: 0, near: false, sig: 0, sigDir: 0, changeAt: -1, changing: 0, brake: false,
    }));
    const parts = Array.from({ length: 200 }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, age: 0, s: 2, kind: 0, c: '' }));
    const floats = Array.from({ length: 12 }, () => ({ on: false, x: 0, y: 0, age: 0, life: 0, txt: '' }));
    const puffs = Array.from({ length: 48 }, () => ({ on: false, x: 0, y: 0, age: 0, life: 0, s: 1 }));
    const take = (pool) => { for (let i = 0; i < pool.length; i++) if (!pool[i].on) return pool[i]; return null; };

    // ── State (sim-clock: pausing stops score AND reported time) ──
    const S = {
      simT: 0, dist: 0, speed: SPD_START, score: 0,
      laneX: LANE_U * 1.5, laneVel: 0, targetLane: 1,
      corridor: 2,
      waveIn: 0.55, waveN: 0,
      changeCooldown: 0,
      combo: 0, comboT: -9,
      flash: 0, shake: 0, scorePop: 0,
      dead: false, deadT: 0, reported: false,
      lastPing: 0,
      goT: 0, hintT: 0,
      event: null, eventY: 0, nextEventAt: 6 + rand() * 4, tunnelUntil: -1, tunnelA: 0,
      poles: Array.from({ length: 5 }, (_, i) => ({ y: i * 300, side: i % 2 ? 1 : -1 })),
    };

    const diff = () => smooth(clamp(S.simT / RAMP_S, 0, 1));
    // Overdrive keeps speed, density and aggression climbing after the ramp.
    const over = () => clamp((S.simT - RAMP_S) / OD_S, 0, OD_MAX);
    const laneCenter = (l) => (l + 0.5) * LANE_U;

    // ── Input ──
    // Every input retargets immediately. Nothing is ever queued or ignored, so
    // reversing mid-change (left then instantly right) responds on the frame it
    // was pressed rather than finishing the previous move first.
    function move(dir) {
      if (S.dead) return;
      const nxt = clamp(S.targetLane + dir, 0, LANES - 1);
      if (nxt === S.targetLane) return;
      S.targetLane = nxt;
    }
    const onKey = (e) => {
      if (e.repeat) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { audio?.resume(); move(-1); e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { audio?.resume(); move(1); e.preventDefault(); }
    };
    // Touch = swipe. You go the way you swipe, and a long swipe can cross more
    // than one lane. The gesture fires as soon as it passes the threshold rather
    // than waiting for release, so it feels immediate.
    const sw = { active: false, id: null, startX: 0, fired: false };
    const swipeMin = () => Math.max(26, canvas.clientWidth * 0.055);

    const onPointerDown = (e) => {
      audio?.resume();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      sw.active = true; sw.id = e.pointerId;
      sw.startX = x; sw.fired = false;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ } }
    };
    const onPointerMove = (e) => {
      if (!sw.active || sw.fired || e.pointerId !== sw.id) return;
      const r = canvas.getBoundingClientRect();
      const dx = (e.clientX - r.left) - sw.startX;
      // Exactly ONE lane per swipe, however far the finger travels. Lift and
      // swipe again to move another lane.
      if (Math.abs(dx) >= swipeMin()) { move(dx > 0 ? 1 : -1); sw.fired = true; }
    };
    const onPointerUp = (e) => {
      if (!sw.active || e.pointerId !== sw.id) return;
      // No swipe registered => treat it as a tap on that half of the screen.
      if (!sw.fired) {
        const r = canvas.getBoundingClientRect();
        move((e.clientX - r.left) < r.width / 2 ? -1 : 1);
      }
      sw.active = false; sw.id = null;
      if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ } }
    };
    window.addEventListener('keydown', onKey);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // ── Spawning: snaking corridor — deterministic AND always survivable ──
    function pick() {
      let r = rand() * VTOTAL;
      for (const k of VKEYS) { r -= VEHICLES[k].weight; if (r <= 0) return k; }
      return 'sedan';
    }
    function laneHeadway(l) {
      let min = 1e9;
      for (const c of cars) if (c.on && Math.round(c.laneF) === l && c.y > 300) min = Math.min(min, SPAWN_Y - c.y);
      return min;
    }
    function spawnWave() {
      const d = diff();
      S.waveN++;
      // The free lane random-walks ±1 → a weaveable path always exists.
      const step = rand();
      S.corridor = clamp(S.corridor + (step < 0.36 ? -1 : step < 0.72 ? 1 : 0), 0, LANES - 1);

      const maxBlock = S.simT < 9 ? 1 : S.simT < 24 ? 2 : 3;
      let n = 1 + Math.floor(rand() * maxBlock);
      if (S.waveN % 6 === 0) n = Math.max(1, n - 1); // breathing pocket

      const lanes = [];
      for (let l = 0; l < LANES; l++) if (l !== S.corridor) lanes.push(l);
      for (let i = lanes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      }
      const closing = CLOSE_MIN + (CLOSE_MAX - CLOSE_MIN) * d + over() * OD_CLOSE;
      for (const l of lanes.slice(0, n)) {
        if (laneHeadway(l) < closing * 0.95 + 190) continue; // deterministic headway guard
        const c = take(cars); if (!c) continue;
        const kind = pick();
        c.on = true; c.kind = kind;
        c.paint = PAINTS[Math.floor(rand() * PAINTS.length)];
        c.y = SPAWN_Y + rand() * 70;
        c.laneF = l; c.lane = l;
        c.spd = S.speed - closing * VEHICLES[kind].close * (0.86 + rand() * 0.28);
        c.near = false; c.brake = rand() < 0.16;
        c.sig = 0; c.sigDir = 0; c.changing = 0;
        // pre-rolled lane change — deterministic, fires only well ahead of the player
        c.changeAt = (S.simT > 11 && kind !== 'semi' && rand() < 0.18 + d * 0.22 + over() * 0.12) ? S.simT + 0.8 + rand() * 2.0 : -1;
      }
      S.waveIn = Math.max(0.28, (1.16 - d * 0.72 - over() * 0.16) + rand() * Math.max(0.14, 0.6 - d * 0.28 - over() * 0.1));
    }

    // ── FX helpers ──
    function addFloat(x, y, txt) {
      const f = take(floats); if (!f) return;
      f.on = true; f.x = x; f.y = y; f.age = 0; f.life = 0.85; f.txt = txt;
    }
    function puffAt(x, y, s) {
      const p = take(puffs); if (!p) return;
      p.on = true; p.x = x; p.y = y; p.age = 0; p.life = 0.4 + frand() * 0.2; p.s = s;
    }
    function crashBurst(x, y) {
      for (let i = 0; i < 54; i++) {
        const p = take(parts); if (!p) break;
        const ang = frand() * 6.283, sp = 60 + frand() * 460;
        p.on = true; p.x = x; p.y = y;
        p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp - 100;
        p.age = 0;
        if (i < 20)      { p.kind = 0; p.c = frand() < 0.5 ? '#FFD84D' : '#FF8A3D'; p.s = 2 + frand() * 2.4; p.life = 0.4 + frand() * 0.5; }
        else if (i < 40) { p.kind = 1; p.c = '#CFE9FF'; p.s = 2 + frand() * 3;     p.life = 0.5 + frand() * 0.6; }
        else             { p.kind = 2; p.c = '#5A5F68'; p.s = 8 + frand() * 12;    p.life = 0.7 + frand() * 0.6; }
      }
    }
    function sparkTrail(x, y, n) {
      for (let i = 0; i < n; i++) {
        const p = take(parts); if (!p) break;
        p.on = true; p.kind = 0; p.x = x + (frand() - 0.5) * 8; p.y = y;
        p.vx = (frand() - 0.5) * 90; p.vy = 120 + frand() * 120;
        p.c = frand() < 0.6 ? ICE : '#FFFFFF'; p.s = 1.6 + frand() * 1.4;
        p.age = 0; p.life = 0.25 + frand() * 0.2;
      }
    }

    // ── Simulation ──
    function update(dt) {
      S.simT += dt;
      const d = diff();
      S.speed = SPD_START + (SPD_MAX - SPD_START) * d + over() * OD_SPEED;
      S.dist += S.speed * dt;
      S.score += S.speed * dt * PTS_DIST + dt * PTS_TIME;
      S.goT += dt; S.hintT += dt;
      audio?.setSpeed(d);

      // player lane spring — snappy with a hint of overshoot
      const targetX = laneCenter(S.targetLane);
      // Snappy, near-critically-damped steering: ~133ms to cross a lane and
      // ~233ms fully settled, with almost no overshoot. Responsiveness is
      // deliberately favoured over a long, pretty animation.
      S.laneVel += (targetX - S.laneX) * 600 * dt;
      S.laneVel *= Math.exp(-34 * dt);
      S.laneX += S.laneVel * dt;
      // tyre smoke while sliding
      if (Math.abs(S.laneVel) > 240) {
        const px = roadX + S.laneX * u2p;
        puffAt(px - sprites.playerW * 0.34, playerY + sprites.playerL * 0.42, 0.8 + frand() * 0.4);
        puffAt(px + sprites.playerW * 0.34, playerY + sprites.playerL * 0.42, 0.8 + frand() * 0.4);
      }

      // roadside poles
      for (const p of S.poles) {
        p.y -= S.speed * dt;
        if (p.y < -160) { p.y += 300 * S.poles.length; p.side = -p.side; }
      }

      // living-road events
      if (!S.event && S.simT > S.nextEventAt) {
        const r = rand();
        if (r < 0.42) { S.event = 'gantry'; S.eventY = SPAWN_Y + 100; }
        else if (r < 0.72) { S.event = 'overpass'; S.eventY = SPAWN_Y + 160; }
        else { S.event = 'tunnel'; S.tunnelUntil = S.simT + 6 + rand() * 3; }
        S.nextEventAt = S.simT + 9 + rand() * 7;
      }
      if (S.event === 'gantry' || S.event === 'overpass') {
        S.eventY -= S.speed * dt;
        if (S.eventY < -400) S.event = null;
      } else if (S.event === 'tunnel') {
        S.tunnelA = clamp(S.tunnelA + dt * 2, 0, 1);
        if (S.simT > S.tunnelUntil) S.event = null;
      }
      if (S.event !== 'tunnel') S.tunnelA = clamp(S.tunnelA - dt * 2, 0, 1);

      // waves — and never a long empty road
      S.waveIn -= dt;
      if (S.waveIn <= 0) spawnWave();
      let ahead = 0;
      for (const c of cars) if (c.on && c.y > 0) ahead++;
      if (ahead < 2) S.waveIn = Math.min(S.waveIn, 0.15);

      // traffic
      S.changeCooldown -= dt;
      const pw = PLAYER_W_U * HIT_FORGIVE, pl = PLAYER_L_U * HIT_FORGIVE;
      for (const c of cars) {
        if (!c.on) continue;
        c.y -= (S.speed - c.spd) * dt;
        if (c.y < DESPAWN_Y) { c.on = false; continue; }

        // deterministic AI lane change (only far ahead of the player line)
        if (c.changeAt > 0 && S.simT >= c.changeAt && c.changing === 0 && c.y > 330 && S.changeCooldown <= 0) {
          const dir = c.lane === 0 ? 1 : c.lane === LANES - 1 ? -1 : (rand() < 0.5 ? -1 : 1);
          const target = c.lane + dir;
          let ok = true;
          for (const o of cars) {
            if (!o.on || o === c) continue;
            if (Math.round(o.laneF) === target && Math.abs(o.y - c.y) < 240) { ok = false; break; }
          }
          if (ok) { c.sig = 0.42; c.sigDir = dir; c.changing = -1; S.changeCooldown = Math.max(0.45, 1.1 - over() * 0.35); }
          c.changeAt = -1;
        }
        if (c.changing === -1) {
          c.sig -= dt;
          if (c.sig <= 0) { c.changing = 1; c.lane = clamp(c.lane + c.sigDir, 0, LANES - 1); }
        } else if (c.changing === 1) {
          c.laneF += (c.lane - c.laneF) * Math.min(1, dt * 5);
          if (Math.abs(c.laneF - c.lane) < 0.02) { c.laneF = c.lane; c.changing = 0; }
        }

        const cx = laneCenter(c.laneF), px = S.laneX;
        const v = VEHICLES[c.kind];
        const dx = Math.abs(cx - px);
        const sumW = (v.wid * HIT_FORGIVE + pw) / 2;
        const overlapY = Math.abs(c.y) < (v.len * HIT_FORGIVE + pl) / 2;

        if (!S.dead && overlapY && dx < sumW) {
          // ── CRASH ──
          S.dead = true; S.deadT = 0; S.shake = 1; S.flash = 1;
          crashBurst(roadX + px * u2p, playerY);
          audio?.crash();
          break;
        }
        // near miss — longitudinally overlapping, laterally just clear
        if (!c.near && !S.dead && overlapY && dx >= sumW && dx < sumW + 44) {
          c.near = true;
          S.combo = (S.simT - S.comboT < 1.5) ? Math.min(S.combo + 1, 4) : 1;
          S.comboT = S.simT;
          const pts = PTS_NEAR * S.combo;
          S.score += pts;
          S.flash = Math.max(S.flash, 0.34);
          S.scorePop = 1;
          addFloat(roadX + cx * u2p, playerY - c.y * u2p - 20, `+${pts}${S.combo > 1 ? ' ×' + S.combo : ''}`);
          sparkTrail(roadX + ((cx + px) / 2) * u2p, playerY - c.y * u2p, 5);
          audio?.whoosh();
        }
      }

      if (S.simT - S.lastPing > 0.35) {
        S.lastPing = S.simT;
        cbRef.current.onProgress?.(Math.floor(S.score), Math.floor(S.simT * 1000));
      }
    }

    function updateFX(dt) {
      S.flash = Math.max(0, S.flash - dt * 3);
      S.shake = Math.max(0, S.shake - dt * 2.2);
      S.scorePop = Math.max(0, S.scorePop - dt * 4);
      for (const p of parts) {
        if (!p.on) continue;
        p.age += dt;
        if (p.age >= p.life) { p.on = false; continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vy += (p.kind === 2 ? -50 : 900) * dt;
      }
      for (const f of floats) { if (f.on) { f.age += dt; f.y -= 44 * dt; if (f.age >= f.life) f.on = false; } }
      for (const p of puffs) { if (p.on) { p.age += dt; p.y += 60 * dt; if (p.age >= p.life) p.on = false; } }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  RENDER
    // ─────────────────────────────────────────────────────────────────────────
    const wy2sy = (wy) => playerY - wy * u2p;

    function render(nowMs) {
      const sp = sprites;
      // Off-road surround = the site background behind the canvas.
      const light = isLight();
      drawVoid(light);

      const shx = S.shake ? (frand() - 0.5) * 16 * S.shake : 0;
      const shy = S.shake ? (frand() - 0.5) * 12 * S.shake : 0;
      const tilt = clamp(S.laneVel * 0.0000075, -0.009, 0.009);
      const camX = -(S.laneX - LANE_U * LANES / 2) * u2p * 0.022;

      ctx.save();
      ctx.translate(W / 2 + shx + camX, H + shy);
      ctx.rotate(tilt);
      ctx.translate(-W / 2, -H);

      drawRoad(light);
      drawTraffic(nowMs);
      if (!S.dead) drawPlayer(nowMs);
      drawPuffs();
      drawParticles();
      drawFloats();
      ctx.restore();

      if (S.flash > 0.01) {
        ctx.globalAlpha = S.flash;
        ctx.drawImage(sp.edgeFlash, 0, 0);
        ctx.globalAlpha = 1;
      }
      const d = diff();
      if (d > 0.35 && !S.dead) {
        ctx.strokeStyle = `rgba(159,220,255,${(d - 0.35) * 0.3})`;
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 8; i++) {
          const t = ((nowMs * (0.9 + d) * 0.001) + i * 0.37) % 1;
          const y = t * t * H;
          const side = i % 2 ? 1 : -1;
          const x = W / 2 + side * (roadW / 2 + 14 + t * 30);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 30 + t * 90); ctx.stroke();
        }
      }
      if (!light) ctx.drawImage(sp.vignette, 0, 0); // a dark vignette would muddy light mode
      drawHUD(nowMs);
    }

    // ── The void either side of the road ────────────────────────────────────
    // Not decoration. The road is the only lit thing in frame, so everything
    // around it has to fall away rather than compete.
    function drawVoid(light) {
      if (light) { ctx.fillStyle = '#f0f4f8'; ctx.fillRect(0, 0, W, H); return; }
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#04060B');
      g.addColorStop(0.6, '#06090F');
      g.addColorStop(1, '#03050A');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // ── Road ────────────────────────────────────────────────────────────────
    // One light model: a cool key from above and slightly left. The asphalt is
    // near-black and is only visible where something lights it — the sheen down
    // the crown, the markings, the kerb rails. Painted every frame from plain
    // rects; there is no tile, no texture and no noise, so there is nothing that
    // can seam, shimmer or repeat.
    function drawRoad(light) {
      const x0 = roadX, x1 = roadX + roadW;

      // asphalt
      const ag = ctx.createLinearGradient(0, 0, 0, H);
      if (light) {
        ag.addColorStop(0, '#c4ccd8'); ag.addColorStop(0.72, '#d6dde7'); ag.addColorStop(1, '#cbd3de');
      } else {
        ag.addColorStop(0, '#0B111B');
        ag.addColorStop(0.55, '#151F2E');
        ag.addColorStop(1, '#0D1520');
      }
      ctx.fillStyle = ag;
      ctx.fillRect(x0, 0, roadW, H);

      if (!light) {
        // crown sheen — the key light catching the camber of the road
        const xg = ctx.createLinearGradient(x0, 0, x1, 0);
        xg.addColorStop(0.00, 'rgba(0,0,0,0.55)');
        xg.addColorStop(0.30, 'rgba(70,150,220,0.055)');
        xg.addColorStop(0.46, 'rgba(120,200,255,0.085)');
        xg.addColorStop(0.72, 'rgba(70,150,220,0.045)');
        xg.addColorStop(1.00, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = xg;
        ctx.fillRect(x0, 0, roadW, H);
      }

      // ── lane markings ─────────────────────────────────────────────────────
      // Two layers, and the pairing is deliberate:
      //   1. a continuous rail, so a lane line is present in every single frame
      //      no matter where the dash phase happens to land;
      //   2. dashes stretched by one frame of travel, the way a camera shutter
      //      would smear them — crisp when slow, near-solid when fast.
      // Either alone can strobe at top speed. Together they cannot.
      const stepPx = MARK_CYCLE * u2p;
      const off = (S.dist * VISUAL_SCROLL * u2p) % stepPx;
      const dashPx = MARK_LEN * u2p;
      const smear = Math.min(MARK_GAP * u2p * 0.9, S.speed * VISUAL_SCROLL * u2p / 60);
      const lw = Math.max(2, roadW * 0.006);

      for (let i = 1; i < LANES; i++) {
        const x = x0 + laneW * i;
        ctx.fillStyle = light ? 'rgba(255,255,255,0.34)' : 'rgba(120,175,225,0.16)';
        ctx.fillRect(x - lw * 0.32, 0, lw * 0.64, H);
        ctx.fillStyle = light ? '#FFFFFF' : '#DCEEFF';
        for (let y = off - stepPx; y < H + stepPx; y += stepPx) {
          const top = y - smear;
          const hgt = dashPx + smear;
          if (top > H || top + hgt < 0) continue;
          ctx.fillRect(x - lw / 2, top, lw, hgt);
        }
      }

      // ── kerbs ─────────────────────────────────────────────────────────────
      // The two anchor points of saturated colour in the frame, and the only
      // light source that runs the full height of the screen.
      if (!light) {
        for (const [ex, dir] of [[x0, -1], [x1, 1]]) {
          const sp2 = ctx.createLinearGradient(ex, 0, ex + dir * roadW * 0.10, 0);
          sp2.addColorStop(0, 'rgba(0,150,235,0.30)');
          sp2.addColorStop(1, 'rgba(0,150,235,0)');
          ctx.fillStyle = sp2;
          ctx.fillRect(Math.min(ex, ex + dir * roadW * 0.10), 0, roadW * 0.10, H);
          // inward spill onto the asphalt
          const inw = ctx.createLinearGradient(ex, 0, ex - dir * roadW * 0.13, 0);
          inw.addColorStop(0, 'rgba(0,170,255,0.20)');
          inw.addColorStop(1, 'rgba(0,170,255,0)');
          ctx.fillStyle = inw;
          ctx.fillRect(Math.min(ex, ex - dir * roadW * 0.13), 0, roadW * 0.13, H);
        }
      }
      for (const ex of [x0, x1]) {
        ctx.fillStyle = light ? '#8894a6' : CYAN;
        ctx.fillRect(ex - lw * 0.55, 0, lw * 1.1, H);
        ctx.fillStyle = light ? '#ffffff' : 'rgba(226,244,255,0.95)';
        ctx.fillRect(ex + (ex === x0 ? roadW * 0.016 : -roadW * 0.016) - lw * 0.28, 0, lw * 0.56, H);
      }

      // ── distance falloff ──────────────────────────────────────────────────
      // The road runs off the top of the screen rather than meeting a horizon,
      // so the top of the frame dissolves into the void. This is the only depth
      // cue, and it costs one rect.
      if (!light) {
        const fade = ctx.createLinearGradient(0, 0, 0, H * 0.34);
        fade.addColorStop(0, 'rgba(3,5,10,0.96)');
        fade.addColorStop(1, 'rgba(3,5,10,0)');
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, W, H * 0.34);
      }
    }

    function drawTraffic(nowMs) {
      const sp = sprites;
      const list = [];
      for (const c of cars) if (c.on && c.y < SPAWN_Y + 80 && c.y > DESPAWN_Y) list.push(c);
      list.sort((a, b) => b.y - a.y); // far → near
      for (const c of list) {
        const v = VEHICLES[c.kind];
        const img = sp.vkey(c.kind, c.paint);
        const cx = roadX + laneCenter(c.laneF) * u2p;
        const cy = wy2sy(c.y);
        const wpx = v.wid * u2p, lpx = v.len * u2p;
        if (cy < -lpx || cy > H + lpx) continue;
        ctx.globalAlpha = 0.5;
        ctx.drawImage(sp.shadow, cx - wpx * 0.62, cy - lpx * 0.5, wpx * 1.24, lpx * 1.06);
        ctx.globalAlpha = 1;
        ctx.drawImage(img, cx - wpx / 2, cy - lpx / 2, wpx, lpx);
        if (c.brake || c.spd < S.speed * 0.42) {
          ctx.globalAlpha = 0.5;
          ctx.drawImage(sp.glowRed, cx - wpx * 0.36 - 17, cy + lpx / 2 - 14, 34, 34);
          ctx.drawImage(sp.glowRed, cx + wpx * 0.36 - 17, cy + lpx / 2 - 14, 34, 34);
          ctx.globalAlpha = 1;
        }
        if (c.changing === -1 && Math.floor(nowMs / 130) % 2 === 0) {
          const sx = cx + c.sigDir * wpx * 0.42;
          ctx.globalAlpha = 0.9;
          ctx.drawImage(sp.glowAmber, sx - 13, cy - lpx / 2 - 6, 26, 26);
          ctx.drawImage(sp.glowAmber, sx - 13, cy + lpx / 2 - 18, 26, 26);
          ctx.globalAlpha = 1;
        }
      }
    }

    function drawPlayer(nowMs) {
      const sp = sprites;
      const px = roadX + S.laneX * u2p;
      const pw = sp.playerW, pl = sp.playerL;
      const roll = clamp(S.laneVel * 0.00023, -0.1, 0.1);
      const squash = 1 - Math.min(0.035, Math.abs(S.laneVel) * 0.00004);

      // The player is the brightest source on the road — the one thing the eye
      // should never have to search for.
      const pulse = 0.42 + Math.sin(nowMs * 0.006) * 0.08;
      ctx.globalAlpha = pulse;
      ctx.drawImage(sp.glowCyan, px - pw * 1.05, playerY - pl * 0.55, pw * 2.1, pl * 1.15);
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.6;
      ctx.drawImage(sp.shadow, px - pw * 0.66, playerY - pl * 0.5, pw * 1.32, pl * 1.04);
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(px, playerY);
      ctx.rotate(roll);
      ctx.scale(1, squash);
      ctx.drawImage(sp.player, -pw / 2, -pl / 2, pw, pl);
      ctx.restore();
    }

    function drawPuffs() {
      const sp = sprites;
      for (const p of puffs) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a * 0.5;
        const s = 20 * p.s * (1 + p.age * 2.4);
        ctx.drawImage(sp.smokePuff, p.x - s / 2, p.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
    }

    function drawParticles() {
      for (const p of parts) {
        if (!p.on) continue;
        const a = 1 - p.age / p.life;
        if (p.kind === 2) {
          ctx.globalAlpha = a * 0.4;
          const s = p.s * (1 + p.age * 2);
          ctx.drawImage(sprites.smokePuff, p.x - s, p.y - s, s * 2, s * 2);
        } else {
          ctx.globalAlpha = a;
          ctx.fillStyle = p.c;
          ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
      }
      ctx.globalAlpha = 1;
    }

    function drawFloats() {
      ctx.textAlign = 'center';
      for (const f of floats) {
        if (!f.on) continue;
        const a = 1 - f.age / f.life;
        ctx.globalAlpha = clamp(a * 1.4, 0, 1);
        ctx.font = `900 ${18 + (1 - a) * 3}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = '#04070D';
        ctx.fillText(f.txt, f.x + 1.5, f.y + 1.5);
        ctx.fillStyle = CYAN;
        ctx.fillText(f.txt, f.x, f.y);
      }
      ctx.globalAlpha = 1;
    }

    // ── HUD: score, time, pause, GO, hint, game-over ──
    function drawHUD(nowMs) {
      const score = Math.floor(S.score);
      const popS = 1 + S.scorePop * 0.12;

      // Anchor the readouts to the ROAD, not the canvas. On a wide desktop the
      // road is centred with black either side, so canvas-corner placement threw
      // score/time out to the far edges away from the action.
      const hudL = Math.max(16, roadX + 12);
      const hudR = Math.min(W - 16, roadX + roadW - 12);

      ctx.save();
      ctx.translate(hudL, 46);
      ctx.scale(popS, popS);
      ctx.textAlign = 'left';
      ctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(score.toLocaleString(), 2, 2);
      ctx.fillStyle = '#F2F8FF';
      ctx.fillText(score.toLocaleString(), 0, 0);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(159,220,255,0.75)';
      ctx.fillText('SCORE', hudL + 1, 61);

      ctx.textAlign = 'right';
      ctx.font = '900 22px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(S.simT.toFixed(1) + 's', hudR + 2, 44);
      ctx.fillStyle = '#F2F8FF';
      ctx.fillText(S.simT.toFixed(1) + 's', hudR, 42);
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(159,220,255,0.75)';
      ctx.fillText('TIME', hudR - 1, 58);

      // GO! flash
      if (S.goT < 0.75 && !S.dead) {
        const a = S.goT < 0.5 ? 1 : 1 - (S.goT - 0.5) / 0.25;
        const sc = 1 + S.goT * 0.7;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(W / 2, H * 0.38);
        ctx.scale(sc, sc);
        ctx.textAlign = 'center';
        ctx.font = '900 54px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillText('GO!', 3, 3);
        ctx.fillStyle = CYAN;
        ctx.fillText('GO!', 0, 0);
        ctx.restore();
      }
      // controls hint
      if (S.hintT < 3.6 && !S.dead) {
        const a = S.hintT < 2.8 ? 0.85 : 0.85 * (1 - (S.hintT - 2.8) / 0.8);
        ctx.globalAlpha = a;
        ctx.textAlign = 'center';
        ctx.font = '700 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(5,8,14,0.6)';
        rr(ctx, W / 2 - 108, H - 40, 216, 24, 12); ctx.fill();
        ctx.fillStyle = ICE;
        ctx.fillText('← → / A D  ·  swipe to change lanes', W / 2, H - 24);
        ctx.globalAlpha = 1;
      }

      // game-over overlay before values are returned
      if (S.dead && S.deadT > OVERLAY_S) {
        const a = clamp((S.deadT - OVERLAY_S) / 0.35, 0, 1);
        ctx.globalAlpha = a;
        const g = ctx.createLinearGradient(0, H * 0.28, 0, H * 0.74);
        g.addColorStop(0, 'rgba(2,3,8,0)');
        g.addColorStop(0.3, 'rgba(2,3,8,0.86)');
        g.addColorStop(0.7, 'rgba(2,3,8,0.86)');
        g.addColorStop(1, 'rgba(2,3,8,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, H * 0.28, W, H * 0.46);
        ctx.textAlign = 'center';
        ctx.font = '900 38px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#FF4D42';
        ctx.fillText('GAME OVER', W / 2, H * 0.42);
        ctx.font = '900 30px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillStyle = '#F2F8FF';
        ctx.fillText(Math.floor(S.score).toLocaleString(), W / 2, H * 0.5);
        ctx.font = '700 13px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(159,220,255,0.85)';
        ctx.fillText(`survived ${S.simT.toFixed(1)}s`, W / 2, H * 0.55);
        ctx.strokeStyle = 'rgba(0,191,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(W / 2 - 60, H * 0.585); ctx.lineTo(W / 2 + 60, H * 0.585); ctx.stroke();
        ctx.font = '700 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(180,195,215,0.6)';
        ctx.fillText('waiting for opponent…', W / 2, H * 0.625);
        ctx.globalAlpha = 1;
      }
    }

    // ── Main loop ──
    let raf = 0, last = performance.now();
    function loop(now) {
      raf = requestAnimationFrame(loop);
      let dt = (now - last) / 1000;
      last = now;
      dt = Math.min(dt, 1 / 30);

      if (!S.dead) {
        update(dt);
        updateFX(dt);
      } else {
        S.deadT += dt;
        if (S.deadT > FREEZE_S) updateFX(dt); // 0.15s freeze-frame
        if (!S.reported && S.deadT > REPORT_S) {
          S.reported = true;
          cbRef.current.onCrash?.(Math.floor(S.score), Math.floor(S.simT * 1000));
        }
      }
      render(now);
    }

    render(performance.now());
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeT);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      audio?.stop();
    };
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="relative w-full bg-bg flex justify-center overflow-hidden"
      style={{ height: 'calc(100dvh - 56px)' }}
    >
      {/* Night ambience behind the play area. On a wide screen the road cannot
          fill the width without either distorting the cars or cutting the fixed
          700-unit view distance that keeps the match fair, so the play area
          stays portrait and the surround is lit rather than left dead black. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 75% at 50% 62%, rgba(18,80,180,0.16) 0%, rgba(6,12,24,0.5) 45%, rgba(0,0,0,0.92) 100%)',
        }}
      />
      {/* Aspect cap: roadW works out at ~0.44x the canvas height, so a canvas
          about half as wide as it is tall puts the road at ~90% of the frame.
          Narrow screens are already taller than this and are unaffected. */}
      <canvas
        ref={canvasRef}
        className="relative h-full block touch-none select-none w-full"
        style={{ cursor: 'pointer', maxWidth: 'calc((100dvh - 56px) * 0.52)' }}
      />
    </div>
  );
}
