import { useEffect, useRef } from 'react';
import { playCrTap, playCrDiamond, playCrDeath } from '../utils/sound';

/**
 * ColorRushCanvas — "Color Rush"
 *
 * Tap to fly the ball upward through spinning obstacles. You may only touch the
 * part of an obstacle that matches your current color — going in AND coming
 * out. Color switchers between obstacles change which color you are. White
 * diamonds are worth a point each.
 *
 * Integration matches HighwayCanvas: props { seed, onProgress(score, ms),
 * onDeath(score, ms) }.
 *
 * ── Three properties this file exists to guarantee ───────────────────────────
 *
 * 1. BOTH PLAYERS GET THE IDENTICAL COURSE. Every obstacle's shape, color
 *    order, spin direction and speed is derived by hashing (seed, index) —
 *    NOT by pulling from a sequential PRNG stream. A stream would make the
 *    course depend on how many numbers each client happened to draw and in
 *    what order, so a single extra call on one client silently desynchronises
 *    the two courses and one player is handed an easier climb in a match with
 *    money on it. Hashing the index removes the ordering question entirely.
 *
 * 2. THE VIEW IS THE SAME SIZE EVERYWHERE. The scale comes from the canvas
 *    HEIGHT against a fixed VIEW_H world units, so every device shows exactly
 *    the same vertical slice of the course and therefore the same amount of
 *    warning about what is coming.
 *
 * 3. EVERY OBSTACLE IS PASSABLE. Color is decided by ANGLE, so every loop of
 *    one obstacle presents the same color on the lane whatever its shape — see
 *    colorAtAngle. Colouring by distance round the outline instead, which is
 *    what this did first, made nested shapes disagree and produced obstacles
 *    that could not be entered at all.
 */

// ── World constants (world units; the ball always sits at x = LANE_X) ────────
const WORLD_W  = 400;
const LANE_X   = WORLD_W / 2;
// Enough of the course visible that the NEXT obstacle is on screen while you
// are still working out how to leave this one.
const VIEW_H   = 1200;   // world units visible top-to-bottom, on every device
const BALL_R   = 19;
const THICK    = 21;     // obstacle stroke thickness
// How close the ball's edge has to get to a band to touch it.
const REACH    = BALL_R + THICK / 2;

// Gravity sets the fall speed AND the hop height, so these two move together.
// Lowering gravity on its own to soften the fall would have made the ball hop
// higher again, undoing the shorter hop — JUMP_V comes down with it to keep
// the arc at the same 90 units.
const GRAV     = -1800;  // u/s^2
const JUMP_V   = 570;    // u/s, set (not added) on tap — as the original does
const FALL_MAX = -1400;
// How far one tap lifts you. Everything else is sized against this: it is the
// unit of "room to manoeuvre" in this game.
const TAP_ARC  = (JUMP_V * JUMP_V) / (2 * -GRAV);   // 90u

// The furthest any shape reaches from its own centre.
const SHAPE_REACH = 285;

// Obstacles are up to 570 units tall, and holding position costs a full tap
// arc of bob. The clear space between one obstacle and the next is
// GAP - 2*SHAPE_REACH, and it needs to be comfortably more than one arc or
// there is nowhere to wait and read the spin. A shorter hop only ever buys
// more room here, never less.
const OBSTACLE_GAP = 1050;     // leaves 480u of clear air, ~5.3 tap arcs
const FIRST_Y      = 700;
// The color switcher sits halfway between one obstacle and the next.
const SWITCHER_OFFSET = OBSTACLE_GAP / 2;
const SWITCHER_R      = 22;

// Where the ball sits on screen, as a fraction up from the bottom.
const BALL_SCREEN_FRAC = 0.38;

// Physics runs at a fixed step so a slow frame cannot move the ball further
// than the collision band is wide. At FALL_MAX the ball covers 5.8 units per
// step against a REACH of 29.5, so it can never tunnel through an obstacle. A
// variable step tied to the frame rate would let exactly that happen on a
// stuttering phone — and it would look like a phantom death.
const FIXED_DT = 1 / 240;
// Never simulate more than this per frame. This is also what makes coming back
// from another app safe: the ball resumes where it was instead of teleporting
// through everything it missed.
const MAX_FRAME = 0.25;

// How much faster each obstacle spins than the one below it, and the ceiling
// that keeps the game readable. See the note where they are used.
const SPIN_RAMP = 1.16;
const SPIN_MAX  = 4.5;   // rad/s — a quarter turn every 0.35s

// How long the start screen waits before letting go of the ball.
const START_GRACE = 10;  // seconds
// How long the ball's burst plays before the result card is allowed up.
const DEATH_FX = 1.0;    // seconds

// ── Palette ─────────────────────────────────────────────────────────────────
// Blue, white, green and red. All four are bright enough on black to be read
// at a glance while moving, and far enough apart in hue that no two are
// confusable at speed — misreading a color here costs the match.
const COLORS = [
  { key: 'white', fill: '#FFFFFF' },
  { key: 'blue',  fill: '#2E7BF6' },
  { key: 'green', fill: '#2FD46B' },
  { key: 'red',   fill: '#FF4D5E' },
];
const BG = '#000000';

// ── Deterministic hashing (see note 1 at the top) ───────────────────────────
function hash32(a, b) {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return (h ^ (h >>> 16)) >>> 0;
}
const rnd01 = (seed, i, salt) => hash32(hash32(seed, i), salt) / 4294967296;

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * Which of the four colors sits at local angle `a` on a loop.
 *
 * COLOR IS BY ANGLE, NOT BY DISTANCE ALONG THE PERIMETER. A square's bottom
 * edge is a different fraction of its perimeter than a circle's bottom is of
 * its circumference, so colouring by arc length made the two loops of a
 * "square with a circle inside" present DIFFERENT colors where the ball
 * enters — and the ball has one color, so those obstacles were impossible.
 *
 * `mirror` handles the counter-rotating inner rings. Reflecting the angle
 * about the vertical axis makes the inner ring's pattern travel the opposite
 * way round while still agreeing with the outer ring at the top and bottom of
 * the lane — "spins the other way, but still lines up so you can pass".
 */
function colorAtAngle(a, offset, mirror) {
  const t = mirror ? norm(3 * Math.PI - a) : norm(a);
  return (Math.floor(t / (Math.PI / 2)) + offset) & 3;
}
// The bearing of the first color boundary for a loop at rotation `rotUsed`.
// Boundaries are four bearings spaced a quarter turn apart; mirroring only
// shifts where they start, which is why one expression covers both.
const bandBase = (rotUsed, mirror) => rotUsed + (mirror ? Math.PI : 0);

// ── Shapes ──────────────────────────────────────────────────────────────────
function circleLoop(r, steps = 120) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}
function polyLoop(n, r, rot = Math.PI / 2) {
  // Corners only. The outline is stroked as a real path with mitred joins, so
  // it does not need subdividing — and subdividing was what made the corners
  // look chewed, because each little segment got its own join.
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

const inner = (pts) => ({ pts, spin: -1, mirror: true });
const outer = (pts) => ({ pts, spin: 1, mirror: false });

// The six obstacle families.
//
// Sized so there is real room to move INSIDE. You now have to time your exit
// as well as your entry, so the middle is somewhere you live for a moment
// rather than pass straight through: every shape leaves more than one and a
// half tap arcs of clear air on the lane.
//
// The square's corners sit ON the color boundaries (rot 0, corners at
// 0/90/180/270) rather than between them, which is what makes each side
// exactly one color. The triangle's three corners cannot all land on four
// boundaries, so one of its sides always changes color partway along.
const SHAPES = [
  { name: 'circle',         loops: [outer(circleLoop(205))] },
  { name: 'square',         loops: [outer(polyLoop(4, 235, 0))] },
  { name: 'triangle',       loops: [outer(polyLoop(3, 275))] },
  { name: 'doubleCircle',   loops: [outer(circleLoop(225)), inner(circleLoop(132))] },
  { name: 'squareCircle',   loops: [outer(polyLoop(4, 235, 0)), inner(circleLoop(128))] },
  { name: 'triangleCircle', loops: [outer(polyLoop(3, 285)), inner(circleLoop(118))] },
];

export default function ColorRushCanvas({ seed, onProgress, onDeath }) {
  const canvasRef = useRef(null);
  const cbRef = useRef({ onProgress, onDeath });
  useEffect(() => { cbRef.current = { onProgress, onDeath }; }, [onProgress, onDeath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || seed == null) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let W = 0, H = 0, scale = 1;
    function layout() {
      W = canvas.clientWidth || 360;
      H = canvas.clientHeight || 640;
      canvas.width  = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      scale = H / VIEW_H;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    layout();
    // A ResizeObserver on the canvas ITSELF, not a window resize listener. The
    // page's <main> animates its edges when the chat sidebar opens, and the
    // sidebars mount after the first paint — none of which fires a window
    // resize, so a listener-only canvas keeps a stale width all match.
    const ro = new ResizeObserver(() => layout());
    ro.observe(canvas);
    const onResize = () => layout();
    window.addEventListener('orientationchange', onResize);

    // ── Obstacle generation (index-hashed — see note 1) ─────────────────────
    const obstacles = new Map();
    function obstacleAt(i) {
      let o = obstacles.get(i);
      if (o) return o;
      const shape = SHAPES[Math.floor(rnd01(seed, i, 1) * SHAPES.length) % SHAPES.length];
      const dotted = rnd01(seed, i, 2) < 0.34;
      const dir    = rnd01(seed, i, 3) < 0.5 ? -1 : 1;
      // Each obstacle spins SPIN_RAMP times faster than the one below it, so the
      // climb gets harder the further you get.
      //
      // The cap is not decoration. A quarter turn is what a color is present
      // for, so the window to enter or leave is (pi/2)/omega seconds: at the
      // cap that is 0.35s, which is about the floor for seeing a color arrive
      // and acting on it. Compounding reaches the cap around obstacle 11 and
      // would be at 0.1s by obstacle 20 — past that the game stops rewarding
      // reading the spin and starts paying out on luck, which is not something
      // to put money on. The jitter is applied BEFORE the clamp so it cannot
      // push a single obstacle past the floor.
      const speed  = Math.min(
        0.85 * Math.pow(SPIN_RAMP, i) * (0.9 + rnd01(seed, i, 4) * 0.25),
        SPIN_MAX);
      const offset = Math.floor(rnd01(seed, i, 5) * 4);
      o = {
        i, y: FIRST_Y + i * OBSTACLE_GAP,
        shape, dotted, omega: dir * speed, offset,
        phase: rnd01(seed, i, 6) * TAU,
        diamond: true,
        switcher: true,
        switcherY: FIRST_Y + i * OBSTACLE_GAP + SWITCHER_OFFSET,
        switcherTo: Math.floor(rnd01(seed, i, 7) * 3),
      };
      obstacles.set(i, o);
      return o;
    }
    const angleOf = (o, t) => o.phase + o.omega * t;

    // ── State ───────────────────────────────────────────────────────────────
    const S = {
      y: 0, vy: 0,
      color: 0,
      camBottom: -VIEW_H * BALL_SCREEN_FRAC,
      simT: 0, score: 0, dead: false,
      started: false,
      waitT: 0,
      pulse: 0,
      deathT: 0,
      bits: [], burstY: 0,
    };

    // ── Input ───────────────────────────────────────────────────────────────
    function tap() {
      if (S.dead) return;
      S.started = true;
      S.vy = JUMP_V;
      playCrTap();
    }
    const onPointer = (e) => { e.preventDefault(); tap(); };
    const onKey = (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.key === ' ') { e.preventDefault(); tap(); }
    };
    // A long press or a fast double tap on a phone raises the selection and
    // copy/paste callout over the game. Nothing here is text, so every one of
    // these is noise that steals a tap mid-run.
    const swallow = (e) => { e.preventDefault(); return false; };
    canvas.addEventListener('pointerdown', onPointer, { passive: false });
    canvas.addEventListener('contextmenu', swallow);
    canvas.addEventListener('selectstart', swallow);
    canvas.addEventListener('dragstart', swallow);
    canvas.addEventListener('touchstart', swallow, { passive: false });
    canvas.addEventListener('touchmove', swallow, { passive: false });
    canvas.addEventListener('touchend', swallow, { passive: false });
    canvas.addEventListener('dblclick', swallow);
    window.addEventListener('keydown', onKey);

    // ── Geometry ────────────────────────────────────────────────────────────
    function nearestOnLoop(pts, px, py) {
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ax = a[0], ay = a[1];
        const dx = b[0] - ax, dy = b[1] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestD) bestD = d;
      }
      return bestD;
    }

    // ── Collision ───────────────────────────────────────────────────────────
    // EVERY contact is checked, going in and coming out. The obstacles are
    // sized so the middle is somewhere you can hold station, which is what
    // makes the exit a decision rather than a dice roll: you wait inside for
    // your color to come round to the top, then leave.
    //
    // The color that counts is the one on the LANE — the bearing of the ball
    // from the obstacle's centre — not the bearing of whichever bit of outline
    // happens to be nearest. They differ on polygons: a corner swinging
    // sideways can be the closest point while the ball is still crossing the
    // lane, and that corner may be a different quarter, which would let the
    // outer and inner loops disagree and make the obstacle impossible.
    function hitTest() {
      const span = SHAPE_REACH + REACH + 10;
      const first = Math.max(0, Math.floor((S.y - FIRST_Y - span) / OBSTACLE_GAP));
      const last  = Math.floor((S.y - FIRST_Y + span) / OBSTACLE_GAP);
      for (let i = first; i <= last; i++) {
        if (i < 0) continue;
        const o = obstacleAt(i);
        const dy = S.y - o.y;
        if (Math.abs(dy) > span) continue;
        const th = angleOf(o, S.simT);
        for (const loop of o.shape.loops) {
          const a = th * loop.spin;
          const cos = Math.cos(-a), sin = Math.sin(-a);
          const rx = -dy * sin;
          const ry =  dy * cos;
          if (nearestOnLoop(loop.pts, rx, ry) < REACH) {
            const laneBearing = (dy >= 0 ? Math.PI / 2 : -Math.PI / 2) - a;
            if (colorAtAngle(laneBearing, o.offset, loop.mirror) !== S.color) return true;
          }
        }
      }
      return false;
    }

    function pickups() {
      const i = Math.round((S.y - FIRST_Y) / OBSTACLE_GAP);
      for (const j of [i - 1, i, i + 1]) {
        if (j < 0) continue;
        const o = obstacleAt(j);
        if (o.diamond && Math.abs(S.y - o.y) < BALL_R + 22) {
          o.diamond = false; S.score += 1; S.pulse = 1;
          playCrDiamond();
        }
        if (o.switcher && Math.abs(S.y - o.switcherY) < BALL_R + SWITCHER_R) {
          o.switcher = false;
          // Always a DIFFERENT color — one that can hand back the color you
          // already hold sometimes does nothing, which reads as a bug.
          const others = [0, 1, 2, 3].filter(c => c !== S.color);
          S.color = others[o.switcherTo % others.length];
          S.pulse = 1;
        }
      }
    }

    // ── Simulation ──────────────────────────────────────────────────────────
    function step(dt) {
      if (S.dead) { S.deathT += dt; return; }
      if (!S.started) {
        // The start screen is a grace period, not a pause: it runs out.
        S.waitT += dt;
        if (S.waitT >= START_GRACE) S.started = true;
        return;
      }
      S.simT += dt;
      S.vy += GRAV * dt;
      if (S.vy < FALL_MAX) S.vy = FALL_MAX;
      S.y += S.vy * dt;

      const target = S.y - VIEW_H * BALL_SCREEN_FRAC;
      if (target > S.camBottom) S.camBottom = target;   // camera never drops

      pickups();
      if (S.y < S.camBottom - BALL_R * 2) return die();
      if (hitTest()) return die();
    }

    function die() {
      if (S.dead) return;
      S.dead = true;
      S.deathT = 0;
      // Burst the ball into pieces. Seeded off nothing in particular — this is
      // pure decoration and never touches the outcome, which the server has
      // already been told about on the line below.
      S.bits = [];
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU + Math.random() * 0.35;
        const sp = 120 + Math.random() * 190;
        S.bits.push({ x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                      r: 6 + Math.random() * 6 });
      }
      // Where the burst is drawn from. The ball itself can be BELOW the frame
      // when it dies — falling out of the bottom is one of the two ways to go —
      // and drawing the pieces at its real position put the whole animation off
      // screen, so the death simply had no animation at all.
      S.burstY = Math.max(S.y, S.camBottom + VIEW_H * 0.12);
      playCrDeath();
      cbRef.current.onDeath?.(Math.floor(S.score), Math.floor(S.simT * 1000));
    }

    function stepBits(dt) {
      for (const b of S.bits) {
        b.vy += GRAV * 0.55 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }
    }

    // ── Drawing ─────────────────────────────────────────────────────────────
    const sx = (wx) => W / 2 + (wx - LANE_X) * scale;
    const sy = (wy) => H - (wy - S.camBottom) * scale;

    /**
     * Draw one loop as four color bands.
     *
     * The whole outline is stroked FOUR TIMES, once per color, each time
     * clipped to that color's quarter of the circle. That is what makes the
     * joins clean: the stroke is one continuous path with proper mitred
     * corners, and the clip cuts it along an exact radius.
     *
     * The previous approach cut the outline into four separate paths and
     * stroked each one. Every cut then had its own end cap, so at a corner the
     * two bands met at an angle and left a notch or sat on top of each other —
     * the sloppy, overlapping joins in the bug report. There is nothing to
     * misalign here, because nothing is ever cut.
     */
    function drawLoop(loop, cx, cy, rotUsed, offset, dotted) {
      const pts = loop.pts;
      const cos = Math.cos(rotUsed), sin = Math.sin(rotUsed);
      const toX = (p) => cx + (p[0] * cos - p[1] * sin) * scale;
      const toY = (p) => cy - (p[0] * sin + p[1] * cos) * scale;

      if (dotted) {
        // Dotted is a LOOK, not a gap: collision is unchanged, so a dotted
        // obstacle is exactly as solid as it appears. Real gaps would kill
        // players on something that looked like empty space.
        const r = THICK * 0.5 * scale;
        const N = 64;
        for (let k = 0; k < N; k++) {
          // Walk the outline at even steps around the ring of corners.
          const t = (k / N) * pts.length;
          const i0 = Math.floor(t) % pts.length, i1 = (i0 + 1) % pts.length;
          const f = t - Math.floor(t);
          const p = [pts[i0][0] + (pts[i1][0] - pts[i0][0]) * f,
                     pts[i0][1] + (pts[i1][1] - pts[i0][1]) * f];
          const col = COLORS[colorAtAngle(Math.atan2(p[1], p[0]), offset, loop.mirror)];
          ctx.beginPath();
          ctx.arc(toX(p), toY(p), r, 0, TAU);
          ctx.fillStyle = col.fill;
          ctx.fill();
        }
        return;
      }

      const clipR = (SHAPE_REACH + 60) * scale;
      const base  = bandBase(rotUsed, loop.mirror);
      ctx.lineWidth = THICK * scale;
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 4;
      ctx.lineCap = 'butt';
      for (let q = 0; q < 4; q++) {
        const b0 = base + q * (Math.PI / 2);
        const b1 = b0 + Math.PI / 2;
        const mid = b0 + Math.PI / 4;
        const col = COLORS[colorAtAngle(mid - rotUsed, offset, loop.mirror)];
        ctx.save();
        // Wedge, in canvas angles — screen y runs down, so bearings negate.
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, clipR, -b1, -b0);
        ctx.closePath();
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(toX(pts[0]), toY(pts[0]));
        for (let k = 1; k < pts.length; k++) ctx.lineTo(toX(pts[k]), toY(pts[k]));
        ctx.closePath();
        ctx.strokeStyle = col.fill;
        ctx.stroke();
        ctx.restore();
      }
    }

    function drawDiamond(x, y, r) {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.7, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.7, y);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(255,255,255,0.6)';
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    function drawSwitcher(x, y, r, t) {
      for (let q = 0; q < 4; q++) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, r, t + (q / 4) * TAU, t + ((q + 1) / 4) * TAU);
        ctx.closePath();
        ctx.fillStyle = COLORS[q].fill;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    function drawBall() {
      const x = sx(LANE_X), y = sy(S.y), r = BALL_R * scale;
      const col = COLORS[S.color];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = col.fill;
      ctx.shadowColor = col.fill;
      ctx.shadowBlur = 16 + S.pulse * 22;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // The burst is the ball coming apart, so it is the ball's color.
    //
    // It was already reading S.color, and it was already drawing in that color —
    // but the pieces were 2-5px under a 10px glow, and a small dot with that
    // much bloom on a black background reads as white however saturated the
    // fill is. Bigger pieces and much less blur is what makes the color
    // actually legible; the ring is there so the color registers in the first
    // frame, before anything has had time to spread out and fade.
    function drawBits() {
      const t    = Math.min(1, S.deathT / DEATH_FX);
      const fade = 1 - t * t;                       // holds up, then drops away
      const x0 = sx(LANE_X), y0 = sy(S.burstY);
      const col = COLORS[S.color];

      ctx.globalAlpha = Math.max(0, 1 - t) * 0.55;
      ctx.strokeStyle = col.fill;
      ctx.lineWidth = Math.max(2, 5 * (1 - t)) * scale * 1.6;
      ctx.beginPath();
      ctx.arc(x0, y0, (BALL_R + t * 150) * scale, 0, TAU);
      ctx.stroke();

      ctx.globalAlpha = Math.max(0, fade);
      ctx.fillStyle = col.fill;
      ctx.shadowColor = col.fill;
      ctx.shadowBlur = 4;
      for (const b of S.bits) {
        ctx.beginPath();
        ctx.arc(x0 + b.x * scale, y0 - b.y * scale, b.r * scale * (0.55 + fade * 0.45), 0, TAU);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    function render() {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      const topY = S.camBottom + VIEW_H;
      const span = SHAPE_REACH + 60;
      const first = Math.max(0, Math.floor((S.camBottom - FIRST_Y - span) / OBSTACLE_GAP));
      const last  = Math.floor((topY - FIRST_Y + span) / OBSTACLE_GAP);
      for (let i = first; i <= last; i++) {
        if (i < 0) continue;
        const o = obstacleAt(i);
        const cx = sx(LANE_X), cy = sy(o.y);
        const th = angleOf(o, S.simT);
        for (const loop of o.shape.loops) {
          drawLoop(loop, cx, cy, th * loop.spin, o.offset, o.dotted);
        }
        if (o.diamond)  drawDiamond(cx, cy, 20 * scale);
        if (o.switcher) drawSwitcher(sx(LANE_X), sy(o.switcherY), SWITCHER_R * scale, S.simT * 0.9);
      }

      if (S.dead) drawBits(); else drawBall();
      drawHUD();

      if (!S.started) {
        ctx.fillStyle = 'rgba(0,0,0,0.58)';
        ctx.fillRect(0, 0, W, H);
        const left = Math.max(0, Math.ceil(START_GRACE - S.waitT));
        ctx.textAlign = 'center';
        ctx.fillStyle = left <= 3 ? '#FF4D4D' : '#FFFFFF';
        ctx.font = `900 ${Math.round(Math.min(W, H) * 0.13)}px system-ui, sans-serif`;
        ctx.fillText(String(left), W / 2, H * 0.40);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `900 ${Math.round(Math.min(W, H) * 0.075)}px system-ui, sans-serif`;
        ctx.fillText('TAP TO START', W / 2, H * 0.49);
        ctx.font = `600 ${Math.round(Math.min(W, H) * 0.036)}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText('Match the color to get in and out', W / 2, H * 0.545);
        ctx.textAlign = 'left';
      }
    }

    function drawHUD() {
      // Score only, top right. There is no clock: the match is decided on
      // diamonds, so a running timer was reporting a number that does not
      // count for anything. The catch-up banner owns the top centre and the
      // help button the bottom left, so nothing collides.
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `900 ${Math.round(H * 0.055)}px system-ui, sans-serif`;
      ctx.fillText(String(S.score), W - 16, H * 0.085);
      ctx.shadowBlur = 0;
      ctx.textAlign = 'left';
    }

    // ── Loop ────────────────────────────────────────────────────────────────
    let raf = 0, last = performance.now(), acc = 0, pingT = 0;
    function loop(now) {
      let frame = (now - last) / 1000;
      last = now;
      if (frame > MAX_FRAME) frame = MAX_FRAME;
      acc += frame;
      while (acc >= FIXED_DT) { step(FIXED_DT); acc -= FIXED_DT; }
      if (S.dead) stepBits(frame);

      // Ping even before the first tap. The server's stall watchdog finalises a
      // player who goes quiet, and someone still on the start screen is not a
      // stalled client.
      pingT += frame;
      if (!S.dead && pingT > 0.35) {
        pingT = 0;
        cbRef.current.onProgress?.(Math.floor(S.score), Math.floor(S.simT * 1000));
      }
      if (S.pulse > 0) S.pulse = Math.max(0, S.pulse - frame * 3);
      render();
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerdown', onPointer);
      canvas.removeEventListener('contextmenu', swallow);
      canvas.removeEventListener('selectstart', swallow);
      canvas.removeEventListener('dragstart', swallow);
      canvas.removeEventListener('touchstart', swallow);
      canvas.removeEventListener('touchmove', swallow);
      canvas.removeEventListener('touchend', swallow);
      canvas.removeEventListener('dblclick', swallow);
    };
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="relative w-full bg-bg flex justify-center overflow-hidden select-none"
      style={{
        height: 'calc(100dvh - 56px)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        className="relative h-full block touch-none select-none w-full"
        style={{
          cursor: 'pointer',
          maxWidth: 'calc((100dvh - 56px) * 0.62)',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
      />
    </div>
  );
}
