// The coin segment on the rewards wheel.
//
// It is drawn on every tier's wheel and was permanently unreachable in two
// separate places: its weight in the diamond roll was 0, AND the frontend's
// prizeToSegIdx explicitly excluded index 2 from ever being the landing
// segment. Both had to open for a real, if vanishingly small, chance to exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const REWARDS = read('src', 'routes', 'rewards.js');
const FE_REWARDS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Rewards.jsx'), 'utf8');

// Load the real roll function rather than re-implement it, so a change to the
// odds or the weights is caught here rather than only in a statistical spot
// check nobody re-runs.
function loadRollPrize() {
  const sandbox = {};
  const wrapped = REWARDS
    .replace(/require\([^)]*\)/g, '({})') // no real supabase/auth needed to build the roll
    + '\nmodule.exports = { rollPrize, COIN_ODDS, WEIGHTS, DIAMOND_IDX, TIER_PRIZES };';
  const Module = require('module');
  const m = new Module(path.join(__dirname, '..', 'src', 'routes', '__rewards_test__.js'));
  m._compile(wrapped, m.id);
  return m.exports;
}
const { rollPrize, COIN_ODDS, WEIGHTS, DIAMOND_IDX, TIER_PRIZES } = loadRollPrize();

test('the coin has real, nonzero odds', () => {
  assert.ok(COIN_ODDS > 0, 'a zero-odds coin is exactly the bug this replaced');
  assert.equal(COIN_ODDS, 1 / 100_000_000, 'the odds are set deliberately, not drifted into');
  assert.ok(COIN_ODDS <= 1 / 1_000_000,
    'this is meant to be a near-impossible novelty, not a real reward tier');
});

test('a coin win pays exactly 1 coin and lands on segment 2', () => {
  const forced = { random: Math.random };
  Math.random = () => 0; // below any positive COIN_ODDS threshold
  try {
    const r = rollPrize('bronze');
    assert.equal(r.kind, 'coins');
    assert.equal(r.amount, 1);
    assert.equal(r.segIdx, 2, 'segment 2 is where the coin graphic is drawn');
  } finally {
    Math.random = forced.random;
  }
});

test('every diamond segment keeps its original odds', () => {
  // Pinned so a future edit near the coin logic cannot silently reshuffle the
  // diamond weights it sits next to.
  assert.deepEqual(WEIGHTS, [20, 15, 15, 10, 15, 5, 20]);
  assert.equal(WEIGHTS.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(DIAMOND_IDX, [0, 1, 3, 4, 5, 6, 7],
    'these seven weights must map onto the seven non-coin segments, in order, skipping index 2');
});

test('a diamond roll never returns segment 2', () => {
  const forced = Math.random;
  Math.random = () => 0.999999; // never the coin branch
  try {
    for (let i = 0; i < 200; i++) {
      const r = rollPrize('bronze');
      assert.equal(r.kind, 'diamonds');
      assert.notEqual(r.segIdx, 2, 'the coin slot must only ever be reached by the coin branch');
    }
  } finally {
    Math.random = forced;
  }
});

test('every tier stays reachable and the coin value at index 2 is unused decoration', () => {
  for (const tier of Object.keys(TIER_PRIZES)) {
    assert.equal(TIER_PRIZES[tier].length, 8, `${tier} must keep 8 wedges — the wheel is drawn for 8`);
  }
});

test('the diamond credit path has no non-atomic fallback', () => {
  // The same race that bonus.js had: a manual read-add-write is not row-locked
  // like the cooldown stamp beside it, so two requests hitting a fallback in
  // the same instant could both read the same starting balance.
  const spin = REWARDS.slice(REWARDS.indexOf("router.post('/spin'"));
  assert.ok(!/diamonds:\s*\(cur\.diamonds/.test(spin),
    'a manual balance read-then-add-then-write must not exist here');
});

test('a coin win is credited through creditCoins, not the diamond RPC', () => {
  const spin = REWARDS.slice(REWARDS.indexOf("router.post('/spin'"));
  assert.match(spin, /roll\.kind === 'coins'/);
  assert.match(spin, /creditCoins\(supabase, req\.user\.id, roll\.amount\)/,
    'a coin win must not be paid out as 1 diamond');
});

test('the response tells the client which currency it is, not just a number', () => {
  const spin = REWARDS.slice(REWARDS.indexOf("router.post('/spin'"));
  assert.match(spin, /currency:\s*roll\.kind/,
    '1 coin and a diamond prize can look identical by value; the client must not have to guess');
  assert.match(spin, /segIdx:\s*roll\.segIdx/,
    'the client must be told which wedge actually won rather than inferring it');
});

// ── Frontend ─────────────────────────────────────────────────────────────

test('the frontend trusts the server-provided segment index', () => {
  assert.match(FE_REWARDS, /res\??\.segIdx/,
    'segIdx must be read from the server response, not inferred from the amount');
});

test('the frontend never guesses its way onto the coin segment', () => {
  const start = FE_REWARDS.indexOf('function prizeToSegIdx');
  const end   = FE_REWARDS.indexOf('\n}\n', start);
  const fn = FE_REWARDS.slice(start, end);

  // Both fallback searches — the value-match and the "closest" last resort —
  // must exclude index 2. Checked separately rather than "does this pattern
  // appear somewhere", which a first attempt at this test got wrong: removing
  // ONLY the first exclusion still passed, because the second one (further
  // down the same function) kept the pattern present overall.
  const guardCount = (fn.match(/filter\(\(\{ i \}\) => i !== 2\)/g) || []).length;
  assert.equal(guardCount, 2,
    'both fallback paths (the value-match search and the closest-segment last ' +
    'resort) must exclude index 2 — only an explicit segIdx from the server may land there');
});

test('the win banner shows the right icon for the right currency', () => {
  assert.match(FE_REWARDS, /won\.currency === 'coins'/,
    'a coin win must not render with the diamond emoji');
});

test('a coin win updates c_coins, not diamonds', () => {
  const at = FE_REWARDS.indexOf('onPrizeWon={');
  assert.notEqual(at, -1, 'onPrizeWon wiring is gone');
  const wiring = FE_REWARDS.slice(at, at + 300);
  assert.match(wiring, /c_coins/, 'a coin prize must update the coin balance');
  assert.match(wiring, /diamonds/, 'a diamond prize must still update the diamond balance');
});
