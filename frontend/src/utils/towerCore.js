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

export const BLOCK_H   = 0.12;   // block height, in the same units as its footprint
export const BASE_SIZE = 1.0;    // starting footprint, world units
// Distance from centre the slider reaches before turning.
//
// This was 1.9, which put the spawn point off the side of a phone screen: the
// block was created at the top right as intended but was not VISIBLE there, so
// the first thing a player saw was it already sliding in from the edge — which
// is why the start read as coming from the wrong place. 1.25 keeps the whole
// travel on screen, so the block is seen sitting at the top right before it
// moves. It also tightens the pacing, since the block no longer spends time
// crossing empty space nobody can see.
export const TRAVEL    = 1.25;

// A drop within this of perfect keeps the full footprint and hands a sliver
// back. Without the reward a long run is impossible: every drop shaves a little
// and the tower would starve even under perfect play.
export const PERFECT_EPS    = 0.035;
export const PERFECT_REWARD = 0.012;

// How long the final block falls before the run is reported over. Without this
// the tower simply stops and the result card appears, with no sense that the
// last block missed.
export const MISS_FALL_S = 0.85;

// Speed ramp. Slow enough at the start to feel fair, and capped so the top of a
// long run stays humanly playable rather than turning into a coin flip.
const SPEED_START = 1.35;   // world units per second
const SPEED_STEP  = 0.030;   // was 0.062 — full speed arrived by ~block 55
const SPEED_MAX   = 4.6;

export const speedForScore = (score) =>
  Math.min(SPEED_MAX, SPEED_START + score * SPEED_STEP);

// Built around the site's own blue, #1250B4 — hsl(215, 82%, 39%) — so the game
// reads as part of the product rather than a different app.
//
// The hue barely moves and the LIGHTNESS cycles, which gives the banding up the
// tower while keeping every block unmistakably blue. The range is the important
// part: it used to run 26%..66%, and at the dark end a block on a black
// background was invisible with its two side faces crushed to near-black on top
// of that. Now it never goes below 36%, and the sides are derived as a RATIO of
// the top rather than a fixed subtraction, so a dark block keeps the same
// relative shading a light one has instead of flattening out.
export const SHADE_MIN = 34;
export const SHADE_MAX = 66;

// The band walks a long triangle wave rather than a sine.
//
// A sine spends most of its time near the extremes and crawls through the
// middle, so long stretches of the tower came out nearly the same shade — the
// complaint that the colours "don't change enough". A triangle moves at a
// constant rate, so every block is a visibly different step from the one below
// it while the range itself stays inside the same safe window: never so dark it
// vanishes on black, never so pale it stops reading as the site blue.
export function shadeFor(index) {
  // Two layers, because "changes every block" and "does not repeat" pull in
  // opposite directions on their own.
  //
  // A short triangle gives the per-block step: 8 blocks per sweep means every
  // neighbour differs by a clear margin instead of the ~2.5% that a long sweep
  // produced, which was technically different and visually identical.
  //
  // A slow drift on a period coprime with it stops the tower repeating the same
  // five shades forever, so a tall tower keeps producing new ones. Both are
  // sized so the total stays inside SHADE_MIN..SHADE_MAX.
  const PERIOD = 8;
  const phase = ((index % PERIOD) + PERIOD) % PERIOD / PERIOD;
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;     // 0..1..0, linear
  const drift = Math.sin((index * 2 * Math.PI) / 37) * 4;
  const mid = (SHADE_MIN + SHADE_MAX) / 2;                  // 50
  return {
    hue:   214 + Math.sin(index * 0.11) * 4,               // 210 .. 218
    light: mid + (tri * 2 - 1) * 12 + drift,               // 34 .. 66
    sat:   80,
  };
}


/** Top, right and left face lightness for a block. Always visibly stepped. */
export function faceShades(index) {
  const { hue, light, sat } = shadeFor(index);
  return {
    hue, sat,
    top:   light,
    right: light * 0.70,
    left:  light * 0.52,
  };
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
    bursts: [],        // perfect-drop rings: { x, y, level, t }
    pendingOverAt: null,
  };

  state.blocks.push({ x: 0, y: 0, sx: BASE_SIZE, sy: BASE_SIZE, level: 0, index: 0 });
  spawn();

  function spawn() {
    const top  = state.blocks[state.blocks.length - 1];
    // +y projects to the top-right -> bottom-left diagonal and +x to the
    // top-left -> bottom-right one. Starting on y means the very first block
    // enters from the top right, and they alternate from there.
    const axis = state.blocks.length % 2 === 1 ? 'y' : 'x';
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

  /**
   * Advance the run.
   *
   * `live` is whether input is actually accepted right now. It has to be passed
   * in rather than assumed: the canvas keeps stepping during the countdown so
   * offcuts and bursts stay animated, and without this the slider was travelling
   * behind the opaque countdown overlay. Three seconds at the opening speed is
   * more than a full length of the track, so the block emerged from the count
   * at an arbitrary point — usually bottom-left heading up-right, which is the
   * opposite of the intended opening.
   */
  function step(dt, live = true) {
    state.elapsed += dt;

    // The slider only moves while the run is live, but everything else keeps
    // animating — the last block still has to be seen falling after a miss.
    if (live && !state.over && state.moving) {
      const m = state.moving;
      const speed = speedForScore(state.score);
      m.pos += m.dir * speed * dt;
      if (m.pos > TRAVEL)  { m.pos = TRAVEL;  m.dir = -1; }
      if (m.pos < -TRAVEL) { m.pos = -TRAVEL; m.dir = 1; }
    }

    // Offcuts tumble away and are dropped once well off screen.
    for (const sl of state.slices) {
      sl.t  += dt;
      sl.vy += 9.8 * dt;
      sl.level -= sl.vy * dt;
      // Kept for any future use, but nothing renders it: a tilting piece
      // sweeping sideways across the tower was what made the overlap obvious,
      // so an offcut now simply drops behind the tower.
      sl.spin += dt * 1.9 * (sl.side || 1);
    }
    if (state.slices.length > 12) state.slices.splice(0, state.slices.length - 12);

    for (const b of state.bursts) b.t += dt;
    if (state.bursts.length > 4) state.bursts.splice(0, state.bursts.length - 4);

    // A miss ends the run only once its block has visibly fallen.
    if (state.pendingOverAt != null && state.elapsed >= state.pendingOverAt) {
      state.pendingOverAt = null;
      onOver?.({ score: state.score });
    }
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

    // Missed entirely — no footprint left to stand on. The block is handed to
    // the falling pile rather than deleted, and the run is reported over only
    // after it has dropped out of frame.
    if (abs >= top[size]) {
      state.over = true;
      state.taps.push(state.elapsed);
      state.slices.push({
        x: m.axis === 'x' ? m.pos : top.x,
        y: m.axis === 'y' ? m.pos : top.y,
        sx: m.sx, sy: m.sy,
        level: top.level + 1,
        index: state.blocks.length,
        vy: 0, spin: 0, t: 0,
        side: Math.sign(delta) || 1,
      });
      state.moving = null;
      state.pendingOverAt = state.elapsed + MISS_FALL_S;
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

    if (perfect) {
      state.bursts.push({ x: placed.x, y: placed.y, sx: placed.sx, sy: placed.sy, level, t: 0 });
    }

    state.score++;
    state.taps.push(state.elapsed);
    onLand?.({ perfect, score: state.score });

    // Nothing left to aim at.
    //
    // This was 0.06 of the base footprint, which ends a run while the block is
    // still several pixels wide and clearly landable — the game appeared to quit
    // on its own. It now only stops when there is genuinely nothing to hit.
    if (newSize <= 0.012) {
      state.over = true;
      state.moving = null;
      state.pendingOverAt = state.elapsed + MISS_FALL_S;
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
  const halfW   = Math.min(width * 0.34, height * 0.23);
  const halfH   = halfW * 0.5;
  const blockPx = halfW * BLOCK_H * 2;
  return {
    halfW, halfH, blockPx,
    originX: width / 2,
    // Rises with the tower so the working top stays put on screen. Sits lower
    // than centre so there is room above for the incoming block.
    originY: height * 0.66 + camera * blockPx,
  };
}

export { clamp };
