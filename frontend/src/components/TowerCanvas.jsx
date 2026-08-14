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
    const MOTE_BIRTH = 0.88;      // fraction down the screen where they appear
    const newMote = (y) => ({
      x: 0.06 + Math.random() * 0.88,
      y: y ?? (MOTE_BIRTH + Math.random() * (1 - MOTE_BIRTH)),
      s: 1 + Math.random() * 1.5,
      v: 0.0009 + Math.random() * 0.0016,
      a: 0.10 + Math.random() * 0.13,
    });
    const motes = Array.from({ length: 30 }, () => newMote(Math.random()));

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
      // bottom of the frame instead of sitting on nothing.
      //
      // Drawn fully OPAQUE. Fading them with alpha was the mistake: a stack of
      // semi-transparent blocks lets every block behind show through, so the
      // base came out as a lattice of overlapping diamonds instead of a solid
      // tower. The disappearance is done afterwards with a black scrim over the
      // bottom of the screen — the tower stays solid and is swallowed by the
      // dark, which is what the reference actually does.
      // Deepest FIRST. This loop used to run from L = -1 downward, so each block
      // was painted over the one above it — and since a block's top face is
      // drawn last, every deeper block stamped its own rhombus across the base
      // of its neighbour. The result was a stack of visible lids that read as
      // wireframe outlines rather than a solid column. The real tower is drawn
      // bottom-up for exactly this reason; the plinth was the one place going
      // the other way.
      let plinthBottom = -1;
      for (let L = -1; L >= -PLINTH_DEPTH; L--) {
        plinthBottom = L;
        if (view.originY - L * blockPx > height + blockPx * 2) break;
      }
      for (let L = plinthBottom; L <= -1; L++) {
        drawBlock({ x: 0, y: 0, sx: BASE_SIZE, sy: BASE_SIZE, index: L }, L, 1);
      }

      // ── falling offcuts ──
      //
      // Behind the tower and fully opaque.
      //
      // Two earlier attempts were wrong in the same way. Sorting them into the
      // tower by height embedded a slice halfway through the block below, and
      // drawing them on top with a fading alpha made them literally see-through,
      // so the tower showed straight through the falling piece. Painting them
      // first means the tower simply covers them, which is what "cut off and
      // dropped" should look like; the tilt is gone because a spinning piece
      // sweeping sideways over the tower is exactly what drew attention to the
      // overlap.
      for (const sl of s.slices) {
        const at = isoProject(sl.x, sl.y, sl.level, view);
        if (at.py > height + blockPx * 3) continue;
        drawBlock({ x: sl.x, y: sl.y, sx: sl.sx, sy: sl.sy, index: sl.index }, sl.level, 1);
      }

      // ── tower ──
      // After the offcuts, so a falling piece is hidden behind it rather than
      // floating over it.
      const firstVisible = Math.max(0, Math.floor(camera - (height / blockPx) - 2));
      for (let i = firstVisible; i < s.blocks.length; i++) {
        drawBlock(s.blocks[i], s.blocks[i].level);
      }

      // ── the tower fades into the dark at the bottom of the screen ──
      // A scrim rather than per-block transparency, so everything under it stays
      // solid and simply becomes unlit.
      // Starts well down the screen. At 0.60 it was reaching blocks that had only
      // just been placed and dulling them mid-play, which looked like the colours
      // going wrong rather than like distance.
      const scrimTop = height * 0.80;
      const scrim = ctx.createLinearGradient(0, scrimTop, 0, height);
      scrim.addColorStop(0, 'rgba(0,0,0,0)');
      scrim.addColorStop(0.45, 'rgba(0,0,0,0.55)');
      scrim.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, scrimTop, width, height - scrimTop);

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
        ctx.lineWidth = 5;
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
