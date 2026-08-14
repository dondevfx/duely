import { useEffect, useRef } from 'react';
import { createRun, faceShades, blockFaces, makeView, isoProject, BASE_SIZE } from '../utils/towerCore';

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

    // Drifting motes: depth cues, not confetti.
    //
    // They rise from the lower third rather than from the very bottom edge, and
    // fade in over their first stretch — spawning hard-edged at y=1 made them
    // pop into existence at the screen edge, which is the thing that looked
    // wrong. They also fade out again near the top, so nothing blinks away.
    const MOTE_BIRTH = 0.66;      // fraction down the screen where they appear
    const newMote = (y) => ({
      x: 0.06 + Math.random() * 0.88,
      y: y ?? (MOTE_BIRTH + Math.random() * (1 - MOTE_BIRTH)),
      s: 1 + Math.random() * 1.5,
      v: 0.0009 + Math.random() * 0.0016,
      a: 0.10 + Math.random() * 0.13,
    });
    const motes = Array.from({ length: 16 }, () => newMote(Math.random()));

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
      for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        m.y -= m.v * dt * 60;
        if (m.y < -0.02) { motes[i] = newMote(); continue; }
        // Ease in over the first fifth of the climb and out over the last, so a
        // mote never appears or vanishes as a hard dot.
        const travelled = clamp((MOTE_BIRTH - m.y) / MOTE_BIRTH, 0, 1);
        const fade = Math.min(1, travelled / 0.2) * Math.min(1, (1 - travelled) / 0.25 + 0.25);
        ctx.globalAlpha = m.a * clamp(fade, 0, 1);
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
      //
      // Cosmetic blocks below the real base so the tower continues off the
      // bottom of the frame instead of sitting on nothing. Solid all the way
      // down, and faded by where each one lands ON SCREEN rather than by how
      // deep it is: tied to depth, the fade drifted as the camera rose and the
      // base could be left hanging in mid-air.
      const fadeFrom = height * 0.62;
      for (let L = -1; L >= -PLINTH_DEPTH; L--) {
        const yAt = view.originY + 0 - L * blockPx;
        if (yAt > height + blockPx * 2) break;    // fully past the bottom edge
        const t = clamp((yAt - fadeFrom) / (height - fadeFrom), 0, 1);
        drawBlock({ x: 0, y: 0, sx: BASE_SIZE, sy: BASE_SIZE, index: L },
                  L, 1 - t);
      }

      // ── tower ──
      const firstVisible = Math.max(0, Math.floor(camera - (height / blockPx) - 2));
      for (let i = firstVisible; i < s.blocks.length; i++) {
        drawBlock(s.blocks[i], s.blocks[i].level);
      }

      // ── falling offcuts ──
      //
      // Drawn over the tower and pushed clear of it, rather than sorted into it.
      // Interleaving by height was an attempt at honest occlusion, but what it
      // actually produced was a slice embedded halfway through the block below —
      // it read as clipping, not as depth. A piece that is knocked off, tips over
      // and falls away past the edge is both clearer and closer to what the
      // geometry implies.
      for (const sl of s.slices) {
        const drift = Math.min(1, sl.t * 2.2) * 0.45 * (sl.side || 1);
        const b = {
          x: sl.x + (sl.sy >= sl.sx ? drift : 0),
          y: sl.y + (sl.sy >= sl.sx ? 0 : drift),
          sx: sl.sx, sy: sl.sy, index: sl.index,
        };
        const at = isoProject(b.x, b.y, sl.level, view);
        // Gone by the time it reaches the bottom of the screen.
        const nearBottom = clamp((at.py - height * 0.8) / (height * 0.25), 0, 1);
        const alpha = clamp(1 - sl.t / 1.9, 0, 1) * (1 - nearBottom);
        if (alpha <= 0.01) continue;
        ctx.save();
        ctx.translate(at.px, at.py);
        ctx.rotate(sl.spin * 0.22);
        ctx.translate(-at.px, -at.py);
        drawBlock(b, sl.level, alpha);
        ctx.restore();
      }

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
        ctx.lineWidth = 3.5;
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
