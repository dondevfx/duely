import { useEffect, useRef } from 'react';
import { createRun, shadeFor, blockFaces, makeView } from '../utils/towerCore';

// Tower — isometric renderer.
//
// Plain 2D canvas, no 3D library. An isometric block is three flat quads: a top
// rhombus and two side faces, each a different shade of the same colour. That is
// the whole trick, and it costs nothing next to pulling in a renderer.
//
// World -> screen: the x and y ground axes project to the two 45-degree
// diagonals, which is why a sliding block appears to travel diagonally down the
// screen. z is height and moves straight up.
//
//   sx = (x - y) * halfW
//   sy = (x + y) * halfH - level * blockPx
//
// halfH is half of halfW, the usual 2:1 isometric ratio.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default function TowerCanvas({
  running = false,     // input is live
  onScore,             // (score) => void — every successful placement
  onGameOver,          // ({ score, taps }) => void
  onPerfect,           // () => void — for a sound or a flash
  showScore = true,
}) {
  const canvasRef = useRef(null);
  const runRef    = useRef(null);
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);

  // Callbacks live in refs so the loop never restarts when a parent re-renders —
  // restarting it mid-run would reset the tower.
  const cb = useRef({ onScore, onGameOver, onPerfect });
  useEffect(() => { cb.current = { onScore, onGameOver, onPerfect }; });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let width = 0, height = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      width = r.width; height = r.height;
      canvas.width  = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);

    const run = createRun({
      onLand: ({ perfect, score }) => {
        cb.current.onScore?.(score);
        if (perfect) cb.current.onPerfect?.();
      },
      onOver: ({ score }) => {
        cb.current.onGameOver?.({ score, taps: run.state.taps.slice() });
      },
    });
    runRef.current = run;

    // Drifting motes, purely decorative — the reference art has them and a flat
    // black field looks dead without something moving in it.
    const motes = Array.from({ length: 26 }, () => ({
      x: Math.random(), y: Math.random(),
      s: 1.5 + Math.random() * 3,
      v: 0.004 + Math.random() * 0.012,
      a: 0.15 + Math.random() * 0.4,
    }));

    let camera = 0;        // eased vertical follow, in block levels
    let last = performance.now();
    let raf = 0;

    const drop = () => {
      if (!runningRef.current) return;
      run.drop();
    };
    const onPointer = (e) => { e.preventDefault(); drop(); };
    const onKey = (e) => {
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') { e.preventDefault(); drop(); }
    };
    canvas.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);

    function frame(now) {
      const dt = clamp((now - last) / 1000, 0, 0.05);   // clamp: a backgrounded
      last = now;                                        // tab must not teleport
      if (runningRef.current) run.step(dt);

      const s = run.state;

      const topLevel = s.blocks[s.blocks.length - 1]?.level ?? 0;
      // Keep the working top around 58% down the screen: high enough to see the
      // incoming block, low enough to show the tower beneath it.
      const targetCam = topLevel;
      camera += (targetCam - camera) * Math.min(1, dt * 6);

      // Geometry and camera live in towerCore so they can be tested without a
      // DOM — a sign error here leans the whole tower.
      const view = makeView(width, height, camera);
      const blockPx = view.blockPx;

      // ── background ──
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      for (const m of motes) {
        m.y -= m.v * dt * 60;
        if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
        ctx.globalAlpha = m.a;
        ctx.fillStyle = '#cfe6ff';
        ctx.fillRect(m.x * width, m.y * height, m.s, m.s);
      }
      ctx.globalAlpha = 1;

      const poly = (pts) => {
        ctx.beginPath();
        ctx.moveTo(pts[0].px, pts[0].py);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
        ctx.closePath();
        ctx.fill();
      };

      const drawBlock = (b, level, alpha = 1) => {
        const { hue, light, sat } = shadeFor(b.index);
        const f = blockFaces(b, level, view);
        ctx.globalAlpha = alpha;
        // Sides first, so the top edge sits cleanly over them.
        ctx.fillStyle = `hsl(${hue} ${sat}% ${Math.max(6, light - 16)}%)`;
        poly(f.right);
        ctx.fillStyle = `hsl(${hue} ${sat}% ${Math.max(4, light - 26)}%)`;
        poly(f.left);
        ctx.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
        poly(f.top);
        ctx.globalAlpha = 1;
      };

      // ── tower ──
      // Only what is on screen: a long run is hundreds of blocks and there is no
      // reason to path any that sit below the viewport.
      const firstVisible = Math.max(0, Math.floor(camera - (height / blockPx) - 2));
      for (let i = firstVisible; i < s.blocks.length; i++) {
        drawBlock(s.blocks[i], s.blocks[i].level);
      }

      // ── falling offcuts ──
      for (const sl of s.slices) {
        drawBlock(sl, sl.level, clamp(1 - sl.t / 1.6, 0, 1));
      }

      // ── the slider ──
      if (s.moving) {
        const m = s.moving;
        const mv = {
          x: m.axis === 'x' ? m.pos : s.blocks[s.blocks.length - 1].x,
          y: m.axis === 'y' ? m.pos : s.blocks[s.blocks.length - 1].y,
          sx: m.sx, sy: m.sy,
          index: s.blocks.length,
        };
        drawBlock(mv, topLevel + 1);
      }

      // ── score ──
      if (showScore) {
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `200 ${Math.round(Math.min(width, height) * 0.16)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        ctx.fillText(String(s.score), width / 2, height * 0.16);
      }

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        background: '#000',
        touchAction: 'none',
        cursor: 'pointer',
      }}
    />
  );
}
