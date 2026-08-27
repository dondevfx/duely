import { useEffect, useRef } from 'react';

/**
 * ColorRushCanvas — "Color Rush"
 *
 * Tap to fly the ball upward through spinning obstacles. You may only pass
 * through the part of an obstacle that matches your current colour; touching
 * any other colour ends the run. Colour switchers between obstacles change
 * which colour you are. White diamonds are worth a point each.
 *
 * Integration matches HighwayCanvas: props { seed, onProgress(score, ms),
 * onDeath(score, ms) }.
 *
 * ── Two properties this file exists to guarantee ─────────────────────────────
 *
 * 1. BOTH PLAYERS GET THE IDENTICAL COURSE. Every obstacle's shape, colour
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
 *    warning about what is coming. Scaling to width instead would give a
 *    tablet more reaction time than a phone.
 */

// ── World constants (world units; the ball always sits at x = LANE_X) ────────
const WORLD_W  = 400;
const LANE_X   = WORLD_W / 2;
// Enough of the course visible that the NEXT obstacle is on screen while you
// are still timing the current one. At 720 the next ring appeared only as you
// cleared the last, which left nothing to read ahead of.
const VIEW_H   = 900;    // world units visible top-to-bottom, on every device
const BALL_R   = 15;
const THICK    = 12;     // obstacle stroke thickness

const GRAV     = -1900;  // u/s^2
const JUMP_V   = 600;    // u/s, set (not added) on tap — as the original does
const FALL_MAX = -1500;

// Obstacles are ~250 units tall, and holding position between them costs a
// full tap arc (~95 units) of bob. At a 320 gap the clear space between one
// obstacle and the next was about 75 units — less than a single arc — so there
// was nowhere to wait and read the spin, and the game became "arrive and hope".
// 480 leaves ~235 units of room to hold station in.
const OBSTACLE_GAP = 480;
const FIRST_Y      = 520;
// Where the colour switcher sits above its obstacle. It belongs just past the
// obstacle you have cleared, NOT halfway to the next one: at the halfway point
// it sat under 40 units below the next entry band, so your colour changed and
// the band arrived before you could do anything about it.
const SWITCHER_OFFSET = 170;

// Where the ball sits on screen, as a fraction up from the bottom.
const BALL_SCREEN_FRAC = 0.38;

// Physics runs at a fixed step so a slow frame cannot move the ball further
// than the collision band is wide. At FALL_MAX the ball covers 6.3 units per
// step against a band of BALL_R + THICK/2 = 21, so it can never tunnel through
// an obstacle. A variable step tied to the frame rate would let exactly that
// happen on a stuttering phone — and it would look like a phantom death.
const FIXED_DT = 1 / 240;
const MAX_FRAME = 0.25;  // never simulate more than this per frame

// ── Palette ─────────────────────────────────────────────────────────────────
// White, blue, grey and black, to match the site. The blue is a brighter
// sibling of the site primary (#1250B4): the real primary is legible as a
// button on a dark surface but too dark to read reliably as a fast-moving
// 12px arc on pure black, and misreading a colour here costs the match.
//
// Black is a playable colour on a black background, so it is never drawn as
// bare fill — it always carries a light rim. Without that rim a black segment
// is invisible and the run ends on something the player could not see.
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

// ── Shapes ──────────────────────────────────────────────────────────────────
// Every obstacle is one or more closed loops. A loop is a list of points in
// the obstacle's own space; collision and colouring both work off arc length
// along that loop, which means a circle, a square and a triangle are all
// handled by the same code rather than three special cases.
function circleLoop(r, steps = 72) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}
function polyLoop(n, r, rot = -Math.PI / 2, perSide = 16) {
  // Corners are subdivided so arc length runs evenly around the shape — the
  // colour boundaries are placed by arc length, and without subdivision a
  // square's boundaries would all land on its corners.
  const corners = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
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

// The six obstacle families, each one or more closed loops.
//
// Every loop of an obstacle turns TOGETHER, at one speed and one colour
// offset. Counter-rotating the inner ring looks better and is unfair: the ball
// crosses the outer and inner bands a tenth of a second apart, so two
// independent rotations present two unrelated colours and clearing a nested
// shape becomes a coin toss rather than a read. Turning as one means a player
// who times the outer band correctly finds the same colour waiting inside.
const SHAPES = [
  { name: 'circle',         loops: [{ pts: circleLoop(122) }] },
  { name: 'square',         loops: [{ pts: polyLoop(4, 150, Math.PI / 4) }] },
  { name: 'triangle',       loops: [{ pts: polyLoop(3, 148) }] },
  { name: 'doubleCircle',   loops: [{ pts: circleLoop(132) }, { pts: circleLoop(74) }] },
  { name: 'squareCircle',   loops: [{ pts: polyLoop(4, 150, Math.PI / 4) }, { pts: circleLoop(72) }] },
  { name: 'triangleCircle', loops: [{ pts: polyLoop(3, 148) }, { pts: circleLoop(72) }] },
];

// Arc-length tables, precomputed once per loop so the per-frame collision test
// is a lookup rather than a re-measure.
const LOOP_META = new Map();
function meta(pts) {
  let m = LOOP_META.get(pts);
  if (m) return m;
  const cum = [0];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum.push(total);
  }
  m = { cum, total };
  LOOP_META.set(pts, m);
  return m;
}

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
      scale = (H) / VIEW_H;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    layout();
    // A ResizeObserver on the canvas ITSELF, not a window resize listener.
    //
    // The page's <main> animates its left and right edges over 300ms whenever
    // the chat sidebar opens or closes, and the sidebars mount after the first
    // paint. None of that fires a window resize event, so a listener-only
    // canvas measures once at mount and then keeps a stale width for the whole
    // match. That is exactly what happened here: the game laid itself out for a
    // 280px box inside a 420px one and drew the entire course off-centre.
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
      const speed  = Math.min(1.05 + i * 0.022, 2.15) * (0.9 + rnd01(seed, i, 4) * 0.25);
      const offset = Math.floor(rnd01(seed, i, 5) * 4);
      o = {
        i, y: FIRST_Y + i * OBSTACLE_GAP,
        shape, dotted, omega: dir * speed, offset,
        phase: rnd01(seed, i, 6) * Math.PI * 2,
        diamond: true,
        // Switcher sits between this obstacle and the next.
        switcher: true,
        switcherY: FIRST_Y + i * OBSTACLE_GAP + SWITCHER_OFFSET,
        switcherTo: Math.floor(rnd01(seed, i, 7) * 3), // index into "the other three"
      };
      obstacles.set(i, o);
      return o;
    }
    const angleOf = (o, t) => o.phase + o.omega * t;

    // ── State ───────────────────────────────────────────────────────────────
    const S = {
      y: 0, vy: JUMP_V * 0.5,
      color: 0,             // index into COLORS — starts white
      camBottom: -VIEW_H * BALL_SCREEN_FRAC,
      simT: 0, score: 0, dead: false,
      started: false,       // the run holds still until the first tap
      pulse: 0,             // brief flash after collecting
      deathFx: 0,
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

    // ── Collision ───────────────────────────────────────────────────────────
    // Nearest point on a loop to the ball, in the obstacle's own space. Returns
    // the distance and the arc length at that point, which is what decides the
    // colour. One routine for every shape.
    function nearestOnLoop(pts, px, py) {
      const m = meta(pts);
      let bestD = Infinity, bestS = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ax = a[0], ay = a[1];
        const dx = b[0] - ax, dy = b[1] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t, cy = ay + dy * t;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestD) { bestD = d; bestS = m.cum[i] + Math.hypot(dx, dy) * t; }
      }
      return { d: bestD, s: bestS, total: m.total };
    }
    // Colour of a loop at arc length s: four equal quarters, offset per
    // obstacle so consecutive obstacles don't all present the same colour first.
    const colorAtArc = (s, total, offset) =>
      (Math.floor((s / total) * 4) + offset) % 4;

    // A band kills on the FIRST contact of a pass, and only if the colours
    // differ. Match it and that band is cleared for the rest of the pass.
    //
    // This rule is the whole game, so it is worth saying why it is not "every
    // contact is checked". A ring crossed through its middle is touched twice —
    // once entering at the bottom, once leaving at the top — and those two
    // points sit opposite each other on the loop, which with four quarters means
    // they are NEVER the same colour at the same instant. Checking both would
    // make every ring impossible except when the spin happened to carry your
    // colour half a turn during the crossing, which is not something a player
    // can read or control: it would be luck wearing the costume of skill.
    //
    // Timing the entry IS readable and controllable, so that is what the game
    // asks for. Get in cleanly and you are through.
    function hitTest() {
      // Only obstacles that could possibly be in range — the ball is a point on
      // the lane, so anything more than a shape's reach away in y cannot touch.
      const first = Math.max(0, Math.floor((S.y - FIRST_Y - 260) / OBSTACLE_GAP));
      const last  = Math.floor((S.y - FIRST_Y + 260) / OBSTACLE_GAP);
      for (let i = first; i <= last; i++) {
        if (i < 0) continue;
        const o = obstacleAt(i);
        const dy = S.y - o.y;
        // Out of reach: forget any clearing, so an obstacle approached again
        // (after a fall) has to be entered honestly a second time.
        if (Math.abs(dy) > 230) { o.cleared = null; continue; }
        if (!o.cleared) o.cleared = o.shape.loops.map(() => false);
        const th = angleOf(o, S.simT);
        for (let li = 0; li < o.shape.loops.length; li++) {
          if (o.cleared[li]) continue;
          const loop = o.shape.loops[li];
          // Ball position in the obstacle's rotating frame.
          const cos = Math.cos(-th), sin = Math.sin(-th);
          const rx = 0 * cos - dy * sin;
          const ry = 0 * sin + dy * cos;
          const { d, s, total } = nearestOnLoop(loop.pts, rx, ry);
          if (d < BALL_R + THICK / 2) {
            const c = colorAtArc(s, total, o.offset);
            if (c !== S.color) return true;
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
        if (o.diamond && Math.abs(S.y - o.y) < BALL_R + 14) {
          o.diamond = false; S.score += 1; S.pulse = 1;
        }
        if (o.switcher && Math.abs(S.y - o.switcherY) < BALL_R + 15) {
          o.switcher = false;
          // Always a DIFFERENT colour — a switcher that can hand back the
          // colour you already have is a switcher that sometimes does nothing,
          // which reads as a bug rather than as luck.
          const others = [0, 1, 2, 3].filter(c => c !== S.color);
          S.color = others[o.switcherTo % others.length];
          S.pulse = 1;
        }
      }
    }

    // ── Simulation ──────────────────────────────────────────────────────────
    function step(dt) {
      if (S.dead) return;
      if (!S.started) return;      // held at the start line until the first tap
      S.simT += dt;
      S.vy += GRAV * dt;
      if (S.vy < FALL_MAX) S.vy = FALL_MAX;
      S.y += S.vy * dt;

      const target = S.y - VIEW_H * BALL_SCREEN_FRAC;
      if (target > S.camBottom) S.camBottom = target;   // camera never drops

      pickups();
      // Falling out of the bottom of the frame ends the run, same as the
      // original — otherwise a player who misses everything simply floats.
      if (S.y < S.camBottom - BALL_R * 2) return die();
      if (hitTest()) return die();
    }

    function die() {
      if (S.dead) return;
      S.dead = true;
      S.deathFx = 1;
      cbRef.current.onDeath?.(Math.floor(S.score), Math.floor(S.simT * 1000));
    }

    // ── Drawing ─────────────────────────────────────────────────────────────
    // World -> screen. y is flipped: the world climbs, the screen does not.
    const sx = (wx) => W / 2 + (wx - LANE_X) * scale;
    const sy = (wy) => H - (wy - S.camBottom) * scale;

    function strokeLoopSegments(loop, cx, cy, ang, offset, dotted) {
      const pts = loop.pts;
      const m = meta(pts);
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const px = (p) => cx + (p[0] * cos - p[1] * sin) * scale;
      const py = (p) => cy - (p[0] * sin + p[1] * cos) * scale;

      if (dotted) {
        // Dotted is a LOOK, not a gap: collision is unchanged, so a dotted
        // obstacle is exactly as solid as it appears to be in the original.
        // Making the gaps real would kill players on something invisible.
        const r = (THICK * 0.52) * scale;
        const stepLen = THICK * 1.85;
        const n = Math.max(12, Math.round(m.total / stepLen));
        for (let k = 0; k < n; k++) {
          const s = (k / n) * m.total;
          const idx = binarySearchArc(m.cum, s);
          const a = pts[idx], b = pts[(idx + 1) % pts.length];
          const segLen = m.cum[idx + 1] - m.cum[idx] || 1;
          const t = (s - m.cum[idx]) / segLen;
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const col = COLORS[colorAtArc(s, m.total, offset)];
          const X = px(p), Y = py(p);
          // Rim first, underneath — a black dot on a black background is
          // otherwise nothing at all.
          if (col.rim) {
            ctx.beginPath(); ctx.arc(X, Y, r + 2, 0, Math.PI * 2);
            ctx.fillStyle = col.rim; ctx.fill();
          }
          ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2);
          ctx.fillStyle = col.fill; ctx.fill();
        }
        return;
      }

      ctx.lineCap = 'butt';
      for (let q = 0; q < 4; q++) {
        const from = (q / 4) * m.total, to = ((q + 1) / 4) * m.total;
        const col = COLORS[(q + offset) % 4];
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < pts.length; i++) {
          const s = m.cum[i];
          if (s < from - 1e-6 || s > to + 1e-6) continue;
          const X = px(pts[i]), Y = py(pts[i]);
          if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
        }
        // Close the quarter onto the FIRST POINT OF THE NEXT quarter, wrapping
        // at the seam, so the four arcs meet with no hairline of background
        // between them. Clamping to the last index instead leaves the final
        // quarter open and draws a visible notch at the top of every shape.
        if (started) {
          const nextIdx = Math.round((to / m.total) * pts.length) % pts.length;
          ctx.lineTo(px(pts[nextIdx]), py(pts[nextIdx]));
        }
        // Black is a playable colour on a black background, so it is drawn as
        // a light rim with black laid over it — an outlined band rather than a
        // hole in the screen.
        if (col.rim) {
          ctx.lineWidth = THICK * scale + 4;
          ctx.strokeStyle = col.rim;
          ctx.stroke();
        }
        ctx.lineWidth = THICK * scale;
        ctx.strokeStyle = col.fill;
        ctx.stroke();
      }
    }

    function binarySearchArc(cum, s) {
      let lo = 0, hi = cum.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function drawDiamond(x, y, r) {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.68, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.68, y);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(255,255,255,0.55)';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    function drawSwitcher(x, y, r, t) {
      // Four quadrants, slowly turning, so it reads as "this changes colour".
      for (let q = 0; q < 4; q++) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, r, t + (q / 4) * Math.PI * 2, t + ((q + 1) / 4) * Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = COLORS[q].fill;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    function drawBall() {
      const x = sx(LANE_X), y = sy(S.y), r = BALL_R * scale;
      const col = COLORS[S.color];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = col.fill;
      ctx.shadowColor = col.rim ? 'rgba(200,210,230,0.5)' : col.fill;
      ctx.shadowBlur = 16 + S.pulse * 22;   // brief flare when something is collected
      ctx.fill();
      ctx.shadowBlur = 0;
      // The black ball always carries a rim. Without it the thing the player
      // is steering disappears against the background.
      ctx.lineWidth = col.rim ? 3 : 1.5;
      ctx.strokeStyle = col.rim || 'rgba(0,0,0,0.35)';
      ctx.stroke();
    }

    function render() {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      const topY = S.camBottom + VIEW_H;
      const first = Math.max(0, Math.floor((S.camBottom - FIRST_Y - 260) / OBSTACLE_GAP));
      const last  = Math.floor((topY - FIRST_Y + 260) / OBSTACLE_GAP);
      for (let i = first; i <= last; i++) {
        if (i < 0) continue;
        const o = obstacleAt(i);
        const cx = sx(LANE_X), cy = sy(o.y);
        const th = angleOf(o, S.simT);
        for (const loop of o.shape.loops) {
          strokeLoopSegments(loop, cx, cy, th, o.offset, o.dotted);
        }
        if (o.diamond)  drawDiamond(cx, cy, 13 * scale);
        if (o.switcher) drawSwitcher(sx(LANE_X), sy(o.switcherY), 15 * scale, S.simT * 0.9);
      }

      if (!S.dead) drawBall();

      drawHUD();

      if (!S.started) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.font = `900 ${Math.round(Math.min(W, H) * 0.075)}px system-ui, sans-serif`;
        ctx.fillText('TAP TO START', W / 2, H * 0.46);
        ctx.font = `600 ${Math.round(Math.min(W, H) * 0.036)}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText('Pass through your own colour', W / 2, H * 0.52);
      }
    }

    function drawHUD() {
      // Score top-centre and time top-right, matching Rush Hour — the catch-up
      // banner and the help button own the two left corners.
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `900 ${Math.round(H * 0.055)}px system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
      ctx.fillText(String(S.score), W / 2, H * 0.085);
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
      // panel on the start screen is not a stalled client — without this they
      // are cut off mid-read with a run of zero.
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
