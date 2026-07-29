import { useEffect, useRef } from 'react';

/**
 * Pseudo-3D highway renderer (Canvas 2D, no WebGL / no extra deps).
 *
 * The road is drawn scanline-by-scanline from the horizon down: each screen row
 * maps back to a world distance, which gives real perspective, curves and hills
 * plus stripes/dashes for free. Traffic is projected with the same transform so
 * cars scale up smoothly as they approach.
 *
 * Traffic is generated from the shared server seed, so both players drive an
 * identical road — the match is pure skill.
 */

const LANES      = 4;
const CAM_DEPTH  = 220;   // perspective strength
const ROAD_HALF  = 0.46;  // road half-width as a fraction of canvas width
const PLAYER_Z   = 0;
const BASE_SPEED = 340;   // world units / sec
const MAX_SPEED  = 1150;
const RAMP_MS    = 55_000; // reach top speed in ~55s → short, intense runs

// Deterministic PRNG (mulberry32) so both players get identical traffic.
function makePRNG(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRAFFIC_COLORS = ['#e03131', '#f59f00', '#2f9e44', '#7048e8', '#e8590c', '#c2255c', '#1098ad'];

export default function HighwayCanvas({
  seed, myMs, oppMs, oppCrashed, crashed, opponentName, onProgress, onCrash,
}) {
  const canvasRef = useRef(null);
  const stateRef  = useRef(null);
  const cbRef     = useRef({ onProgress, onCrash });
  useEffect(() => { cbRef.current = { onProgress, onCrash }; }, [onProgress, onCrash]);

  // Live HUD values without re-rendering the canvas component
  const hudRef = useRef({ myMs: 0, oppMs: 0, oppCrashed: false });
  useEffect(() => { hudRef.current = { myMs, oppMs, oppCrashed }; }, [myMs, oppMs, oppCrashed]);
  const crashedRef = useRef(false);
  useEffect(() => { if (crashed) crashedRef.current = true; }, [crashed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || seed == null) return;
    const ctx = canvas.getContext('2d');

    let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const rand = makePRNG(seed);
    const S = {
      dist: 0,             // world distance travelled
      speed: BASE_SPEED,
      startAt: performance.now(),
      lane: 1.5,           // fractional lane (smoothly interpolated)
      targetLane: 1.5,
      cars: [],            // { z, lane, color }
      nextSpawn: 700,
      dead: false,
      deadAt: 0,
      shake: 0,
      clouds: Array.from({ length: 7 }, () => ({
        x: rand() * 1.2 - 0.1, y: 0.05 + rand() * 0.22, s: 0.5 + rand() * 0.9, sp: 0.002 + rand() * 0.004,
      })),
      particles: [],
      lastPing: 0,
    };
    stateRef.current = S;

    // Gentle winding road + rolling hills, derived from distance (deterministic).
    const curveAt = (z) => Math.sin(z * 0.0009) * 420 + Math.sin(z * 0.00031) * 300;
    const hillAt  = (z) => Math.sin(z * 0.0013) * 26 + Math.sin(z * 0.0005) * 40;

    // ── Controls ─────────────────────────────────────────────────────────────
    const move = (dir) => {
      if (S.dead) return;
      S.targetLane = Math.max(0, Math.min(LANES - 1, Math.round(S.targetLane) + dir));
    };
    const onKey = (e) => {
      if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') { move(-1); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { move(1);  e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);

    let touchX = null;
    const onTouchStart = (e) => { touchX = e.touches[0].clientX; };
    const onTouchEnd = (e) => {
      if (touchX == null) return;
      const endX = (e.changedTouches?.[0]?.clientX) ?? touchX;
      const dx = endX - touchX;
      if (Math.abs(dx) > 24) move(dx > 0 ? 1 : -1);
      else move(touchX < canvas.getBoundingClientRect().width / 2 ? -1 : 1); // tap side
      touchX = null;
    };
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    const onMouseDown = (e) => {
      const r = canvas.getBoundingClientRect();
      move(e.clientX - r.left < r.width / 2 ? -1 : 1);
    };
    canvas.addEventListener('mousedown', onMouseDown);

    // ── Projection ───────────────────────────────────────────────────────────
    // scale = CAM_DEPTH / (CAM_DEPTH + z): 1 at the player, → 0 at the horizon.
    const horizonY = () => H * 0.40;
    const baseY    = () => H * 0.90;
    const project = (z) => {
      const scale = CAM_DEPTH / (CAM_DEPTH + Math.max(z, -CAM_DEPTH * 0.9));
      const hy = horizonY(), by = baseY();
      return { scale, y: hy + (by - hy) * scale };
    };
    const laneOffset = (lane) => (lane - (LANES - 1) / 2) / (LANES / 2);

    // ── Frame ────────────────────────────────────────────────────────────────
    let raf = 0, last = performance.now();
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const elapsed = now - S.startAt;
      if (!S.dead) {
        // Speed ramps toward MAX — this is what makes runs short and tense.
        const t = Math.min(elapsed / RAMP_MS, 1);
        S.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (t * t * (3 - 2 * t)); // smoothstep
        S.dist += S.speed * dt;

        // Smooth lane change
        S.lane += (S.targetLane - S.lane) * Math.min(1, dt * 12);

        // Spawn traffic rows from the seeded PRNG
        while (S.dist + 2600 > S.nextSpawn) {
          const difficulty = Math.min(elapsed / RAMP_MS, 1);
          const blocked = 1 + Math.floor(rand() * (difficulty > 0.55 ? 2.99 : 1.99)); // 1–2, later 1–3
          const lanes = [0, 1, 2, 3].sort(() => rand() - 0.5).slice(0, Math.min(blocked, LANES - 1));
          for (const ln of lanes) {
            S.cars.push({ z: S.nextSpawn - S.dist, lane: ln, color: TRAFFIC_COLORS[Math.floor(rand() * TRAFFIC_COLORS.length)] });
          }
          S.nextSpawn += 420 + rand() * 520 - difficulty * 130;
        }

        // Advance traffic toward the player, cull passed cars
        for (const c of S.cars) c.z -= S.speed * dt;
        S.cars = S.cars.filter(c => c.z > -260);

        // Collision — overlapping lane while the car is at the player's depth
        for (const c of S.cars) {
          if (c.z < 70 && c.z > -55 && Math.abs(c.lane - S.lane) < 0.72) {
            S.dead = true; S.deadAt = now; S.shake = 1;
            for (let i = 0; i < 26; i++) {
              S.particles.push({
                x: 0, y: 0, vx: (rand() - 0.5) * 460, vy: -rand() * 380 - 60,
                life: 0.7 + rand() * 0.6, age: 0, c: rand() < 0.5 ? '#ffd43b' : '#ff6b6b',
              });
            }
            cbRef.current.onCrash?.();
            break;
          }
        }

        // Report progress ~3x/sec (server clamps it anyway)
        if (elapsed - S.lastPing > 350) {
          S.lastPing = elapsed;
          cbRef.current.onProgress?.(Math.floor(elapsed));
        }
      } else {
        S.shake = Math.max(0, S.shake - dt * 2.2);
        for (const p of S.particles) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; }
        S.particles = S.particles.filter(p => p.age < p.life);
      }

      draw(now, elapsed);
    }

    function draw(now, elapsed) {
      const hy = horizonY(), by = baseY();
      const shakeX = S.shake ? (Math.random() - 0.5) * 16 * S.shake : 0;
      const shakeY = S.shake ? (Math.random() - 0.5) * 12 * S.shake : 0;

      ctx.save();
      ctx.translate(shakeX, shakeY);

      // ── Sky ──
      const sky = ctx.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, '#3b9dea');
      sky.addColorStop(0.55, '#7cc4f2');
      sky.addColorStop(1, '#cfe9fb');
      ctx.fillStyle = sky;
      ctx.fillRect(-20, -20, W + 40, hy + 20);

      // Sun + glow
      const sx = W * 0.78, sy = hy * 0.30;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, W * 0.28);
      glow.addColorStop(0, 'rgba(255,255,235,0.95)');
      glow.addColorStop(0.25, 'rgba(255,240,180,0.35)');
      glow.addColorStop(1, 'rgba(255,240,180,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-20, -20, W + 40, hy + 20);

      // Clouds
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      for (const c of S.clouds) {
        if (!S.dead) c.x += c.sp * 0.02;
        if (c.x > 1.25) c.x = -0.25;
        const cx = c.x * W, cy = c.y * hy, r = 26 * c.s;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 1.9, r * 0.7, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - r * 0.9, cy + r * 0.16, r * 1.1, r * 0.55, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + r * 1.0, cy + r * 0.2, r * 1.0, r * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Distant hills (parallax) ──
      const hillShift = (S.dist * 0.012) % (W + 400);
      for (let layer = 0; layer < 2; layer++) {
        ctx.fillStyle = layer === 0 ? 'rgba(120,170,140,0.55)' : 'rgba(92,146,116,0.85)';
        ctx.beginPath();
        ctx.moveTo(-100, hy + 2);
        const amp = layer === 0 ? 54 : 34, step = 90 + layer * 40;
        for (let x = -100; x <= W + 100; x += step) {
          const k = (x + hillShift * (layer ? 1.6 : 1)) * 0.006 + layer * 3.1;
          ctx.lineTo(x, hy - (Math.sin(k) * 0.5 + 0.5) * amp - 6);
        }
        ctx.lineTo(W + 100, hy + 2);
        ctx.closePath();
        ctx.fill();
      }

      // ── Ground / road, drawn per scanline for true perspective ──
      for (let y = Math.floor(hy); y < H; y++) {
        const scale = (y - hy) / (by - hy);
        if (scale <= 0.0001) continue;
        const z = CAM_DEPTH * (1 / scale - 1);
        const wz = S.dist + z;
        const cx = W / 2 + (curveAt(wz) - curveAt(S.dist)) * scale * 0.5;
        const half = ROAD_HALF * W * scale;

        // Grass — alternating bands rushing past
        const band = Math.floor(wz / 130) % 2 === 0;
        ctx.fillStyle = band ? '#5fae4e' : '#57a447';
        ctx.fillRect(0, y, W, 1);

        // Road
        ctx.fillStyle = '#4a4e57';
        ctx.fillRect(cx - half, y, half * 2, 1);

        // Rumble strips
        const rum = Math.floor(wz / 60) % 2 === 0;
        ctx.fillStyle = rum ? '#e9ecef' : '#d94a3d';
        const rw = Math.max(1.5, half * 0.09);
        ctx.fillRect(cx - half, y, rw, 1);
        ctx.fillRect(cx + half - rw, y, rw, 1);

        // Lane dashes
        if (Math.floor(wz / 46) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          const dw = Math.max(1, half * 0.022);
          for (let l = 1; l < LANES; l++) {
            const lx = cx + (l - LANES / 2) * (half * 2 / LANES);
            ctx.fillRect(lx - dw / 2, y, dw, 1);
          }
        }
      }

      // ── Traffic (far → near so nearer cars overlap correctly) ──
      const sorted = [...S.cars].sort((a, b) => b.z - a.z);
      for (const c of sorted) {
        if (c.z > 2600) continue;
        drawCar(c.z, c.lane, c.color, false);
      }

      // ── Player ──
      if (!S.dead) drawCar(PLAYER_Z, S.lane, '#1250B4', true);

      // ── Speed streaks ──
      const spd = (S.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
      if (spd > 0.05 && !S.dead) {
        ctx.strokeStyle = `rgba(255,255,255,${0.10 + spd * 0.18})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 9; i++) {
          const t = ((now * (0.5 + spd) * 0.0012) + i * 0.31) % 1;
          const yy = hy + (H - hy) * (t * t);
          const side = i % 2 === 0 ? -1 : 1;
          const xx = W / 2 + side * (W * 0.30 + t * W * 0.34);
          ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 26 + t * 70); ctx.stroke();
        }
      }

      // ── Crash particles + overlay ──
      if (S.dead) {
        const p0 = project(PLAYER_Z);
        const px = W / 2 + laneOffset(S.lane) * ROAD_HALF * W * p0.scale;
        for (const p of S.particles) {
          ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
          ctx.fillStyle = p.c;
          ctx.fillRect(px + p.x - 3, p0.y + p.y - 3, 6, 6);
        }
        ctx.globalAlpha = 1;
        const since = now - S.deadAt;
        if (since < 240) {
          ctx.fillStyle = `rgba(255,255,255,${0.75 * (1 - since / 240)})`;
          ctx.fillRect(0, 0, W, H);
        }
      }

      ctx.restore();
      drawHUD(elapsed);
    }

    function drawCar(z, lane, color, isPlayer) {
      const { scale, y } = project(z);
      if (scale <= 0.02) return;
      const wz = S.dist + z;
      const cx = W / 2 + (curveAt(wz) - curveAt(S.dist)) * scale * 0.5;
      const half = ROAD_HALF * W * scale;
      const x = cx + laneOffset(lane) * half;

      const cw = half * 0.42;          // car width
      const ch = cw * 1.5;             // car length on screen
      const hillY = hillAt(wz) * scale * 0.4;
      const yy = y - hillY;

      // Contact shadow — the key depth cue in daylight
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(x, yy + ch * 0.08, cw * 0.62, cw * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();

      // Body
      const bodyTop = yy - ch;
      const grad = ctx.createLinearGradient(x - cw / 2, 0, x + cw / 2, 0);
      grad.addColorStop(0, shade(color, -18));
      grad.addColorStop(0.4, color);
      grad.addColorStop(1, shade(color, -32));
      ctx.fillStyle = grad;
      roundRect(ctx, x - cw / 2, bodyTop, cw, ch, Math.max(2, cw * 0.16));
      ctx.fill();

      // Roof / cabin
      ctx.fillStyle = shade(color, -42);
      roundRect(ctx, x - cw * 0.36, bodyTop + ch * 0.22, cw * 0.72, ch * 0.42, Math.max(1.5, cw * 0.1));
      ctx.fill();

      // Rear window glint
      ctx.fillStyle = 'rgba(210,235,255,0.75)';
      roundRect(ctx, x - cw * 0.29, bodyTop + ch * 0.27, cw * 0.58, ch * 0.18, Math.max(1, cw * 0.07));
      ctx.fill();

      // Lights: player shows headlights ahead, traffic shows tail lights
      ctx.fillStyle = isPlayer ? '#fff6cc' : '#ff5b4a';
      const lw = cw * 0.17, lh = Math.max(1.5, ch * 0.07);
      ctx.fillRect(x - cw * 0.42, bodyTop + ch * 0.86, lw, lh);
      ctx.fillRect(x + cw * 0.42 - lw, bodyTop + ch * 0.86, lw, lh);

      // Subtle outline keeps shapes readable in bright light
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = Math.max(0.6, cw * 0.03);
      roundRect(ctx, x - cw / 2, bodyTop, cw, ch, Math.max(2, cw * 0.16));
      ctx.stroke();
    }

    function drawHUD(elapsed) {
      const { oppMs: om, oppCrashed: oc } = hudRef.current;
      const mine = S.dead ? (hudRef.current.myMs || elapsed) : elapsed;

      // Your time
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      roundRect(ctx, 12, 12, 132, 52, 12); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('YOUR TIME', 24, 32);
      ctx.font = '900 22px JetBrains Mono, monospace';
      ctx.fillText((mine / 1000).toFixed(1) + 's', 24, 55);

      // Opponent time
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      roundRect(ctx, W - 144, 12, 132, 52, 12); ctx.fill();
      ctx.fillStyle = oc ? '#ff8787' : '#fff';
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(oc ? 'OPPONENT — OUT' : 'OPPONENT', W - 24, 32);
      ctx.font = '900 22px JetBrains Mono, monospace';
      ctx.fillText((om / 1000).toFixed(1) + 's', W - 24, 55);

      // Who's ahead
      const lead = mine - om;
      ctx.textAlign = 'center';
      ctx.font = '800 13px Inter, system-ui, sans-serif';
      ctx.fillStyle = lead >= 0 ? '#8ce99a' : '#ffc9c9';
      if (!S.dead) ctx.fillText(lead >= 0 ? `LEADING +${(lead / 1000).toFixed(1)}s` : `BEHIND ${(lead / 1000).toFixed(1)}s`, W / 2, 34);

      if (S.dead) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, H * 0.36, W, 116);
        ctx.fillStyle = '#fff';
        ctx.font = '900 34px Inter, system-ui, sans-serif';
        ctx.fillText('CRASHED', W / 2, H * 0.36 + 48);
        ctx.font = '700 15px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#cfd4dc';
        ctx.fillText(oc ? 'Waiting for result…' : `${opponentName} is still driving…`, W / 2, H * 0.36 + 82);
      }
    }

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('mousedown', onMouseDown);
    };
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative w-full" style={{ height: 'calc(100dvh - 56px)', background: '#7cc4f2' }}>
      <canvas ref={canvasRef} className="w-full h-full block touch-none select-none" />
      <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none">
        <span className="text-[11px] text-white/80 font-semibold bg-black/35 px-3 py-1.5 rounded-full">
          ← → / A D · swipe or tap a side
        </span>
      </div>
    </div>
  );
}

// ── helpers ──
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v) => Math.max(0, Math.min(255, v));
  const r = cl(((n >> 16) & 255) + amt), g = cl(((n >> 8) & 255) + amt), b = cl((n & 255) + amt);
  return `rgb(${r},${g},${b})`;
}
