// Tower's rules, exercised headlessly.
//
// The slicing maths is the whole game and it is easy to get subtly wrong in a
// way that only shows up as "the tower drifts" after twenty blocks. So the
// footprint and the centre are checked exactly, not approximately.
//
// The module is frontend ESM; it is evaluated here rather than bundled, the same
// way quickmatch.test.js reads its pool helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'towerCore.js'), 'utf8');

const core = new Function(`${src.replace(/export /g, '')}; return {
  createRun, shadeFor, speedForScore, tapJitter,
  BLOCK_H, BASE_SIZE, TRAVEL, PERFECT_EPS, PERFECT_REWARD };`)();

const { createRun, shadeFor, speedForScore, tapJitter, BASE_SIZE, PERFECT_EPS, PERFECT_REWARD } = core;

// Place the slider at an exact offset from the block below, then drop.
function dropAt(run, offset) {
  const s = run.state;
  const top = s.blocks[s.blocks.length - 1];
  const along = s.moving.axis === 'x' ? 'x' : 'y';
  s.moving.pos = top[along] + offset;
  return run.drop();
}

const topOf = (run) => run.state.blocks[run.state.blocks.length - 1];
// Which axis the waiting block travels on, and the footprint key that goes with
// it. Written this way so the tests survive a change to which axis comes first.
const axisOf = (run) => run.state.moving.axis;
const sizeKeyOf = (run) => (axisOf(run) === 'x' ? 'sx' : 'sy');

test('a run starts with one full-size block and a slider', () => {
  const run = createRun();
  assert.equal(run.state.blocks.length, 1);
  assert.equal(run.state.blocks[0].sx, BASE_SIZE);
  assert.ok(run.state.moving, 'a slider should be waiting');
  assert.equal(run.score, 0);
});

test('successive blocks alternate axis', () => {
  // This is what makes blocks arrive from opposite diagonals.
  const run = createRun();
  const axes = [];
  for (let i = 0; i < 4; i++) {
    axes.push(run.state.moving.axis);
    dropAt(run, 0);
  }
  // Starts on y, which is the top-right -> bottom-left diagonal.
  assert.deepEqual(axes, ['y', 'x', 'y', 'x']);
});

test('an offset drop shrinks the footprint by exactly the overhang', () => {
  const run = createRun();
  const key = sizeKeyOf(run);
  const before = topOf(run)[key];
  dropAt(run, 0.2);
  assert.ok(Math.abs(topOf(run)[key] - (before - 0.2)) < 1e-9,
    `expected ${before - 0.2}, got ${topOf(run)[key]}`);
});

test('the surviving block is centred on the overlap, not on either original', () => {
  // Getting this wrong makes the tower lean and is invisible for a few blocks.
  const run = createRun();
  const along = axisOf(run);
  const offset = 0.3;
  dropAt(run, offset);
  const placed = topOf(run);
  // Overlap spans [offset - 0.5, 0.5] for a unit block, so its centre is at
  // offset/2.
  assert.ok(Math.abs(placed[along] - offset / 2) < 1e-9,
    `expected centre ${offset / 2}, got ${placed[along]}`);
});

test('overhang on the other side works the same', () => {
  const run = createRun();
  const along = axisOf(run), key = sizeKeyOf(run);
  dropAt(run, -0.3);
  const placed = topOf(run);
  assert.ok(Math.abs(placed[key] - 0.7) < 1e-9);
  assert.ok(Math.abs(placed[along] + 0.15) < 1e-9, `got ${placed[along]}`);
});

test('a perfect drop keeps the footprint and hands a sliver back', () => {
  const run = createRun();
  dropAt(run, 0.25);                 // lose some width first
  const shrunk = topOf(run).sx;
  dropAt(run, 0);                    // then a perfect on the same axis? next axis
  dropAt(run, PERFECT_EPS * 0.5);    // still within tolerance
  assert.ok(topOf(run).sx >= shrunk, 'a perfect drop must never shrink the tower');
});

test('the perfect reward cannot grow a tower past its base size', () => {
  const run = createRun();
  for (let i = 0; i < 40; i++) dropAt(run, 0);
  assert.ok(topOf(run).sx <= BASE_SIZE + 1e-9, `grew to ${topOf(run).sx}`);
  assert.ok(topOf(run).sy <= BASE_SIZE + 1e-9);
});

test('a perfect drop snaps into line instead of drifting', () => {
  const run = createRun();
  dropAt(run, PERFECT_EPS * 0.5);
  assert.equal(topOf(run).x, 0, 'a perfect drop should align exactly, not nearly');
});

test('missing entirely ends the run', () => {
  const run = createRun();
  const r = dropAt(run, 1.0);   // full width away — no overlap at all
  assert.equal(r.hit, false);
  assert.ok(run.over);
});

test('a miss does not score', () => {
  const run = createRun();
  dropAt(run, 0.2);
  const before = run.score;
  dropAt(run, 5);
  assert.equal(run.score, before);
});

test('the run ends when nothing is left to aim at', () => {
  const run = createRun();
  // Shave repeatedly on alternating axes until it starves.
  for (let i = 0; i < 60 && !run.over; i++) dropAt(run, topOf(run)[i % 2 === 0 ? 'sx' : 'sy'] * 0.5);
  assert.ok(run.over, 'a starved tower must end the run');
});

test('an offcut is produced for a miss-by-a-bit, but not for a perfect', () => {
  const run = createRun();
  dropAt(run, 0.25);
  assert.equal(run.state.slices.length, 1);
  dropAt(run, 0);
  assert.equal(run.state.slices.length, 1, 'a perfect drop leaves nothing to fall');
});

test('the slider bounces between the two ends', () => {
  const run = createRun();
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    run.step(0.016);
    seen.add(Math.sign(run.state.moving.dir));
  }
  assert.deepEqual([...seen].sort(), [-1, 1], 'it must travel both ways');
});

test('a stalled tab cannot teleport the slider', () => {
  // step() is fed a clamped delta by the canvas; check the core itself stays
  // inside its rails for any single step.
  const run = createRun();
  run.step(10);
  assert.ok(Math.abs(run.state.moving.pos) <= core.TRAVEL + 1e-9,
    `slider escaped to ${run.state.moving.pos}`);
});

test('speed ramps with score and then stops', () => {
  assert.ok(speedForScore(10) > speedForScore(0));
  assert.equal(speedForScore(10_000), speedForScore(1_000),
    'the ramp must cap, or the top of a run becomes a coin flip');
});

test('every shade is blue', () => {
  for (let i = 0; i < 400; i++) {
    const { hue, light, sat } = shadeFor(i);
    assert.ok(hue >= 195 && hue <= 225, `hue ${hue} at ${i} is not blue`);
    assert.ok(light > 20 && light < 75, `lightness ${light} at ${i} is out of range`);
    assert.ok(sat > 40, 'a washed-out shade would not read as blue');
  }
});

test('shades vary, so the tower bands instead of reading as one slab', () => {
  const lights = new Set(Array.from({ length: 24 }, (_, i) => Math.round(shadeFor(i).light)));
  assert.ok(lights.size > 8, `only ${lights.size} distinct shades in 24 blocks`);
});

test('drop timings are recorded for the bot check', () => {
  const run = createRun();
  for (let i = 0; i < 5; i++) { run.step(0.2); dropAt(run, 0.01); }
  assert.equal(run.state.taps.length, 5);
});

test('jitter separates a metronome from a human', () => {
  const robot = [0, 1, 2, 3, 4, 5, 6, 7];
  const human = [0, 0.92, 2.11, 2.98, 4.22, 5.03, 6.31, 7.02];
  assert.ok(tapJitter(robot).stdev < 1e-9, 'a perfect metronome has no jitter');
  assert.ok(tapJitter(human).stdev > 0.05, 'a human should not look metronomic');
  assert.equal(tapJitter([0, 1]), null, 'too few drops to judge');
});

// ── Projection ───────────────────────────────────────────────────────────────
//
// The canvas cannot be screenshotted from here (a hidden tab never fires
// requestAnimationFrame, so it never paints), so the geometry that decides how
// the game looks is checked directly instead of taken on trust.

const { isoProject, blockFaces, makeView } = new Function(
  `${src.replace(/export /g, '')}; return { isoProject, blockFaces, makeView };`)();

const view = makeView(420, 860, 0);

test('the two ground axes go to opposite diagonals', () => {
  const o = isoProject(0, 0, 0, view);
  const ax = isoProject(1, 0, 0, view);   // +x
  const ay = isoProject(0, 1, 0, view);   // +y
  assert.ok(ax.px > o.px && ax.py > o.py, '+x should run down-right');
  assert.ok(ay.px < o.px && ay.py > o.py, '+y should run down-left');
  // Equal and opposite horizontally, identical vertically — that is what makes
  // them read as two 45-degree diagonals rather than an arbitrary skew.
  assert.ok(Math.abs((ax.px - o.px) + (ay.px - o.px)) < 1e-9);
  assert.ok(Math.abs((ax.py - o.py) - (ay.py - o.py)) < 1e-9);
});

test('height goes straight up', () => {
  const a = isoProject(0.3, 0.3, 0, view);
  const b = isoProject(0.3, 0.3, 1, view);
  assert.equal(a.px, b.px, 'a taller block must not shift sideways');
  assert.ok(b.py < a.py, 'higher levels must draw higher on screen');
});

test('the isometric ratio is 2:1', () => {
  assert.ok(Math.abs(view.halfW / view.halfH - 2) < 1e-9);
});

test('a block has a top and two side faces that share the front corner', () => {
  const b = { x: 0, y: 0, sx: 1, sy: 1, index: 0 };
  const f = blockFaces(b, 0, view);
  assert.equal(f.top.length, 4);
  // The corner nearest the viewer belongs to both sides, or they show a seam.
  assert.deepEqual(f.left[1], f.right[0]);
});

test('side faces hang below the top face by exactly one block', () => {
  const f = blockFaces({ x: 0, y: 0, sx: 1, sy: 1, index: 0 }, 0, view);
  assert.ok(Math.abs((f.right[2].py - f.right[1].py) - view.blockPx) < 1e-9);
});

test('a narrower block draws narrower', () => {
  const wide   = blockFaces({ x: 0, y: 0, sx: 1.0, sy: 1, index: 0 }, 0, view);
  const narrow = blockFaces({ x: 0, y: 0, sx: 0.4, sy: 1, index: 0 }, 0, view);
  const span = (f) => Math.max(...f.top.map(p => p.px)) - Math.min(...f.top.map(p => p.px));
  assert.ok(span(narrow) < span(wide));
});

test('the camera keeps the working top in the same place on screen', () => {
  // Without this the tower climbs off the top of the screen as it grows.
  const at0  = isoProject(0, 0, 0,  makeView(420, 860, 0));
  const at20 = isoProject(0, 0, 20, makeView(420, 860, 20));
  assert.ok(Math.abs(at0.py - at20.py) < 1e-6,
    `top drifted from ${at0.py} to ${at20.py} — the camera is not following`);
});

test('the base block is a sensible share of the screen', () => {
  const f = blockFaces({ x: 0, y: 0, sx: 1, sy: 1, index: 0 }, 0, view);
  const span = Math.max(...f.top.map(p => p.px)) - Math.min(...f.top.map(p => p.px));
  assert.ok(span > 420 * 0.4 && span < 420 * 0.9, `base spans ${span}px of 420`);
});

// ── Feedback and finish ──────────────────────────────────────────────────────

test('a miss drops the block instead of deleting it', () => {
  // Item 14: the run used to simply stop, with no sense that the block missed.
  const run = createRun();
  const before = run.state.slices.length;
  dropAt(run, 1.0);
  assert.equal(run.state.slices.length, before + 1, 'the missed block should be falling');
  assert.ok(run.over, 'no further input is accepted');
});

test('the run is reported over only once that block has fallen', () => {
  let overAt = null;
  const run = createRun({ onOver: () => { overAt = run.state.elapsed; } });
  dropAt(run, 1.0);
  assert.equal(overAt, null, 'the result must not appear while the block is still in the air');
  for (let i = 0; i < 20; i++) run.step(0.05);   // 1.0s
  assert.ok(overAt !== null, 'the run must end after the fall');
  assert.ok(overAt >= MISS_FALL_S - 1e-9, `ended too early at ${overAt}`);
});

test('the falling block keeps animating after the run ends', () => {
  // step() used to bail the moment `over` was set, which froze the animation
  // that is the whole point of the delay.
  const run = createRun();
  dropAt(run, 1.0);
  const start = run.state.slices[run.state.slices.length - 1].level;
  for (let i = 0; i < 10; i++) run.step(0.03);
  assert.ok(run.state.slices[run.state.slices.length - 1].level < start, 'it should be falling');
});

test('a perfect drop leaves a burst to draw, an ordinary one does not', () => {
  const run = createRun();
  dropAt(run, 0.25);
  assert.equal(run.state.bursts.length, 0);
  dropAt(run, 0);
  assert.equal(run.state.bursts.length, 1);
});

test('bursts do not accumulate forever', () => {
  const run = createRun();
  for (let i = 0; i < 30; i++) { dropAt(run, 0); run.step(0.016); }
  assert.ok(run.state.bursts.length <= 4, `${run.state.bursts.length} bursts retained`);
});

// ── Colour ───────────────────────────────────────────────────────────────────

const { faceShades, SHADE_MIN, SHADE_MAX, MISS_FALL_S } = new Function(
  `${src.replace(/export /g, '')}; return { faceShades, SHADE_MIN, SHADE_MAX, MISS_FALL_S };`)();

test('no block is ever too dark to see on black', () => {
  // The complaint: high up the tower went near-black and vanished.
  for (let i = 0; i < 500; i++) {
    const f = faceShades(i);
    assert.ok(f.top >= SHADE_MIN - 1e-9, `top ${f.top} at ${i} is below the floor`);
    assert.ok(f.left > 15, `left face ${f.left} at ${i} would read as black`);
  }
});

test('every block keeps three distinct faces', () => {
  // The old fixed subtraction clamped to near-zero on dark blocks, flattening
  // them into one silhouette with no shading at all.
  for (let i = 0; i < 500; i++) {
    const f = faceShades(i);
    assert.ok(f.top - f.right > 6, `faces merged at ${i}: ${f.top}/${f.right}`);
    assert.ok(f.right - f.left > 4, `sides merged at ${i}: ${f.right}/${f.left}`);
  }
});

test('the palette sits on the site blue', () => {
  for (let i = 0; i < 500; i++) {
    const { hue, sat } = faceShades(i);
    assert.ok(hue >= 208 && hue <= 222, `hue ${hue} drifted off #1250B4`);
    assert.ok(sat >= 70, 'a washed-out blue would not match the site');
  }
});

test('blocks are thin and the slide is quicker than before', () => {
  assert.ok(core.BLOCK_H <= 0.13, `blocks are ${core.BLOCK_H} tall — item 11 asked for 3x thinner`);
  // Quicker off the line than the original, but the ramp is gentler now — full
  // speed used to arrive by about block 55, which felt fast far too early.
  assert.ok(speedForScore(0) > 1.2, 'the opening slide should not be sluggish');
  assert.ok(speedForScore(30) < speedForScore(80), 'it must still ramp');
  assert.ok(speedForScore(30) < 2.6, `too fast by block 30: ${speedForScore(30)}`);
});

test('the first block enters from the top right', () => {
  // +y is the top-right -> bottom-left diagonal; +x is the other one. Which axis
  // the run opens on is what decides where the very first block comes from.
  const run = createRun();
  assert.equal(run.state.moving.axis, 'y');

  const v = makeView(420, 860, 0);
  const centre = isoProject(0, 0, 1, v);
  const entry  = isoProject(0, run.state.moving.pos, 1, v);
  assert.ok(entry.px > centre.px, 'it should enter from the right');
  assert.ok(entry.py < centre.py, 'and from above');
});

test('the shade steps visibly between neighbouring blocks', () => {
  // A sine crawls through its midpoint, so long stretches came out nearly
  // identical. Every block should be a clear step from the one below it.
  let smallest = Infinity;
  for (let i = 0; i < 200; i++) {
    const d = Math.abs(shadeFor(i + 1).light - shadeFor(i).light);
    if (d < smallest) smallest = d;
  }
  assert.ok(smallest > 1.5, `neighbouring blocks differ by only ${smallest.toFixed(2)}%`);
});

test('the band still turns around rather than running away', () => {
  const lights = Array.from({ length: 200 }, (_, i) => shadeFor(i).light);
  assert.ok(Math.min(...lights) >= SHADE_MIN - 1e-9);
  assert.ok(Math.max(...lights) <= SHADE_MAX + 1e-9);
});

test('every block is a visibly different shade from its neighbour', () => {
  // The band used to sweep over 26 blocks, so neighbours differed by about 2.5%
  // — a real difference that nobody could see. A short triangle now drives the
  // per-block step.
  let smallest = Infinity;
  for (let i = 0; i < 400; i++) {
    smallest = Math.min(smallest, Math.abs(shadeFor(i + 1).light - shadeFor(i).light));
  }
  assert.ok(smallest >= 4, `neighbours differ by only ${smallest.toFixed(2)}%`);
});

test('the tower does not settle into repeating the same few shades', () => {
  // A short sweep on its own would cycle through five values forever. A slow
  // drift on a coprime period keeps producing new ones up a tall tower.
  const seen = new Set(Array.from({ length: 60 }, (_, i) => Math.round(shadeFor(i).light)));
  assert.ok(seen.size >= 20, `only ${seen.size} distinct shades in 60 blocks`);
});

test('both layers together stay inside the safe range', () => {
  // The whole point of the range is that nothing vanishes against black or
  // washes out — stacking a drift on top of the sweep must not break that.
  for (let i = -40; i < 600; i++) {
    const l = shadeFor(i).light;
    assert.ok(l >= SHADE_MIN - 1e-9 && l <= SHADE_MAX + 1e-9, `${l} at ${i} is out of range`);
  }
});

test('the plinth below the base gets the same treatment as the tower', () => {
  // It is drawn with negative indices; a modulo that mishandled those would
  // give the base blocks shades from outside the range.
  for (let i = -1; i >= -20; i--) {
    const f = faceShades(i);
    assert.ok(f.top >= SHADE_MIN - 1e-9 && f.top <= SHADE_MAX + 1e-9, `plinth ${i} -> ${f.top}`);
    assert.ok(f.top - f.right > 6 && f.right - f.left > 4, `plinth ${i} has no shading`);
  }
});
