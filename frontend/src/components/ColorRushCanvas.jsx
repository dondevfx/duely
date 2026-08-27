import { useEffect, useRef } from 'react';

/**
 * ColorRushCanvas — "Color Rush"
 *
 * Tap to fly the ball upward through spinning obstacles. You may only pass
 * through the part of an obstacle that matches your current color; touching
 * any other color ends the run. Color switchers between obstacles change which
 * color you are. White diamonds are worth a point each.
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
 * 3. EVERY OBSTACLE IS PASSABLE. See the note on colorAtAngle below — this was
 *    not true in the first version and produced obstacles that could not be
 *    entered at all.
 */

// ── World constants (world units; the ball always sits at x = LANE_X) ────────
const WORLD_W  = 400;
const LANE_X   = WORLD_W / 2;
// Enough of the course visible that the NEXT obstacle is on screen while you
// are still timing the current one.
const VIEW_H   = 1150;   // world units visible top-to-bottom, on every device
const BALL_R   = 19;
const THICK    = 18;     // obstacle stroke thickness
// How close the ball's edge has to get to a band to touch it.
const REACH    = BALL_R + THICK / 2;

const GRAV     = -2000;  // u/s^2
const JUMP_V   = 700;    // u/s, set (not added) on tap — as the original does
const FALL_MAX = -1600;
// How far one tap lifts you. Everything else is sized against this: it is the
// unit of "room to manoeuvre" in this game.
const TAP_ARC  = (JUMP_V * JUMP_V) / (2 * -GRAV);   // 122.5u

// The furthest any shape reaches from its own centre. Used to size the gap
// between obstacles and to decide what is in range for a hit test.
const SHAPE_REACH = 250;

// Obstacles are up to 500 units tall, and holding position costs a full tap
// arc of bob. The clear space between one obstacle and the next is
// GAP - 2*SHAPE_REACH, and it needs to be comfortably more than one arc or
// there is nowhere to wait and read the spin.
const OBSTACLE_GAP = 850;      // leaves 350u of clear air, ~2.9 tap arcs
const FIRST_Y      = 620;
// The color switcher sits halfway between one obstacle and the next.
const SWITCHER_OFFSET = OBSTACLE_GAP / 2;

// Where the ball sits on screen, as a fraction up from the bottom.
const BALL_SCREEN_FRAC = 0.38;

// Physics runs at a fixed step so a slow frame cannot move the ball further
// than the collision band is wide. At FALL_MAX the ball covers 6.7 units per
// step against a REACH of 28, so it can never tunnel through an obstacle. A
// variable step tied to the frame rate would let exactly that happen on a
// stuttering phone — and it would look like a phantom death.
const FIXED_DT = 1 / 240;
const MAX_FRAME = 0.25;  // never simulate more than this per frame

// How long the start screen waits before letting go of the ball.
const START_GRACE = 10;  // seconds

// ── Palette ─────────────────────────────────────────────────────────────────
// White, blue, grey and black, to match the site. The blue is a brighter
// sibling of the site primary (#1250B4): the real primary is legible as a
// button on a dark surface but too dark to read reliably as a fast-moving
// band on pure black, and misreading a color here costs the match.
//
// Black is a playable color on a black background, so it is never drawn as
// bare fill — it always carries a light rim. Without that rim a black band is
// invisible and the run ends on something the player could not see.
const COLORS = [
  { key: 'white', fill: '#FFFFFF', rim: null },
  { key: 'blue',  fill: '#2E6FE0', rim: null },
  { key: 'grey',  fill: '#8B95A7', rim: null },
  { key: 'black', fill: '#0A0A0A', rim: '#5C6577' },
];
const BG = '#000000';

// ── Deterministic hashing (see note 1 at the top) ───────────────────────────
function hash32(a, b) {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return (h ^ (h >>> 16)) >>> 0;
}
// A stable 0..1 for (seed, index, salt) — salt separates the independent
// choices made about one obstacle so they don't correlate.
const rnd01 = (seed, i, salt) => hash32(hash32(seed, i), salt) / 4294967296;

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * Which of the four colors sits at local angle `a` on a loop.
 *
 * COLOR IS BY ANGLE, NOT BY DISTANCE ALONG THE PERIMETER. That distinction is
 * the whole of bug #3 in the header, and it is worth spelling out.
 *
 * Colouring by arc length seems natural — walk the outline, change color every
 * quarter of the way round. But a square's bottom edge is a different fraction
 * of its perimeter than a circle's bottom is of its circumference. So on a
 * "square with a circle inside", the two loops presented DIFFERENT colors at
 * the point where the ball enters, and since the ball has one color it could
 * not satisfy both. Those obstacles were literally impossible.
 *
 * By angle, every loop of an obstacle presents the same color at the same
 * bearing from the centre, whatever its shape. The ball enters from straight
 * below, so every loop shows it the same color and one correct read clears the
 * whole obstacle.
 *
 * `mirror` handles the counter-rotating inner rings. Reflecting the angle
 * about the vertical axis (a -> 3π - a) makes the inner ring's pattern travel
 * the opposite way round while still agreeing with the outer ring at the top
 * and bottom of the lane — which is exactly "spins the other way, but still
 * lines up so you can pass through".
 */
function colorAtAngle(a, offset, mirror) {
  const t = mirror ? norm(3 * Math.PI - a) : norm(a);
  return (Math.floor(t / (Math.PI / 2)) + offset) & 3;
}

// ── Shapes ──────────────────────────────────────────────────────────────────
// Every obstacle is one or more closed loops, given as points in the shape's
// own space. Nested loops carry spin:-1 and mirror:true so they turn against
// the outer loop while still lining up with it on the lane.
function circleLoop(r, steps = 96) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}
function polyLoop(n, r, rot = Math.PI / 2, perSide = 24) {
  const corners = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    corners.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const pts = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % n];
    for (let k = 0; k < perSide; k++) {
      const t = k / perSide;
      pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  return pts;
}

const inner = (pts) => ({ pts, spin: -1, mirror: true });
const outer = (pts) => ({ pts, spin: 1, mirror: false });

// The six obstacle families. Sizes leave a visible gap between nested loops
// (overlapping outlines read as a rendering fault) and leave more than one tap
// arc of clear space inside the innermost loop, so there is somewhere to hold
// station rather than being funnelled straight through.
//
// The square's corners sit ON the color boundaries (rot 0, so corners at
// 0/90/180/270) rather than between them. Boundaries fall every 90 degrees of
// bearing, so this is what makes each side exactly one color instead of each
// side being split down the middle — the same reason the triangle, whose three
// corners cannot all land on four boundaries, always has one side that
// changes color partway along.
const SHAPES = [
  { name: 'circle',         loops: [outer(circleLoop(175))] },
  { name: 'square',         loops: [outer(polyLoop(4, 205, 0))] },
  { name: 'triangle',       loops: [outer(polyLoop(3, 250))] },
  { name: 'doubleCircle',   loops: [outer(circleLoop(190)), inner(circleLoop(108))] },
  { name: 'squareCircle',   loops: [outer(polyLoop(4, 205, 0)), inner(circleLoop(100))] },
  { name: 'triangleCircle', loops: [outer(polyLoop(3, 250)), inner(circleLoop(100))] },
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
      // Height-driven, so the visible slice of course is identical everywhere.
      scale = H / VIEW_H;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    layout();
    // A ResizeObserver on the canvas ITSELF, not a window resize listener. The
    // page's <main> animates its left and right edges over 300ms whenever the
    // chat sidebar opens or closes, and the sidebars mount after the first
    // paint. None of that fires a window resize event, so a listener-only
    // canvas keeps a stale width for the whole match.
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
      // Spin speed ramps with height, capped so the game stays readable rather
      // than becoming a coin toss at obstacle forty.
      const speed  = Math.min(1.0 + i * 0.02, 2.0) * (0.9 + rnd01(seed, i, 4) * 0.25);
      const offset = Math.floor(rnd01(seed, i, 5) * 4);
      o = {
        i, y: FIRST_Y + i * OBSTACLE_GAP,
        shape, dotted, omega: dir * speed, offset,
        phase: rnd01(seed, i, 6) * TAU,
        diamond: true,
        // Switcher sits halfway between this obstacle and the next.
        switcher: true,
        switcherY: FIRST_Y + i * OBSTACLE_GAP + SWITCHER_OFFSET,
        switcherTo: Math.floor(rnd01(seed, i, 7) * 3), // index into "the other three"
        cleared: null,
      };
      obstacles.set(i, o);
      return o;
    }
    const angleOf = (o, t) => o.phase + o.omega * t;

    // ── State ───────────────────────────────────────────────────────────────
    const S = {
      y: 0, vy: 0,
      color: 0,             // index into COLORS — starts white
      camBottom: -VIEW_H * BALL_SCREEN_FRAC,
      simT: 0, score: 0, dead: false,
      started: false,       // the run holds still until the first tap
      waitT: 0,             // how long the start screen has been up
      pulse: 0,
    };

    // ── Input ───────────────────────────────────────────────────────────────
    function tap() {
      if (S.dead) return;
      S.started = true;
      S.vy = JUMP_V;
    }
    const onPointer = (e) => { e.preventDefault(); tap(); };
    const onKey = (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.key === ' ') { e.preventDefault(); tap(); }
    };
    const noSel = (e) => e.preventDefault();
    canvas.addEventListener('pointerdown', onPointer, { passive: false });
    canvas.addEventListener('contextmenu', noSel);
    canvas.addEventListener('selectstart', noSel);
    window.addEventListener('keydown', onKey);

    // ── Geometry helpers ────────────────────────────────────────────────────
    // Nearest point on a loop to a point, in the loop's own space. Returns the
    // distance and the ANGLE of the closest point, which is what decides the
    // color. One routine for every shape.
    function nearestOnLoop(pts, px, py) {
      let bestD = Infinity, bx = 0, by = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ax = a[0], ay = a[1];
        const dx = b[0] - ax, dy = b[1] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestD) { bestD = d; bx = cx; by = cy; }
      }
      return { d: bestD, a: Math.atan2(by, bx) };
    }

    // The point on p1→p2 where the color stops being `col`, to within a
    // millionth of the segment. Used to end each color band exactly on its
    // boundary, so consecutive bands share an endpoint instead of overlapping
    // or leaving a notch.
    function bisectBoundary(p1, p2, col, colAt) {
      let lo = 0, hi = 1;
      const at = (t) => [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (colAt(at(mid)) === col) lo = mid; else hi = mid;
      }
      return at((lo + hi) / 2);
    }

    // ── Collision ───────────────────────────────────────────────────────────
    // A band kills on the FIRST contact of a pass, and only if the colors
    // differ. Match it and that band is cleared for the rest of the pass.
    //
    // This rule is the whole game, so it is worth saying why it is not "every
    // contact is checked". A ring crossed through its middle is touched twice —
    // once entering at the bottom, once leaving at the top — and those two
    // points sit opposite each other on the loop, which with four quarters
    // means they are NEVER the same color at the same instant. Checking both
    // would make every ring impossible except when the spin happened to carry
    // your color half a turn during the crossing, which is not something a
    // player can read or control: it would be luck wearing the costume of
    // skill. Timing the entry IS readable, so that is what the game asks for.
    function hitTest() {
      const span = SHAPE_REACH + REACH + 10;
      const first = Math.max(0, Math.floor((S.y - FIRST_Y - span) / OBSTACLE_GAP));
      const last  = Math.floor((S.y - FIRST_Y + span) / OBSTACLE_GAP);
      for (let i = first; i <= last; i++) {
        if (i < 0) continue;
        const o = obstacleAt(i);
        const dy = S.y - o.y;
        // Out of reach: forget any clearing, so an obstacle approached again
        // (after a fall) has to be entered honestly a second time.
        if (Math.abs(dy) > span) { o.cleared = null; continue; }
        if (!o.cleared) o.cleared = o.shape.loops.map(() => false);
        const th = angleOf(o, S.simT);
        for (let li = 0; li < o.shape.loops.length; li++) {
          if (o.cleared[li]) continue;
          const loop = o.shape.loops[li];
          const a = th * loop.spin;
          // Ball position in this loop's rotating frame.
          const cos = Math.cos(-a), sin = Math.sin(-a);
          const rx = -dy * sin;
          const ry =  dy * cos;
          const near = nearestOnLoop(loop.pts, rx, ry);
          if (near.d < REACH) {
            // The color that counts is the one on the LANE — the bearing of
            // the ball from this obstacle's centre — not the bearing of
            // whichever bit of outline happens to be nearest.
            //
            // They differ on polygons: a corner swinging sideways can be the
            // closest point while the ball is still crossing the lane, and
            // that corner may be a different quarter. Judging by the nearest
            // point therefore let the outer and inner loops disagree, which is
            // an obstacle nobody can enter. Judging by the lane bearing makes
            // every loop of an obstacle agree exactly — see colorAtAngle.
            const laneBearing = (dy >= 0 ? Math.PI / 2 : -Math.PI / 2) - a;
            if (colorAtAngle(laneBearing, o.offset, loop.mirror) !== S.color) return true;
            o.cleared[li] = true;
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
        if (o.diamond && Math.abs(S.y - o.y) < BALL_R + 20) {
          o.diamond = false; S.score += 1; S.pulse = 1;
        }
        if (o.switcher && Math.abs(S.y - o.switcherY) < BALL_R + 18) {
          o.switcher = false;
          // Always a DIFFERENT color — a switcher that can hand back the color
          // you already have is a switcher that sometimes does nothing, which
          // reads as a bug rather than as luck.
          const others = [0, 1, 2, 3].filter(c => c !== S.color);
          S.color = others[o.switcherTo % others.length];
          S.pulse = 1;
        }
      }
    }

    // ── Simulation ──────────────────────────────────────────────────────────
    function step(dt) {
      if (S.dead) return;
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
      // Falling out of the bottom of the frame ends the run — otherwise a
      // player who misses everything simply floats.
      if (S.y < S.camBottom - BALL_R * 2) return die();
      if (hitTest()) return die();
    }

    function die() {
      if (S.dead) return;
      S.dead = true;
      cbRef.current.onDeath?.(Math.floor(S.score), Math.floor(S.simT * 1000));
    }

    // ── Drawing ─────────────────────────────────────────────────────────────
    const sx = (wx) => W / 2 + (wx - LANE_X) * scale;
    const sy = (wy) => H - (wy - S.camBottom) * scale;

    // Draws one loop as four color bands.
    //
    // The bands are built by walking the outline and cutting it exactly where
    // the color changes, so neighbouring bands share an endpoint. Cutting only
    // at whichever vertex happened to be nearest — which is what the first
    // version did — leaves each join a little short or a little long, and the
    // result is the ragged, overlapping outline in the bug report.
    function drawLoop(loop, cx, cy, ang, offset, dotted) {
      const pts = loop.pts;
      const n = pts.length;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const toX = (p) => cx + (p[0] * cos - p[1] * sin) * scale;
      const toY = (p) => cy - (p[0] * sin + p[1] * cos) * scale;
      const colAt = (p) => colorAtAngle(Math.atan2(p[1], p[0]), offset, loop.mirror);

      if (dotted) {
        // Dotted is a LOOK, not a gap: collision is unchanged, so a dotted
        // obstacle is exactly as solid as it appears to be. Making the gaps
        // real would kill players on something that looked like empty space.
        const r = THICK * 0.5 * scale;
        const stepN = Math.max(16, Math.round(n / 3));
        for (let k = 0; k < stepN; k++) {
          const p = pts[Math.round((k / stepN) * n) % n];
          const col = COLORS[colAt(p)];
          const X = toX(p), Y = toY(p);
          if (col.rim) {
            ctx.beginPath(); ctx.arc(X, Y, r + 2.5, 0, TAU);
            ctx.fillStyle = col.rim; ctx.fill();
          }
          ctx.beginPath(); ctx.arc(X, Y, r, 0, TAU);
          ctx.fillStyle = col.fill; ctx.fill();
        }
        return;
      }

      // Build the four bands as exact point runs.
      const bands = [];
      let run = [pts[0]];
      let runCol = colAt(pts[0]);
      for (let k = 1; k <= n; k++) {
        const p = pts[k % n];
        const c = colAt(p);
        if (c !== runCol) {
          // Cut exactly where the color changes, found by bisecting the
          // segment. Solving for the boundary bearing algebraically means
          // handling the mirror and the 2π wrap, and getting either subtly
          // wrong puts the seam in the wrong place — which is the class of bug
          // this whole routine exists to fix. Twenty halvings on four segments
          // per loop is free, and it cannot be wrong.
          const prev = pts[(k - 1) % n];
          const cut = bisectBoundary(prev, p, runCol, colAt);
          run.push(cut);
          bands.push({ col: runCol, run });
          run = [cut, p];
          runCol = c;
        } else {
          run.push(p);
        }
      }
      bands.push({ col: runCol, run });
      // The walk starts mid-band, so the first and last runs are two halves of
      // the same band — joining them keeps that band unbroken.
      if (bands.length > 1 && bands[0].col === bands[bands.length - 1].col) {
        const tail = bands.pop();
        bands[0].run = tail.run.concat(bands[0].run);
      }

      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      for (const { col, run: r } of bands) {
        if (r.length < 2) continue;
        const c = COLORS[col];
        ctx.beginPath();
        ctx.moveTo(toX(r[0]), toY(r[0]));
        for (let k = 1; k < r.length; k++) ctx.lineTo(toX(r[k]), toY(r[k]));
        // Black is a playable color on a black background, so it is drawn as a
        // light rim with black laid over it — an outlined band rather than a
        // hole in the screen.
        if (c.rim) {
          ctx.lineWidth = THICK * scale + 5;
          ctx.strokeStyle = c.rim;
          ctx.stroke();
        }
        ctx.lineWidth = THICK * scale;
        ctx.strokeStyle = c.fill;
        ctx.stroke();
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
      ctx.shadowColor = col.rim ? 'rgba(200,210,230,0.55)' : col.fill;
      ctx.shadowBlur = 16 + S.pulse * 22;
      ctx.fill();
      ctx.shadowBlur = 0;
      // The black ball always carries a rim. Without it the thing the player is
      // steering disappears against the background.
      ctx.lineWidth = col.rim ? 3 : 1.5;
      ctx.strokeStyle = col.rim || 'rgba(0,0,0,0.35)';
      ctx.stroke();
    }

    function render() {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      const topY = S.camBottom + VIEW_H;
      const span = SHAPE_REACH + 40;
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
        if (o.switcher) drawSwitcher(sx(LANE_X), sy(o.switcherY), 18 * scale, S.simT * 0.9);
      }

      if (!S.dead) drawBall();
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
        ctx.fillText('Pass through your own color', W / 2, H * 0.545);
        ctx.textAlign = 'left';
      }
    }

    function drawHUD() {
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
      // Score top-LEFT, timer top-right. The catch-up banner takes the top
      // centre and the help button the bottom left, so nothing collides.
      ctx.textAlign = 'left';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `900 ${Math.round(H * 0.055)}px system-ui, sans-serif`;
      ctx.fillText(String(S.score), 16, H * 0.085);
      ctx.textAlign = 'right';
      ctx.font = `700 ${Math.round(H * 0.030)}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(S.simT.toFixed(1) + 's', W - 14, H * 0.055);
      ctx.shadowBlur = 0;
      ctx.textAlign = 'left';
    }

    // ── Loop ────────────────────────────────────────────────────────────────
    let raf = 0, last = performance.now(), acc = 0, pingT = 0;
    function loop(now) {
      let frame = (now - last) / 1000;
      last = now;
      if (frame > MAX_FRAME) frame = MAX_FRAME;   // a backgrounded tab must not teleport the ball
      acc += frame;
      while (acc >= FIXED_DT) { step(FIXED_DT); acc -= FIXED_DT; }

      // Ping even before the first tap. The server's stall watchdog finalises a
      // player who goes quiet for 15 seconds, and someone reading the help
      // panel on the start screen is not a stalled client.
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
      canvas.removeEventListener('contextmenu', noSel);
      canvas.removeEventListener('selectstart', noSel);
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
        // Capped so a wide screen does not shrink the course: the scale comes
        // from the height, and a very wide canvas would leave the obstacles
        // marooned in the middle of a mostly empty frame.
        style={{ cursor: 'pointer', maxWidth: 'calc((100dvh - 56px) * 0.62)' }}
      />
    </div>
  );
}
