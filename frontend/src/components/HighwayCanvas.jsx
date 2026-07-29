import { useEffect, useRef } from 'react';

/**
 * Highway Dash — neon night renderer (Canvas 2D, no WebGL / no extra deps).
 *
 * Art direction matches the site: pure black, neon blue (#1250B4) and cyan
 * (#00BFFF) with glow. Geometry is real pseudo-3D (perspective projection with
 * curves and hills) but everything is drawn flat-shaded with neon outlines — a
 * "3D scene, 2D look" arcade style.
 *
 * Traffic is generated from the shared server seed, so both players drive the
 * exact same road — the match is pure skill.
 */

const LANES      = 4;
const CAM_DEPTH  = 260;
const ROAD_HALF  = 0.40;
const PLAYER_Z   = 34;
const BASE_SPEED = 340;
const MAX_SPEED  = 1150;
const RAMP_MS    = 55_000;
const DRAW_DIST  = 2600;

const C = {
  cyan:    '#00BFFF',
  blue:    '#1250B4',
  road:    '#07070E',
  roadAlt: '#0A0A14',
  grid:    'rgba(0,191,255,0.16)',
  horizon: '#0A2A55',
};
// Traffic reads as hostile: hot neons against the cool player blue.
const TRAFFIC = [
  { body: '#2A0A18', edge: '#FF2D95' },
  { body: '#2A1206', edge: '#FF7A1A' },
  { body: '#2A2404', edge: '#FFD23F' },
  { body: '#052618', edge: '#06FFA5' },
  { body: '#1C0A2A', edge: '#B14AED' },
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

export default function HighwayCanvas({
  seed, myMs, oppMs, oppCrashed, crashed, opponentName, onProgress, onCrash,
}) {
  const canvasRef = useRef(null);
  const cbRef     = useRef({ onProgress, onCrash });
  useEffect(() => { cbRef.current = { onProgress, onCrash }; }, [onProgress, onCrash]);
  const hudRef = useRef({ myMs: 0, oppMs: 0, oppCrashed: false, opponentName: '' });
  useEffect(() => { hudRef.current = { myMs, oppMs, oppCrashed, opponentName }; }, [myMs, oppMs, oppCrashed, opponentName]);

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
      lane: 1.5, targetLane: 1.5, wobble: 0,
      cars: [], props: [], particles: [],
      nextSpawn: 900, nextProp: 260,
      dead: false, deadAt: 0, shake: 0, lastPing: 0,
      stars: Array.from({ length: 90 }, () => ({
        x: rand(), y: rand() * 0.38, r: rand() * 1.3 + 0.3, tw: rand() * 6.28,
      })),
      city: Array.from({ length: 46 }, () => ({
        x: rand(), w: 0.02 + rand() * 0.05, h: 0.03 + rand() * 0.13, lit: rand(),
      })),
    };

    const curveAt = (z) => Math.sin(z * 0.0008) * 460 + Math.sin(z * 0.00029) * 320;
    const hillAt  = (z) => Math.sin(z * 0.0012) * 26 + Math.sin(z * 0.00047) * 40;

    // ── Controls ──
    const move = (dir) => {
      if (S.dead) return;
      const next = Math.max(0, Math.min(LANES - 1, Math.round(S.targetLane) + dir));
      if (next !== S.targetLane) S.wobble = dir;
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
    const horizonY = () => H * 0.44;
    const baseY    = () => H * 0.96;
    const project = (z) => {
      const scale = CAM_DEPTH / (CAM_DEPTH + Math.max(z, -CAM_DEPTH * 0.85));
      const hy = horizonY(), by = baseY();
      return { scale, y: hy + (by - hy) * scale };
    };
    const laneOffset = (lane) => (lane - (LANES - 1) / 2) / (LANES / 2);
    const roadCenter = (wz, scale) => W / 2 + (curveAt(wz) - curveAt(S.dist)) * scale * 0.55;

    const neon = (color, blur, fn) => {
      ctx.save();
      ctx.shadowColor = color; ctx.shadowBlur = blur;
      fn();
      ctx.restore();
    };

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

        while (S.dist + DRAW_DIST > S.nextSpawn) {
          const diff = Math.min(elapsed / RAMP_MS, 1);
          const blocked = 1 + Math.floor(rand() * (diff > 0.55 ? 2.99 : 1.99));
          const lanes = [0, 1, 2, 3].sort(() => rand() - 0.5).slice(0, Math.min(blocked, LANES - 1));
          for (const ln of lanes) {
            S.cars.push({ z: S.nextSpawn - S.dist, lane: ln, c: TRAFFIC[Math.floor(rand() * TRAFFIC.length)] });
          }
          S.nextSpawn += 430 + rand() * 520 - diff * 130;
        }
        while (S.dist + DRAW_DIST > S.nextProp) {
          const k = rand();
          S.props.push({
            z: S.nextProp - S.dist, side: rand() < 0.5 ? -1 : 1,
            type: k < 0.62 ? 'pole' : 'board',
            hue: rand() < 0.5 ? C.cyan : '#FF2D95',
            h: 0.85 + rand() * 0.4,
          });
          S.nextProp += 120 + rand() * 160;
        }

        for (const c of S.cars)  c.z -= S.speed * dt;
        for (const p of S.props) p.z -= S.speed * dt;
        S.cars  = S.cars.filter(c => c.z > -260);
        S.props = S.props.filter(p => p.z > -260);

        for (const c of S.cars) {
          if (c.z < 78 && c.z > -50 && Math.abs(c.lane - S.lane) < 0.7) {
            S.dead = true; S.deadAt = now; S.shake = 1;
            for (let i = 0; i < 44; i++) {
              S.particles.push({
                x: 0, y: 0, vx: (rand() - 0.5) * 560, vy: -rand() * 460 - 80,
                life: 0.6 + rand() * 0.7, age: 0,
                c: [C.cyan, '#FFFFFF', c.c.edge][Math.floor(rand() * 3)],
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
        for (const p of S.particles) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; }
        S.particles = S.particles.filter(p => p.age < p.life);
      }
      draw(now, elapsed);
    }

    function draw(now, elapsed) {
      const hy = horizonY(), by = baseY();
      const sx = S.shake ? (Math.random() - 0.5) * 16 * S.shake : 0;
      const sy = S.shake ? (Math.random() - 0.5) * 12 * S.shake : 0;

      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.translate(sx, sy);

      drawSky(hy, now);
      drawGround(hy, by);
      const edges = buildRoad(hy, by);
      drawRoad(edges, hy);

      // Scenery + traffic, far → near
      const scene = [
        ...S.props.map(p => ({ o: p, k: 'p', z: p.z })),
        ...S.cars.map(c => ({ o: c, k: 'c', z: c.z })),
      ].sort((a, b) => b.z - a.z);
      for (const it of scene) {
        if (it.z > DRAW_DIST) continue;
        if (it.k === 'p') drawProp(it.o); else drawCar(it.o.z, it.o.lane, it.o.c, false);
      }
      if (!S.dead) drawCar(PLAYER_Z, S.lane, null, true);

      drawSpeedFX(hy, now);
      if (S.dead) drawCrashFX(now);

      ctx.restore();
      drawVignette();
      drawHUD(elapsed);
    }

    // ── Sky: stars, neon sun, city skyline ──
    function drawSky(hy, now) {
      const g = ctx.createLinearGradient(0, 0, 0, hy);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.55, '#03060F');
      g.addColorStop(1, '#071A33');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, hy);

      for (const s of S.stars) {
        const a = 0.35 + Math.sin(now * 0.0016 + s.tw) * 0.3;
        ctx.globalAlpha = Math.max(0.08, a);
        ctx.fillStyle = '#CFEFFF';
        ctx.fillRect(s.x * W, s.y * hy, s.r, s.r);
      }
      ctx.globalAlpha = 1;

      // Neon sun with scanline slits
      const sunX = W * 0.5, sunR = Math.min(W, H) * 0.15, sunY = hy - sunR * 0.34;
      ctx.save();
      ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2); ctx.clip();
      const sg = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
      sg.addColorStop(0, '#7FE3FF'); sg.addColorStop(0.5, C.cyan); sg.addColorStop(1, C.blue);
      ctx.fillStyle = sg; ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);
      ctx.fillStyle = '#000';
      for (let i = 0; i < 9; i++) {
        const yy = sunY + sunR * (i / 9) * 1.05;
        ctx.fillRect(sunX - sunR, yy, sunR * 2, sunR * (0.018 + i * 0.011));
      }
      ctx.restore();
      neon(C.cyan, 46, () => {
        ctx.strokeStyle = 'rgba(0,191,255,0.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2); ctx.stroke();
      });

      // City skyline
      const shift = (S.dist * 0.006) % 1;
      ctx.fillStyle = '#04070E';
      for (const b of S.city) {
        const bx = (((b.x - shift) % 1) + 1) % 1 * W;
        const bh = b.h * hy, bw = b.w * W;
        ctx.fillRect(bx, hy - bh, bw, bh);
      }
      ctx.fillStyle = 'rgba(0,191,255,0.5)';
      for (const b of S.city) {
        if (b.lit < 0.45) continue;
        const bx = (((b.x - shift) % 1) + 1) % 1 * W;
        const bh = b.h * hy, bw = b.w * W;
        for (let wy = hy - bh + 4; wy < hy - 4; wy += 7) {
          for (let wx = bx + 3; wx < bx + bw - 3; wx += 6) {
            if (((wx * 13 + wy * 7) % 11) < 4) ctx.fillRect(wx, wy, 2, 3);
          }
        }
      }
      // Horizon glow line
      neon(C.cyan, 26, () => {
        ctx.strokeStyle = 'rgba(0,191,255,0.75)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
      });
    }

    // ── Ground: receding neon grid ──
    function drawGround(hy, by) {
      ctx.fillStyle = '#02030A'; ctx.fillRect(0, hy, W, H - hy);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;

      // Horizontal lines scrolling toward the camera
      ctx.beginPath();
      for (let i = 0; i < 26; i++) {
        const z = i * 130 - (S.dist % 130);
        if (z < 1) continue;
        const { y } = project(z);
        if (y > hy + 1 && y < H) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      }
      ctx.stroke();

      // Converging verticals
      ctx.beginPath();
      for (let i = -9; i <= 9; i++) {
        const far = project(DRAW_DIST);
        const near = project(0);
        const fx = roadCenter(S.dist + DRAW_DIST, far.scale) + i * W * 0.5 * far.scale;
        const nx = roadCenter(S.dist, near.scale) + i * W * 0.5 * near.scale;
        ctx.moveTo(fx, far.y); ctx.lineTo(nx, near.y);
      }
      ctx.stroke();
    }

    // Sample road edges down the screen so we can fill + glow-stroke them.
    function buildRoad(hy, by) {
      const pts = [];
      for (let y = Math.ceil(hy) + 1; y <= H; y += 4) {
        const scale = (y - hy) / (by - hy);
        if (scale <= 0.0008) continue;
        const z = CAM_DEPTH * (1 / scale - 1);
        const wz = S.dist + z;
        const cx = roadCenter(wz, scale);
        const half = ROAD_HALF * W * scale;
        pts.push({ y, cx, half, wz, scale });
      }
      return pts;
    }

    function drawRoad(pts, hy) {
      if (!pts.length) return;

      // Surface
      ctx.beginPath();
      ctx.moveTo(pts[0].cx - pts[0].half, pts[0].y);
      for (const p of pts) ctx.lineTo(p.cx - p.half, p.y);
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].cx + pts[i].half, pts[i].y);
      ctx.closePath();
      const rg = ctx.createLinearGradient(0, hy, 0, H);
      rg.addColorStop(0, C.roadAlt); rg.addColorStop(1, C.road);
      ctx.fillStyle = rg; ctx.fill();

      // Lane dashes — glowing segments
      neon(C.cyan, 8, () => {
        ctx.fillStyle = 'rgba(120,220,255,0.75)';
        for (const p of pts) {
          if (Math.floor(p.wz / 44) % 2 !== 0) continue;
          const dw = Math.max(0.8, p.half * 0.016);
          for (let l = 1; l < LANES; l++) {
            const lx = p.cx + (l - LANES / 2) * (p.half * 2 / LANES);
            ctx.fillRect(lx - dw / 2, p.y, dw, 4);
          }
        }
      });

      // Glowing edges
      const edge = (side) => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = p.cx + side * p.half;
          i === 0 ? ctx.moveTo(x, p.y) : ctx.lineTo(x, p.y);
        });
        ctx.stroke();
      };
      neon(C.cyan, 22, () => {
        ctx.strokeStyle = C.cyan; ctx.lineWidth = 3; ctx.lineJoin = 'round';
        edge(-1); edge(1);
      });
      ctx.strokeStyle = 'rgba(220,250,255,0.9)'; ctx.lineWidth = 1.2;
      edge(-1); edge(1);
    }

    // ── Roadside neon props ──
    function drawProp(p) {
      const { scale, y } = project(p.z);
      if (scale <= 0.02) return;
      const wz = S.dist + p.z;
      const cx = roadCenter(wz, scale);
      const half = ROAD_HALF * W * scale;
      const x = cx + p.side * half * 1.32;
      const yy = y - hillAt(wz) * scale * 0.4;
      const u = half * 0.1;
      const blur = scale > 0.25 ? 16 : 6;

      if (p.type === 'pole') {
        ctx.fillStyle = '#0C1220';
        ctx.fillRect(x - u * 0.12, yy - u * 6.2 * p.h, u * 0.24, u * 6.2 * p.h);
        neon(p.hue, blur, () => {
          ctx.fillStyle = p.hue;
          ctx.fillRect(x - u * 0.16, yy - u * 6.4 * p.h, u * 0.32, u * 0.5);
          ctx.fillRect(x - u * 0.12, yy - u * 6.2 * p.h, -p.side * u * 1.5, u * 0.16);
        });
      } else {
        const bw = u * 3.4, bh = u * 2.1, top = yy - u * 5.6;
        ctx.fillStyle = '#0C1220';
        ctx.fillRect(x - u * 0.1, yy - u * 3.6, u * 0.2, u * 3.6);
        ctx.fillStyle = 'rgba(6,10,20,0.92)';
        ctx.fillRect(x - bw / 2, top, bw, bh);
        neon(p.hue, blur, () => {
          ctx.strokeStyle = p.hue; ctx.lineWidth = Math.max(1, u * 0.14);
          ctx.strokeRect(x - bw / 2, top, bw, bh);
        });
        if (scale > 0.16) {
          ctx.fillStyle = p.hue; ctx.globalAlpha = 0.5;
          ctx.fillRect(x - bw * 0.32, top + bh * 0.28, bw * 0.64, bh * 0.1);
          ctx.fillRect(x - bw * 0.32, top + bh * 0.52, bw * 0.42, bh * 0.1);
          ctx.globalAlpha = 1;
        }
      }
    }

    // ── Cars: flat-shaded with neon outline ──
    function drawCar(z, lane, colors, isPlayer) {
      const { scale, y } = project(z);
      if (scale <= 0.022) return;
      const wz = S.dist + z;
      const cx = roadCenter(wz, scale);
      const half = ROAD_HALF * W * scale;
      const laneW = (half * 2) / LANES;
      const x = cx + laneOffset(lane) * half;
      const yy = y - hillAt(wz) * scale * 0.4;

      const cw = laneW * 0.62;
      const ch = cw * 0.78;
      const tilt = isPlayer ? S.wobble * cw * 0.09 : 0;
      const body = isPlayer ? '#0A1F3D' : colors.body;
      const edgeC = isPlayer ? C.cyan : colors.edge;
      const top = yy - ch;
      const bw = cw, roofW = cw * 0.68;
      const blur = scale > 0.3 ? 16 : scale > 0.12 ? 8 : 0;

      // Ground glow pool
      if (scale > 0.1) {
        ctx.save();
        ctx.globalAlpha = 0.32;
        const gp = ctx.createRadialGradient(x, yy, 0, x, yy, cw * 0.9);
        gp.addColorStop(0, edgeC); gp.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gp;
        ctx.beginPath(); ctx.ellipse(x, yy, cw * 0.85, ch * 0.26, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      const bodyPath = () => {
        ctx.beginPath();
        ctx.moveTo(x - bw / 2 + tilt * 0.4, yy);
        ctx.lineTo(x + bw / 2 + tilt * 0.4, yy);
        ctx.lineTo(x + bw * 0.44 + tilt * 0.8, top + ch * 0.44);
        ctx.lineTo(x + roofW / 2 + tilt * 1.2, top + ch * 0.06);
        ctx.lineTo(x - roofW / 2 + tilt * 1.2, top + ch * 0.06);
        ctx.lineTo(x - bw * 0.44 + tilt * 0.8, top + ch * 0.44);
        ctx.closePath();
      };

      ctx.fillStyle = body; bodyPath(); ctx.fill();

      // Neon rim
      neon(edgeC, blur, () => {
        ctx.strokeStyle = edgeC;
        ctx.lineWidth = Math.max(1, cw * 0.05);
        ctx.lineJoin = 'round';
        bodyPath(); ctx.stroke();
      });

      // Windscreen slab
      ctx.fillStyle = isPlayer ? 'rgba(0,191,255,0.30)' : 'rgba(255,255,255,0.13)';
      ctx.beginPath();
      ctx.moveTo(x - roofW * 0.42 + tilt, top + ch * 0.40);
      ctx.lineTo(x + roofW * 0.42 + tilt, top + ch * 0.40);
      ctx.lineTo(x + roofW * 0.34 + tilt * 1.2, top + ch * 0.14);
      ctx.lineTo(x - roofW * 0.34 + tilt * 1.2, top + ch * 0.14);
      ctx.closePath(); ctx.fill();

      // Light bar
      const lw = cw * 0.2, lh = Math.max(1.2, ch * 0.1);
      neon(isPlayer ? '#BFF0FF' : '#FF3B30', blur * 0.8, () => {
        ctx.fillStyle = isPlayer ? '#DFF6FF' : '#FF5A47';
        ctx.fillRect(x - bw * 0.42 + tilt * 0.4, yy - ch * 0.3, lw, lh);
        ctx.fillRect(x + bw * 0.42 - lw + tilt * 0.4, yy - ch * 0.3, lw, lh);
      });

      // Underglow strip
      if (scale > 0.14) {
        neon(edgeC, blur, () => {
          ctx.fillStyle = edgeC; ctx.globalAlpha = 0.85;
          ctx.fillRect(x - bw * 0.42 + tilt * 0.4, yy - ch * 0.03, bw * 0.84, Math.max(1, ch * 0.045));
        });
      }
    }

    function drawSpeedFX(hy, now) {
      const spd = (S.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
      if (spd <= 0.05 || S.dead) return;
      ctx.strokeStyle = `rgba(0,191,255,${0.1 + spd * 0.22})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 12; i++) {
        const t = ((now * (0.5 + spd) * 0.0012) + i * 0.27) % 1;
        const yy = hy + (H - hy) * (t * t);
        const side = i % 2 === 0 ? -1 : 1;
        const xx = W / 2 + side * (W * 0.3 + t * W * 0.34);
        ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 26 + t * 74); ctx.stroke();
      }
    }

    function drawCrashFX(now) {
      const p0 = project(PLAYER_Z);
      const px = roadCenter(S.dist + PLAYER_Z, p0.scale) + laneOffset(S.lane) * ROAD_HALF * W * p0.scale;
      for (const p of S.particles) {
        ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
        ctx.fillStyle = p.c;
        ctx.shadowColor = p.c; ctx.shadowBlur = 10;
        ctx.fillRect(px + p.x - 2.5, p0.y + p.y - 2.5, 5, 5);
      }
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      const since = now - S.deadAt;
      if (since < 260) {
        ctx.fillStyle = `rgba(180,240,255,${0.75 * (1 - since / 260)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function drawVignette() {
      const v = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.28, W / 2, H * 0.55, Math.max(W, H) * 0.78);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
      // Subtle CRT scanlines — arcade texture
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    }

    // ── HUD in site style: black cards, neon border, glow ──
    function drawHUD(elapsed) {
      const { oppMs: om, oppCrashed: oc, myMs: mm, opponentName: on } = hudRef.current;
      const mine = S.dead ? (mm || elapsed) : elapsed;
      const card = (x, y, w, h, color) => {
        ctx.fillStyle = 'rgba(5,5,10,0.82)';
        roundRect(ctx, x, y, w, h, 12); ctx.fill();
        ctx.save();
        ctx.shadowColor = color; ctx.shadowBlur = 14;
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, w, h, 12); ctx.stroke();
        ctx.restore();
      };

      card(14, 14, 138, 56, C.cyan);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(150,200,230,0.9)';
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.fillText('YOUR TIME', 28, 35);
      ctx.fillStyle = '#EAF8FF';
      ctx.font = '900 23px "JetBrains Mono", monospace';
      ctx.fillText((mine / 1000).toFixed(1) + 's', 28, 59);

      const oc2 = oc ? '#FF5A47' : '#8899AA';
      card(W - 152, 14, 138, 56, oc2);
      ctx.textAlign = 'right';
      ctx.fillStyle = oc ? '#FF8A7A' : 'rgba(150,200,230,0.9)';
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.fillText(oc ? 'OPPONENT — OUT' : 'OPPONENT', W - 28, 35);
      ctx.fillStyle = '#EAF8FF';
      ctx.font = '900 23px "JetBrains Mono", monospace';
      ctx.fillText((om / 1000).toFixed(1) + 's', W - 28, 59);

      if (!S.dead) {
        const lead = mine - om;
        const col = lead >= 0 ? '#22C55E' : '#FF5A47';
        ctx.textAlign = 'center';
        ctx.font = '900 13px Inter, system-ui, sans-serif';
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 12;
        ctx.fillStyle = col;
        ctx.fillText(lead >= 0 ? `LEADING +${(lead / 1000).toFixed(1)}s` : `BEHIND ${(lead / 1000).toFixed(1)}s`, W / 2, 40);
        ctx.restore();
      }

      if (S.dead) {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(0, H * 0.34, W, 128);
        ctx.save(); ctx.shadowColor = '#FF3B30'; ctx.shadowBlur = 26;
        ctx.fillStyle = '#FF5A47';
        ctx.font = '900 40px Inter, system-ui, sans-serif';
        ctx.fillText('CRASHED', W / 2, H * 0.34 + 56);
        ctx.restore();
        ctx.fillStyle = '#9FB3C8';
        ctx.font = '700 14px Inter, system-ui, sans-serif';
        ctx.fillText(oc ? 'Waiting for result…' : `${on || 'Opponent'} is still driving…`, W / 2, H * 0.34 + 92);
      }
    }

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
    <div className="relative w-full" style={{ height: 'calc(100dvh - 56px)', background: '#000' }}>
      <canvas ref={canvasRef} className="w-full h-full block touch-none select-none" />
      <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none">
        <span className="text-[11px] text-accent/90 font-bold bg-black/70 border border-accent/30 px-3 py-1.5 rounded-full">
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
