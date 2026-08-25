// "Sometimes cars fly down the screen so fast you can't react."
//
// Closing speed decides the only thing that matters for fairness in Rush
// Hour: how long a car is visible before it reaches you, which is
// VIEW_AHEAD / closing. The spawn multiplies difficulty, overdrive, a
// per-vehicle multiplier and a per-car random spread together, and that
// product had a floor but no ceiling. Measured at full difficulty and full
// overdrive, before the fix:
//
//   typical sedan   2060 u/s -> 286ms
//   fast sedan      2680 u/s -> 220ms
//   typical semi    2513 u/s -> 235ms
//   fastest semi    3270 u/s -> 180ms
//
// Human visual reaction time is around 250ms BEFORE any input begins, so
// roughly a third of cars in a late-run were not hard, they were impossible.
// CLOSE_HARD_MAX caps the tail without touching the spread — ordinary
// traffic, density and overtaking are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'HighwayCanvas.jsx'), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
const CODE = strip(SRC);

const num = (name) => {
  const m = SRC.match(new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`));
  assert.ok(m, `${name} not found`);
  return Number(m[1]);
};

const VIEW_AHEAD     = num('VIEW_AHEAD');
const CLOSE_MIN      = num('CLOSE_MIN');
const CLOSE_MAX      = num('CLOSE_MAX');
const OD_CLOSE       = num('OD_CLOSE');
const OD_SPEED_MAX   = num('OD_SPEED_MAX');
const CLOSE_HARD_MAX = num('CLOSE_HARD_MAX');

// Below this a car cannot be reacted to at all — it is not difficulty.
const HUMAN_REACTION_MS = 250;

test('the reaction floor is enforced by a real ceiling, not left to chance', () => {
  assert.match(CODE, /clamp\(closingBase \* v\.close \* \(0\.72 \+ rand\(\) \* 0\.62\), 90, CLOSE_HARD_MAX\)/,
    'the spawn must clamp closing speed at both ends — a floor alone is what let the tail through');
});

test('same-lane reordering cannot push a car back past the ceiling', () => {
  // The ordering pass can only RAISE closing (slowing a car to sit behind a
  // slower neighbour), which would undo the spawn clamp.
  assert.match(CODE, /if \(closing > CLOSE_HARD_MAX\)/,
    'a car pushed past the ceiling by lane ordering must be rejected, not shipped');
});

test('the fastest car the spawn can produce is still reactable', () => {
  const worstBase = CLOSE_MIN + (CLOSE_MAX - CLOSE_MIN) * 1.0 + OD_SPEED_MAX * OD_CLOSE;
  const semiMult = 1.22;          // the heaviest closing multiplier in VEHICLES
  const maxRoll  = 0.72 + 0.62;   // the top of the random spread

  const uncapped = worstBase * semiMult * maxRoll;
  const capped   = Math.min(uncapped, CLOSE_HARD_MAX);

  const uncappedMs = (VIEW_AHEAD / uncapped) * 1000;
  const cappedMs   = (VIEW_AHEAD / capped) * 1000;

  assert.ok(uncappedMs < HUMAN_REACTION_MS,
    `the uncapped worst case should be unreactable (${uncappedMs.toFixed(0)}ms) — if it is not, this test is measuring the wrong thing`);
  assert.ok(cappedMs >= HUMAN_REACTION_MS,
    `the capped worst case must leave at least ${HUMAN_REACTION_MS}ms, got ${cappedMs.toFixed(0)}ms`);
});

test('ordinary mid-run traffic is untouched by the cap', () => {
  // The whole point: this clamps outliers, it does not slow the game down.
  // A typical sedan at mid-difficulty must be nowhere near the ceiling.
  const midBase = CLOSE_MIN + (CLOSE_MAX - CLOSE_MIN) * 0.5 + 3 * OD_CLOSE;
  const typicalSedan = midBase * 1.00 * (0.72 + 0.5 * 0.62);
  assert.ok(typicalSedan < CLOSE_HARD_MAX * 0.8,
    `typical mid-run traffic (${typicalSedan.toFixed(0)} u/s) must sit well clear of the ${CLOSE_HARD_MAX} ceiling, or the cap is changing normal play`);
});

test('the cap still allows genuinely fast cars', () => {
  // Not so low that the mode loses its edge — the ceiling should still be
  // meaningfully faster than an average car.
  const midBase = CLOSE_MIN + (CLOSE_MAX - CLOSE_MIN) * 0.5 + 3 * OD_CLOSE;
  const typicalSedan = midBase * 1.00 * (0.72 + 0.5 * 0.62);
  assert.ok(CLOSE_HARD_MAX > typicalSedan * 1.5,
    'the ceiling must leave real headroom above typical traffic, or fast cars stop existing');
});
