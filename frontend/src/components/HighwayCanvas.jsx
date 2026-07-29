import { useEffect, useRef } from 'react';

/**
 * Pseudo-3D highway renderer (Canvas 2D, no WebGL / no extra deps).
 *
 * The road is drawn scanline-by-scanline from the horizon down: each screen row
 * maps back to a world distance, which gives real perspective, curves and hills
 * plus stripes/dashes for free. Traffic and scenery are projected with the same
 * transform so everything scales consistently as it approaches.
 *
 * Traffic is generated from the shared server seed, so both players drive an
 * identical road — the match is pure skill.
 */

const LANES      = 4;
const CAM_DEPTH  = 260;   // perspective strength
const ROAD_HALF  = 0.40;  // road half-width as a fraction of canvas width
const PLAYER_Z   = 34;    // draw the player slightly ahead so it isn't oversized
const BASE_SPEED = 340;
const MAX_SPEED  = 1150;
const RAMP_MS    = 55_000;

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

const TRAFFIC_COLORS = ['#d94b3f', '#e8a33d', '#3d9e5f', '#6f5ad4', '#e0672f', '#c94a7c', '#2f93b8', '#d8d8dc'];

export default function HighwayCanvas({
  seed, myMs, oppMs, oppCrashed, crashed, opponentName, onProgress, onCrash,
}) {
  const canvasRef = useRef(null);
  const cbRef     = useRef({ onProgress, onCrash });
  useEffect(() => { cbRef.current = { onProgress, onCrash }; }, [onProgress, onCrash]);

  const hudRef = useRef({ myMs: 0, oppMs: 0, oppCrashed: false });
  useEffect(() => { hudRef.current = { myMs, oppMs, oppCrashed }; }, [myMs, oppMs, oppCrashed]);
  useEffect(() => { /* crash flag handled internally */ }, [crashed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || seed == null) return;
    const ctx = canvas.getContext('2d');

    let W = 0, H = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const rand = makePRNG(seed);
    const S = {
      dist: 0, speed: BASE_SPEED, startAt: performance.now(),
      lane: 1.5, targetLane: 1.5,
      cars: [], props: [],
      nextSpawn: 800, nextProp: 200,
      dead: false, deadAt: 0, shake: 0,
      clouds: Array.from({ length: 8 }, () => ({
        x: rand() * 1.2 - 0.1, y: 0.04 + rand() * 0.2, s: 0.45 + rand() * 0.9, sp: 0.0015 + rand() * 0.003,
      })),
      particles: [], lastPing: 0, wobble: 0,
    };

    const curveAt = (z) => Math.sin(z * 0.0008) * 460 + Math.sin(z * 0.00029) * 320;
    const hillAt  = (z) => Math.sin(z * 0.0012) * 30 + Math.sin(z * 0.00047) * 46;

    // ── Controls ──
    const move = (dir) => {
      if (S.dead) return;
      const next = Math.max(0, Math.min(LANES - 1, Math.round(S.targetLane) + dir));
      if (next !== S.targetLane) S.wobble = dir * 1;
      S.targetLane = next;
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
      const endX = e.changedTouches?.[0]?.clientX ?? touchX;
      const dx = endX - touchX;
      if (Math.abs(dx) > 24) move(dx > 0 ? 1 : -1);
      else move(touchX < canvas.getBoundingClientRect().width / 2 ? -1 : 1);
      touchX = null;
    };
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    const onMouseDown = (e) => {
      const r = canvas.getBoundingClientRect();
      move(e.clientX - r.left < r.width / 2 ? -1 : 1);
    };
    canvas.addEventListener('mousedown', onMouseDown);

    // ── Projection ──
    const horizonY = () => H * 0.42;
    const baseY    = () => H * 0.94;
    const project = (z) => {
      const scale = CAM_DEPTH / (CAM_DEPTH + Math.max(z, -CAM_DEPTH * 0.85));
      const hy = horizonY(), by = baseY();
      return { scale, y: hy + (by - hy) * scale };
    };
    const laneOffset = (lane) => (lane - (LANES - 1) / 2) / (LANES / 2);
    const roadCenter = (wz, scale) => W / 2 + (curveAt(wz) - curveAt(S.dist)) * scale * 0.55;

    // ── Frame ──
    let raf = 0, last = performance.now();
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const elapsed = now - S.startAt;

      if (!S.dead) {
        const t = Math.min(elapsed / RAMP_MS, 1);
        S.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (t * t * (3 - 2 * t));
        S.dist += S.speed * dt;
        S.lane += (S.targetLane - S.lane) * Math.min(1, dt * 11);
        S.wobble *= Math.max(0, 1 - dt * 5);

        // Traffic
        while (S.dist + 3000 > S.nextSpawn) {
          const diff = Math.min(elapsed / RAMP_MS, 1);
          const blocked = 1 + Math.floor(rand() * (diff > 0.55 ? 2.99 : 1.99));
          const lanes = [0, 1, 2, 3].sort(() => rand() - 0.5).slice(0, Math.min(blocked, LANES - 1));
          for (const ln of lanes) {
            S.cars.push({ z: S.nextSpawn - S.dist, lane: ln, color: TRAFFIC_COLORS[Math.floor(rand() * TRAFFIC_COLORS.length)] });
          }
          S.nextSpawn += 430 + rand() * 520 - diff * 130;
        }
        // Roadside scenery
        while (S.dist + 3000 > S.nextProp) {
          const side = rand() < 0.5 ? -1 : 1;
          const kind = rand();
          S.props.push({
            z: S.nextProp - S.dist, side,
            type: kind < 0.5 ? 'tree' : kind < 0.8 ? 'pole' : 'sign',
            off: 1.25 + rand() * 0.55,
            h: 0.8 + rand() * 0.5,
          });
          S.nextProp += 90 + rand() * 150;
        }

        for (const c of S.cars)  c.z -= S.speed * dt;
        for (const p of S.props) p.z -= S.speed * dt;
        S.cars  = S.cars.filter(c => c.z > -300);
        S.props = S.props.filter(p => p.z > -300);

        for (const c of S.cars) {
          if (c.z < 78 && c.z > -50 && Math.abs(c.lane - S.lane) < 0.7) {
            S.dead = true; S.deadAt = now; S.shake = 1;
            for (let i = 0; i < 30; i++) {
              S.particles.push({
                x: 0, y: 0, vx: (rand() - 0.5) * 480, vy: -rand() * 400 - 70,
                life: 0.7 + rand() * 0.6, age: 0, c: rand() < 0.5 ? '#ffd43b' : '#ff6b6b',
              });
            }
            cbRef.current.onCrash?.();
            break;
          }
        }

        if (elapsed - S.lastPing > 350) {
          S.lastPing = elapsed;
          cbRef.current.onProgress?.(Math.floor(elapsed));
        }
      } else {
        S.shake = Math.max(0, S.shake - dt * 2.2);
        for (const p of S.particles) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 950 * dt; }
        S.particles = S.particles.filter(p => p.age < p.life);
      }

      draw(now, elapsed);
    }

    function draw(now, elapsed) {
      const hy = horizonY(), by = baseY();
      const sx = S.shake ? (Math.random() - 0.5) * 15 * S.shake : 0;
      const sy = S.shake ? (Math.random() - 0.5) * 11 * S.shake : 0;
      ctx.save();
      ctx.translate(sx, sy);

      // ── Sky ──
      const sky = ctx.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, '#2f8fd8');
      sky.addColorStop(0.5, '#74bdec');
      sky.addColorStop(1, '#d8ecfa');
      ctx.fillStyle = sky; ctx.fillRect(-20, -20, W + 40, hy + 22);

      // Sun
      const sunX = W * 0.74, sunY = hy * 0.26;
      const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, W * 0.3);
      glow.addColorStop(0, 'rgba(255,253,235,0.95)');
      glow.addColorStop(0.22, 'rgba(255,244,190,0.3)');
      glow.addColorStop(1, 'rgba(255,244,190,0)');
      ctx.fillStyle = glow; ctx.fillRect(-20, -20, W + 40, hy + 22);

      // Clouds
      for (const c of S.clouds) {
        if (!S.dead) { c.x += c.sp * 0.02; if (c.x > 1.25) c.x = -0.25; }
        const cx = c.x * W, cy = c.y * hy, r = 24 * c.s;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.28, r * 2.1, r * 0.62, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 1.7, r * 0.68, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - r * 0.95, cy + r * 0.14, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + r * 1.0, cy + r * 0.18, r * 0.95, r * 0.46, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Hills ──
      const shift = (S.dist * 0.01) % 4000;
      for (let layer = 0; layer < 3; layer++) {
        ctx.fillStyle = ['rgba(150,190,205,0.5)', 'rgba(116,168,150,0.7)', 'rgba(86,140,110,0.9)'][layer];
        ctx.beginPath(); ctx.moveTo(-60, hy + 2);
        const amp = [64, 44, 28][layer], step = [130, 95, 70][layer];
        for (let x = -60; x <= W + 60; x += step) {
          const k = (x + shift * (0.6 + layer * 0.7)) * 0.0055 + layer * 2.7;
          ctx.lineTo(x, hy - (Math.sin(k) * 0.5 + 0.5) * amp - 4);
        }
        ctx.lineTo(W + 60, hy + 2); ctx.closePath(); ctx.fill();
      }

      // ── Ground + road (per scanline) ──
      for (let y = Math.floor(hy); y < H; y++) {
        const scale = (y - hy) / (by - hy);
        if (scale <= 0.0001) continue;
        const z = CAM_DEPTH * (1 / scale - 1);
        const wz = S.dist + z;
        const cx = roadCenter(wz, scale);
        const half = ROAD_HALF * W * scale;

        const band = Math.floor(wz / 140) % 2 === 0;
        ctx.fillStyle = band ? '#63b054' : '#59a54a';
        ctx.fillRect(0, y, W, 1);

        // Shoulder / dirt edge
        ctx.fillStyle = '#a89272';
        const sh = half * 0.1 + 1;
        ctx.fillRect(cx - half - sh, y, sh, 1);
        ctx.fillRect(cx + half, y, sh, 1);

        // Asphalt
        ctx.fillStyle = Math.floor(wz / 140) % 2 === 0 ? '#50545d' : '#4c505a';
        ctx.fillRect(cx - half, y, half * 2, 1);

        // Rumble strips
        const rum = Math.floor(wz / 55) % 2 === 0;
        ctx.fillStyle = rum ? '#eef1f4' : '#cf4638';
        const rw = Math.max(1.5, half * 0.075);
        ctx.fillRect(cx - half, y, rw, 1);
        ctx.fillRect(cx + half - rw, y, rw, 1);

        // Lane dashes
        if (Math.floor(wz / 44) % 2 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          const dw = Math.max(1, half * 0.018);
          for (let l = 1; l < LANES; l++) {
            const lx = cx + (l - LANES / 2) * (half * 2 / LANES);
            ctx.fillRect(lx - dw / 2, y, dw, 1);
          }
        }
      }

      // Horizon haze softens the hard road edge in the distance
      const haze = ctx.createLinearGradient(0, hy, 0, hy + H * 0.1);
      haze.addColorStop(0, 'rgba(216,236,250,0.95)');
      haze.addColorStop(1, 'rgba(216,236,250,0)');
      ctx.fillStyle = haze; ctx.fillRect(0, hy, W, H * 0.1);

      // ── Scenery + traffic, far → near ──
      const scene = [
        ...S.props.map(p => ({ ...p, _k: 'p' })),
        ...S.cars.map(c => ({ ...c, _k: 'c' })),
      ].sort((a, b) => b.z - a.z);
      for (const o of scene) {
        if (o.z > 3000) continue;
        if (o._k === 'p') drawProp(o); else drawCar(o.z, o.lane, o.color, false);
      }

      if (!S.dead) drawCar(PLAYER_Z, S.lane, '#1250B4', true);

      // ── Speed streaks ──
      const spd = (S.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
      if (spd > 0.06 && !S.dead) {
        ctx.strokeStyle = `rgba(255,255,255,${0.08 + spd * 0.16})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 10; i++) {
          const t = ((now * (0.5 + spd) * 0.0011) + i * 0.29) % 1;
          const yy = hy + (H - hy) * (t * t);
          const side = i % 2 === 0 ? -1 : 1;
          const xx = W / 2 + side * (W * 0.32 + t * W * 0.32);
          ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 24 + t * 66); ctx.stroke();
        }
      }

      // ── Crash ──
      if (S.dead) {
        const p0 = project(PLAYER_Z);
        const px = roadCenter(S.dist + PLAYER_Z, p0.scale) + laneOffset(S.lane) * ROAD_HALF * W * p0.scale;
        for (const p of S.particles) {
          ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
          ctx.fillStyle = p.c;
          ctx.fillRect(px + p.x - 3, p0.y + p.y - 3, 6, 6);
        }
        ctx.globalAlpha = 1;
        const since = now - S.deadAt;
        if (since < 240) {
          ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - since / 240)})`;
          ctx.fillRect(0, 0, W, H);
        }
      }

      ctx.restore();
      drawHUD(elapsed);
    }

    // ── Roadside scenery ──
    function drawProp(p) {
      const { scale, y } = project(p.z);
      if (scale <= 0.015) return;
      const wz = S.dist + p.z;
      const cx = roadCenter(wz, scale);
      const half = ROAD_HALF * W * scale;
      const x = cx + p.side * half * p.off;
      const yy = y - hillAt(wz) * scale * 0.4;
      const u = half * 0.1; // unit size

      if (p.type === 'tree') {
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.beginPath(); ctx.ellipse(x, yy, u * 1.5, u * 0.4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#6b4b2f';
        ctx.fillRect(x - u * 0.22, yy - u * 3.2 * p.h, u * 0.44, u * 3.2 * p.h);
        const g = ctx.createRadialGradient(x - u, yy - u * 4.4 * p.h, u * 0.3, x, yy - u * 4 * p.h, u * 2.6);
        g.addColorStop(0, '#57a84a'); g.addColorStop(1, '#2f6b34');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, yy - u * 4.1 * p.h, u * 2.1, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x - u * 1.2, yy - u * 3.3 * p.h, u * 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x + u * 1.2, yy - u * 3.4 * p.h, u * 1.3, 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'pole') {
        ctx.fillStyle = '#b9bec6';
        ctx.fillRect(x - u * 0.14, yy - u * 6 * p.h, u * 0.28, u * 6 * p.h);
        ctx.fillRect(x - u * 0.14, yy - u * 6 * p.h, p.side * -u * 1.5, u * 0.26);
      } else {
        ctx.fillStyle = '#8d939c';
        ctx.fillRect(x - u * 0.12, yy - u * 3.4, u * 0.24, u * 3.4);
        ctx.fillStyle = '#2f7d4f';
        ctx.fillRect(x - u * 1.5, yy - u * 5.1, u * 3, u * 1.7);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x - u * 1.1, yy - u * 4.6, u * 2.2, u * 0.22);
        ctx.fillRect(x - u * 1.1, yy - u * 4.1, u * 1.5, u * 0.22);
      }
    }

    // ── Cars (rear view, correctly proportioned) ──
    function drawCar(z, lane, color, isPlayer) {
      const { scale, y } = project(z);
      if (scale <= 0.02) return;
      const wz = S.dist + z;
      const cx = roadCenter(wz, scale);
      const half = ROAD_HALF * W * scale;
      const laneW = (half * 2) / LANES;
      const x = cx + laneOffset(lane) * half;
      const yy = y - hillAt(wz) * scale * 0.4;

      // A car sits inside its lane and is WIDER than it is tall from behind.
      const cw = laneW * 0.62;
      const ch = cw * 0.78;
      const tilt = isPlayer ? S.wobble * cw * 0.08 : 0;

      // Contact shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(x, yy + ch * 0.06, cw * 0.56, ch * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      const top = yy - ch;
      const bodyW = cw, roofW = cw * 0.7;

      // Lower body — slight trapezoid (wider at the bumper, narrower toward roof)
      ctx.fillStyle = shade(color, -26);
      ctx.beginPath();
      ctx.moveTo(x - bodyW / 2 + tilt * 0.4, yy);
      ctx.lineTo(x + bodyW / 2 + tilt * 0.4, yy);
      ctx.lineTo(x + bodyW * 0.44 + tilt, top + ch * 0.42);
      ctx.lineTo(x - bodyW * 0.44 + tilt, top + ch * 0.42);
      ctx.closePath(); ctx.fill();

      // Upper body / cabin
      const gr = ctx.createLinearGradient(x - roofW, 0, x + roofW, 0);
      gr.addColorStop(0, shade(color, -14));
      gr.addColorStop(0.45, color);
      gr.addColorStop(1, shade(color, -34));
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(x - bodyW * 0.44 + tilt, top + ch * 0.44);
      ctx.lineTo(x + bodyW * 0.44 + tilt, top + ch * 0.44);
      ctx.lineTo(x + roofW / 2 + tilt * 1.2, top + ch * 0.06);
      ctx.lineTo(x - roofW / 2 + tilt * 1.2, top + ch * 0.06);
      ctx.closePath(); ctx.fill();

      // Rear window
      ctx.fillStyle = 'rgba(180,220,248,0.9)';
      ctx.beginPath();
      ctx.moveTo(x - roofW * 0.42 + tilt, top + ch * 0.40);
      ctx.lineTo(x + roofW * 0.42 + tilt, top + ch * 0.40);
      ctx.lineTo(x + roofW * 0.36 + tilt * 1.2, top + ch * 0.13);
      ctx.lineTo(x - roofW * 0.36 + tilt * 1.2, top + ch * 0.13);
      ctx.closePath(); ctx.fill();

      // Roof highlight
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(x - roofW / 2 + tilt * 1.2, top + ch * 0.05, roofW, Math.max(0.8, ch * 0.035));

      // Wheels peeking out at the bottom corners
      ctx.fillStyle = '#1b1d21';
      const ww = cw * 0.13, wh = ch * 0.2;
      ctx.fillRect(x - bodyW / 2 - ww * 0.35 + tilt * 0.4, yy - wh * 0.85, ww, wh);
      ctx.fillRect(x + bodyW / 2 - ww * 0.65 + tilt * 0.4, yy - wh * 0.85, ww, wh);

      // Bumper
      ctx.fillStyle = shade(color, -48);
      ctx.fillRect(x - bodyW * 0.48 + tilt * 0.4, yy - ch * 0.1, bodyW * 0.96, Math.max(1, ch * 0.09));

      // Lights
      const lw = cw * 0.19, lh = Math.max(1.2, ch * 0.11);
      if (isPlayer) {
        ctx.fillStyle = '#fff3c4';
        ctx.fillRect(x - bodyW * 0.42 + tilt * 0.4, yy - ch * 0.30, lw, lh);
        ctx.fillRect(x + bodyW * 0.42 - lw + tilt * 0.4, yy - ch * 0.30, lw, lh);
      } else {
        ctx.fillStyle = '#ff4d3d';
        ctx.fillRect(x - bodyW * 0.42, yy - ch * 0.30, lw, lh);
        ctx.fillRect(x + bodyW * 0.42 - lw, yy - ch * 0.30, lw, lh);
        if (scale > 0.35) {
          ctx.fillStyle = 'rgba(255,90,70,0.35)';
          ctx.fillRect(x - bodyW * 0.44, yy - ch * 0.33, lw * 1.3, lh * 1.6);
          ctx.fillRect(x + bodyW * 0.44 - lw * 1.3, yy - ch * 0.33, lw * 1.3, lh * 1.6);
        }
      }

      // Outline keeps shapes readable in bright daylight
      if (scale > 0.08) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = Math.max(0.5, cw * 0.022);
        ctx.beginPath();
        ctx.moveTo(x - bodyW / 2 + tilt * 0.4, yy);
        ctx.lineTo(x + bodyW / 2 + tilt * 0.4, yy);
        ctx.lineTo(x + roofW / 2 + tilt * 1.2, top + ch * 0.06);
        ctx.lineTo(x - roofW / 2 + tilt * 1.2, top + ch * 0.06);
        ctx.closePath(); ctx.stroke();
      }
    }

    function drawHUD(elapsed) {
      const { oppMs: om, oppCrashed: oc } = hudRef.current;
      const mine = S.dead ? (hudRef.current.myMs || elapsed) : elapsed;

      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      roundRect(ctx, 12, 12, 132, 52, 12); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('YOUR TIME', 24, 32);
      ctx.font = '900 22px JetBrains Mono, monospace';
      ctx.fillText((mine / 1000).toFixed(1) + 's', 24, 55);

      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      roundRect(ctx, W - 144, 12, 132, 52, 12); ctx.fill();
      ctx.fillStyle = oc ? '#ff8787' : '#fff';
      ctx.font = '700 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(oc ? 'OPPONENT — OUT' : 'OPPONENT', W - 24, 32);
      ctx.font = '900 22px JetBrains Mono, monospace';
      ctx.fillText((om / 1000).toFixed(1) + 's', W - 24, 55);

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

    // Paint one frame immediately so the road is on screen before the first
    // animation tick (avoids a blank flash on load).
    draw(performance.now(), 0);
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
    <div className="relative w-full" style={{ height: 'calc(100dvh - 56px)', background: '#74bdec' }}>
      <canvas ref={canvasRef} className="w-full h-full block touch-none select-none" />
      <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none">
        <span className="text-[11px] text-white/85 font-semibold bg-black/35 px-3 py-1.5 rounded-full">
          ← → / A D · swipe or tap a side
        </span>
      </div>
    </div>
  );
}

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
  return `rgb(${cl(((n >> 16) & 255) + amt)},${cl(((n >> 8) & 255) + amt)},${cl((n & 255) + amt)})`;
}
