// Deposit idempotency.
//
// Payment gateways retry aggressively. The webhook must be able to receive the
// same delivery several times at once and move funds exactly once. This models
// the two orderings against a store that enforces the unique index on extra_id,
// which is what makes the claim atomic.
const test = require('node:test');
const assert = require('node:assert/strict');

function makeStore({ unique = true } = {}) {
  const rows = [];
  return {
    rows,
    insert(row) {
      if (unique && row.extra_id && rows.some((r) => r.extra_id === row.extra_id)) {
        return { error: { code: '23505', message: 'duplicate key value' } };
      }
      rows.push({ ...row });
      return { error: null };
    },
    find(uuid) { return rows.find((r) => r.extra_id === uuid); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// What the code used to do: look, then act, then record.
async function checkThenAct(store, uuid, effects) {
  if (store.find(uuid)) return 'skipped';
  await tick();                       // creating the swap — a network round trip
  effects.swaps++;
  store.insert({ extra_id: uuid, status: 'converting' });
  await tick();
  effects.payouts++;                  // real crypto leaves here
  return 'processed';
}

// What it does now: claim the id first, and only the winner moves funds.
async function claimThenAct(store, uuid, effects) {
  const { error } = store.insert({ extra_id: uuid, status: 'claiming' });
  if (error) return error.code === '23505' ? 'skipped' : 'error';
  await tick();
  effects.swaps++;
  await tick();
  effects.payouts++;
  return 'processed';
}

test('claim-first moves funds exactly once under concurrent delivery', async () => {
  const store = makeStore();
  const effects = { swaps: 0, payouts: 0 };
  const results = await Promise.all([
    claimThenAct(store, 'gateway-uuid', effects),
    claimThenAct(store, 'gateway-uuid', effects),
    claimThenAct(store, 'gateway-uuid', effects),
  ]);
  assert.equal(effects.payouts, 1, `three simultaneous deliveries issued ${effects.payouts} payouts`);
  assert.equal(effects.swaps, 1, `three simultaneous deliveries created ${effects.swaps} swaps`);
  assert.equal(results.filter((r) => r === 'processed').length, 1);
});

test('the old check-then-act ordering really did double-spend', async () => {
  // Kept as a live demonstration: if someone reintroduces this shape, this test
  // documents exactly what it costs.
  const store = makeStore();
  const effects = { swaps: 0, payouts: 0 };
  await Promise.all([
    checkThenAct(store, 'gateway-uuid', effects),
    checkThenAct(store, 'gateway-uuid', effects),
    checkThenAct(store, 'gateway-uuid', effects),
  ]);
  assert.ok(effects.payouts > 1,
    'this ordering is expected to double-spend — if it no longer does, the model is wrong');
});

test('the unique index is load-bearing, not a nicety', async () => {
  // Same new ordering, but with no unique constraint behind it. The claim stops
  // being atomic and the race returns, which is why the migration matters.
  const store = makeStore({ unique: false });
  const effects = { swaps: 0, payouts: 0 };
  await Promise.all([
    claimThenAct(store, 'gateway-uuid', effects),
    claimThenAct(store, 'gateway-uuid', effects),
    claimThenAct(store, 'gateway-uuid', effects),
  ]);
  assert.ok(effects.payouts > 1,
    'without the unique index on transactions(extra_id) the claim cannot be atomic');
});

test('a second delivery arriving later is skipped', async () => {
  const store = makeStore();
  const effects = { swaps: 0, payouts: 0 };
  assert.equal(await claimThenAct(store, 'uuid-a', effects), 'processed');
  assert.equal(await claimThenAct(store, 'uuid-a', effects), 'skipped');
  assert.equal(effects.payouts, 1);
});

test('a genuinely different deposit is not mistaken for a retry', async () => {
  const store = makeStore();
  const effects = { swaps: 0, payouts: 0 };
  await claimThenAct(store, 'uuid-a', effects);
  await claimThenAct(store, 'uuid-b', effects);
  assert.equal(effects.payouts, 2, 'two distinct deposits must both be paid');
});

test('the webhook signature check is constant-time', () => {
  // A plain === leaks how many leading characters matched, which is how a
  // signature gets forged one byte at a time.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'cryptomusService.js'), 'utf8');
  assert.ok(src.includes('timingSafeEqual'),
    'verifyWebhook must compare signatures with crypto.timingSafeEqual');
});
