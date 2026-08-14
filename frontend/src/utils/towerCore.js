// Tower — the rules, with no rendering and no React in sight.
//
// Kept pure and separate for two reasons. The canvas needs to step it every
// frame, and the bot needs to play it headlessly to produce a believable score;
// neither should have to drag the other's dependencies along. It also means the
// whole game is testable without a DOM.
//
// World space is isometric: x and y are the two ground axes that appear as the
// two 45-degree diagonals on screen, and z is height in blocks. A block slides
// along ONE of those axes, alternating each turn — so successive blocks come in
// from opposite diagonals, exactly like the original.

export const BLOCK_H   = 0.36;   // block height, in the same units as its footprint
export const BASE_SIZE = 1.0;    // starting footprint, world units
export const TRAVEL    = 1.9;    // distance from centre the slider reaches before turning

// A drop within this of perfect keeps the full footprint and hands a sliver
// back. Without the reward a long run is impossible: every drop shaves a little
// and the tower would starve even under perfect play.
export const PERFECT_EPS    = 0.035;
export const PERFECT_REWARD = 0.012;

// Speed ramp. Slow enough at the start to feel fair, and capped so the top of a
// long run stays humanly playable rather than turning into a coin flip.
const SPEED_START = 1.25;   // world units per second
const SPEED_STEP  = 0.055;
const SPEED_MAX   = 4.4;

export const speedForScore = (score) =>
  Math.min(SPEED_MAX, SPEED_START + score * SPEED_STEP);

// Blue only, as asked. The original cycles hue; here the hue barely moves and
// the LIGHTNESS cycles instead, which is what produces the banding up the tower
// while keeping every block unmistakably blue.
export function shadeFor(index) {
  const t = index * 0.28;
  const light = 46 + Math.sin(t) * 20;          // 26% .. 66%
  const hue   = 208 + Math.sin(t * 0.5) * 8;    // 200 .. 216
  return { hue, light, sat: 78 };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A run. Call step() with a delta each frame and drop() on a tap.
 *
 * `onLand` fires for every successful placement with { perfect, score } so the
 * caller can play a sound or flash without polling.
 */
export function createRun({ onLand, onOver } = {}) {
  const state = {
    blocks: [],       // placed: { x, y, sx, sy, level, index }
    slices: [],       // offcuts falling away: { x, y, sx, sy, level, index, vy, spin, t }
    moving: null,     // { axis, pos, dir, sx, sy }
    score: 0,
    perfectStreak: 0,
    over: false,
    // Timing of every drop, from the run's start. The engine uses these to spot
    // a run that is too metronomic to be human — this game takes one input, so
    // it is the easiest on the platform to script.
    taps: [],
    elapsed: 0,
  };

  state.blocks.push({ x: 0, y: 0, sx: BASE_SIZE, sy: BASE_SIZE, level: 0, index: 0 });
  spawn();

  function spawn() {
    const top  = state.blocks[state.blocks.length - 1];
    const axis = state.blocks.length % 2 === 1 ? 'x' : 'y';
    state.moving = {
      axis,
      // Always enters from the far side so the eye can pick it up before it
      // reaches the tower.
      pos: -TRAVEL,
      dir: 1,
      sx: top.sx,
      sy: top.sy,
    };
  }

  function step(dt) {
    if (state.over || !state.moving) return;
    state.elapsed += dt;
    const m = state.moving;
    const speed = speedForScore(state.score);
    m.pos += m.dir * speed * dt;
    if (m.pos > TRAVEL)  { m.pos = TRAVEL;  m.dir = -1; }
    if (m.pos < -TRAVEL) { m.pos = -TRAVEL; m.dir = 1; }

    // Offcuts tumble away and are dropped once well off screen.
    for (const s of state.slices) {
      s.t  += dt;
      s.vy += 9.8 * dt;
      s.level -= s.vy * dt;
      s.spin += dt * 2.2;
    }
    if (state.slices.length > 12) state.slices.splice(0, state.slices.length - 12);
  }

  function drop() {
    if (state.over || !state.moving) return null;
    const m   = state.moving;
    const top = state.blocks[state.blocks.length - 1];
    const along = m.axis === 'x' ? 'x' : 'y';
    const size  = m.axis === 'x' ? 'sx' : 'sy';

    const movingCentre = m.pos;
    const delta = movingCentre - top[along];
    const abs   = Math.abs(delta);

    // Missed entirely — no footprint left to stand on.
    if (abs >= top[size]) {
      state.over = true;
      state.taps.push(state.elapsed);
      state.moving = null;
      onOver?.({ score: state.score });
      return { hit: false, perfect: false };
    }

    const perfect = abs <= PERFECT_EPS;
    let newSize, newCentre;

    if (perfect) {
      // Snap, and hand back a sliver — capped at the base so a run cannot grow
      // a footprint wider than it started with.
      newSize   = Math.min(BASE_SIZE, top[size] + PERFECT_REWARD);
      newCentre = top[along];
      state.perfectStreak++;
    } else {
      newSize   = top[size] - abs;
      newCentre = movingCentre - Math.sign(delta) * (abs / 2);
      state.perfectStreak = 0;
    }

    const level = top.level + 1;
    const index = state.blocks.length;
    const placed = {
      x: m.axis === 'x' ? newCentre : top.x,
      y: m.axis === 'y' ? newCentre : top.y,
      sx: m.axis === 'x' ? newSize : top.sx,
      sy: m.axis === 'y' ? newSize : top.sy,
      level,
      index,
    };
    state.blocks.push(placed);

    if (!perfect) {
      // The offcut keeps the side of the block that overhung.
      const offSize = abs;
      const offCentre = movingCentre + Math.sign(delta) * ((top[size] - abs) / 2 + 0.0001);
      state.slices.push({
        x: m.axis === 'x' ? offCentre : placed.x,
        y: m.axis === 'y' ? offCentre : placed.y,
        sx: m.axis === 'x' ? offSize : placed.sx,
        sy: m.axis === 'y' ? offSize : placed.sy,
        level, index, vy: 0, spin: 0, t: 0,
        side: Math.sign(delta),
      });
    }

    state.score++;
    state.taps.push(state.elapsed);
    onLand?.({ perfect, score: state.score });

    // Nothing left to aim at.
    if (newSize <= 0.06) {
      state.over = true;
      state.moving = null;
      onOver?.({ score: state.score });
      return { hit: true, perfect, exhausted: true };
    }

    spawn();
    return { hit: true, perfect };
  }

  return {
    state,
    step,
    drop,
    get score() { return state.score; },
    get over()  { return state.over; },
  };
}

/**
 * How metronomic a run's inputs were, as the standard deviation of the gaps
 * between drops, in seconds.
 *
 * A human's gaps wander; a script's do not. This does not decide anything on its
 * own — it is reported so a suspicious run reaches the admin queue rather than
 * being auto-judged, because a genuinely good player on an easy stretch can look
 * consistent for a while.
 */
export function tapJitter(taps) {
  if (!taps || taps.length < 6) return null;
  const gaps = [];
  for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const varr = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  return { mean, stdev: Math.sqrt(varr), drops: taps.length };
}

// ── Projection ───────────────────────────────────────────────────────────────
//
// Lives here rather than inside the canvas so it can be tested without a DOM.
// It decides everything about how the game reads on screen, and a sign error in
// it produces a tower that leans or slides off — the kind of thing that is
// obvious in motion and invisible in a code review.
//
// The two ground axes project to the two 45-degree diagonals: +x goes down-right,
// +y goes down-left. Height goes straight up. halfH is half of halfW, the usual
// 2:1 isometric ratio.
export function isoProject(x, y, level, view) {
  return {
    px: view.originX + (x - y) * view.halfW,
    py: view.originY + (x + y) * view.halfH - level * view.blockPx,
  };
}

/**
 * The three visible faces of a block, as screen-space polygons.
 *
 * Corner order matters: `front` is the corner nearest the viewer (max x, max y)
 * and must be shared by both side faces, or they meet with a seam.
 */
export function blockFaces(b, level, view) {
  const hx = b.sx / 2, hy = b.sy / 2;
  const back  = isoProject(b.x - hx, b.y - hy, level, view);
  const right = isoProject(b.x + hx, b.y - hy, level, view);
  const front = isoProject(b.x + hx, b.y + hy, level, view);
  const left  = isoProject(b.x - hx, b.y + hy, level, view);
  const drop  = (p) => ({ px: p.px, py: p.py + view.blockPx });
  return {
    top:   [back, right, front, left],
    right: [front, right, drop(right), drop(front)],
    left:  [left, front, drop(front), drop(left)],
  };
}

/** View transform for a canvas of this size with the camera at `camera` levels. */
export function makeView(width, height, camera) {
  const halfW   = Math.min(width * 0.30, height * 0.20);
  const halfH   = halfW * 0.5;
  const blockPx = halfW * BLOCK_H * 2;
  return {
    halfW, halfH, blockPx,
    originX: width / 2,
    // Rises with the tower so the working top stays put on screen.
    originY: height * 0.58 + camera * blockPx,
  };
}

export { clamp };
