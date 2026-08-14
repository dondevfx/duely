import { useEffect, useRef } from 'react';
import { createRun, faceShades, blockFaces, makeView, BASE_SIZE } from '../utils/towerCore';

// Tower — isometric renderer.
//
// Plain 2D canvas, no 3D library. An isometric block is three flat quads: a top
// rhombus and two side faces, each a different shade of the same colour.
//
// World -> screen: the x and y ground axes project to the two 45-degree
// diagonals, which is why a sliding block appears to travel diagonally down the
// screen. z is height and moves straight up. The projection itself lives in
// towerCore so it can be tested without a DOM.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Decorative depth below the real base, so the tower looks like it continues
// down out of sight instead of sitting on nothing.
const PLINTH_DEPTH = 16;

export default function TowerCanvas({
  running = false,     // input is live
  onScore,             // (score) => void — every successful placement
  onGameOver,          // ({ score, taps }) => void
  onPerfect,           // () => void — perfect drop, for sound and haptics
  onPlace,             // () => void — ordinary placement
  showScore = true,
}) {
  const canvasRef = useRef(null);
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);

  // Callbacks live in refs so the loop never restarts when a parent re-renders —
  // restarting it mid-run would reset the tower.
  const cb = useRef({ onScore, onGameOver, onPerfect, onPlace });
  useEffect(() => { cb.current = { onScore, onGameOver, onPerfect, onPlace }; });

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
        else cb.current.onPlace?.();
      },
      onOver: ({ score }) => {
        cb.current.onGameOver?.({ score, taps: run.state.taps.slice() });
      },
    });

    // Drifting motes. Few, dim and slow — they are depth cues, not confetti, and
    // anything brighter competes with the tower for attention.
    const motes = Array.from({ length: 12 }, () => ({
      x: Math.random(), y: Math.random(),
      s: 1 + Math.random() * 1.6,
      v: 0.0012 + Math.random() * 0.0028,
      a: 0.05 + Math.random() * 0.10,
    }));

    let camera = 0;        // eased vertical follow, in block levels
    let last = performance.now();
    let raf = 0;

    const drop = () => { if (runningRef.current) run.drop(); };
    const onPointer = (e) => { e.preventDefault(); drop(); };
    const onKey = (e) => {
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') { e.preventDefault(); drop(); }
    };
    canvas.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);

    function frame(now) {
      const dt = clamp((now - last) / 1000, 0, 0.05);   // clamp: a backgrounded
      last = now;                                        // tab must not teleport
      run.step(dt);

      const s = run.state;
      const topLevel = s.blocks[s.blocks.length - 1]?.level ?? 0;
      camera += (topLevel - camera) * Math.min(1, dt * 6);

      const view = makeView(width, height, camera);
      const blockPx = view.blockPx;

      // ── background ──
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      for (const m of motes) {
        m.y -= m.v * dt * 60;
        if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
        ctx.globalAlpha = m.a;
        ctx.fillStyle = '#9dc4ff';
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
        if (alpha <= 0.01) return;
        // Side lightness is a RATIO of the top rather than a fixed subtraction,
        // so a dark block keeps the same relative shading a light one has
        // instead of flattening into a single silhouette.
        const { hue, sat, top, right, left } = faceShades(b.index);
        const f = blockFaces(b, level, view);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `hsl(${hue} ${sat}% ${right}%)`;
        poly(f.right);
        ctx.fillStyle = `hsl(${hue} ${sat}% ${left}%)`;
        poly(f.left);
        ctx.fillStyle = `hsl(${hue} ${sat}% ${top}%)`;
        poly(f.top);
        ctx.globalAlpha = 1;
      };

      // ── plinth ──
      // Purely cosmetic blocks below the real base, fading out downward so the
      // tower reads as continuing into darkness rather than floating.
      const lowestVisible = Math.floor((view.originY - height) / blockPx) - 1;
      const plinthFrom = Math.max(lowestVisible, -PLINTH_DEPTH);
      for (let L = -1; L >= plinthFrom; L--) {
        drawBlock({ x: 0, y: 0, sx: BASE_SIZE, sy: BASE_SIZE, index: L },
                  L, clamp(1 + L / PLINTH_DEPTH, 0, 1));
      }

      // ── tower and offcuts, in depth order ──
      //
      // A falling offcut must be able to pass BEHIND the tower: it was sliced off
      // a real block and half of it is on the far side. Sorting by level and,
      // within a level, putting the far-side offcut before the block and the
      // near-side one after, gets that for free — later draws sit on top.
      const firstVisible = Math.max(0, Math.floor(camera - (height / blockPx) - 2));
      const drawables = [];
      for (let i = firstVisible; i < s.blocks.length; i++) {
        drawables.push({ b: s.blocks[i], level: s.blocks[i].level, order: 0, alpha: 1 });
      }
      for (const sl of s.slices) {
        drawables.push({
          b: sl, level: sl.level,
          order: sl.side < 0 ? -1 : 1,
          alpha: clamp(1 - sl.t / 1.6, 0, 1),
        });
      }
      drawables.sort((a, b) => (a.level - b.level) || (a.order - b.order));
      for (const d of drawables) drawBlock(d.b, d.level, d.alpha);

      // ── the slider ──
      if (s.moving) {
        const m = s.moving;
        const top = s.blocks[s.blocks.length - 1];
        drawBlock({
          x: m.axis === 'x' ? m.pos : top.x,
          y: m.axis === 'y' ? m.pos : top.y,
          sx: m.sx, sy: m.sy,
          index: s.blocks.length,
        }, topLevel + 1);
      }

      // ── perfect-drop burst ──
      // A white outline at the seam where the block met the one below, expanding
      // and fading. Drawn after the tower so it is never buried by it.
      for (const burst of s.bursts) {
        const life = burst.t / 0.42;
        if (life >= 1) continue;
        const grow = 1 + life * 1.7;
        const f = blockFaces(
          { x: burst.x, y: burst.y, sx: burst.sx * grow, sy: burst.sy * grow, index: 0 },
          burst.level, view);
        ctx.globalAlpha = (1 - life) * 0.85;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(f.top[0].px, f.top[0].py);
        for (let i = 1; i < f.top.length; i++) ctx.lineTo(f.top[i].px, f.top[i].py);
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── score ──
      if (showScore) {
        // Much smaller on a desktop: the same fraction that reads as bold on a
        // phone becomes a wall of text across a monitor.
        const scale = width < 640 ? 0.155 : 0.075;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `200 ${Math.round(Math.min(width, height) * scale)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        ctx.fillText(String(s.score), width / 2, height * (width < 640 ? 0.16 : 0.12));
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
        // A long press used to select the canvas and pop up the copy handles,
        // which eats the next tap — mid-run that costs a block.
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
        cursor: 'pointer',
      }}
    />
  );
}
