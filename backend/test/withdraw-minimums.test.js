// Withdrawal minimums: ours, and the provider's.
//
// Ours is $5 for every coin except BTC, whose network fee is a real fraction
// of a small payout.
//
// ChangeNow has its own floor per coin, it moves with the destination
// network's fees, and it is routinely higher than $5 for ETH. Lowering our
// floor without consulting theirs does not make small withdrawals work — it
// makes them fail LATER, after the coins are deducted, in the payout path that
// then has to refund. The player sees "Payout failed" and a raw provider error
// for something we could have told them before they pressed the button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const WALLET  = strip(read('src', 'routes', 'wallet.js'));
const SERVICE = strip(read('src', 'services', 'simpleSwapService.js'));
const FRONT   = strip(fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Wallet.jsx'), 'utf8'));

function mins(src) {
  const m = src.match(/WITHDRAW_MINS\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'WITHDRAW_MINS not found');
  const out = {};
  for (const kv of m[1].matchAll(/(\w+):\s*([\d.]+)/g)) out[kv[1]] = parseFloat(kv[2]);
  return out;
}

test('every coin except BTC is $5', () => {
  const m = mins(WALLET);
  assert.equal(m.default, 5, 'the default floor must be $5');
  assert.equal(m.btc, 10, 'BTC keeps $10 — its network fee is too large a share of $5');
});

test('the front end quotes the same numbers as the server enforces', () => {
  // A page advertising $5 while the API rejects under $10 is a button that
  // looks enabled and cannot work.
  assert.deepEqual(mins(FRONT), mins(WALLET),
    'the advertised minimum and the enforced minimum must be the same numbers');
});

test("the provider's live floor is checked before any coins move", () => {
  const checkAt  = WALLET.indexOf('getWithdrawalMinUsd(');
  const deductAt = WALLET.indexOf('await deductCoins(supabase, req.user.id, amount)');
  assert.notEqual(checkAt, -1, 'nothing asks ChangeNow their minimum');
  assert.ok(checkAt < deductAt,
    'checking after the deduction means a rejected withdrawal has to be refunded instead of never starting');
});

test('an unreachable provider does not block every withdrawal', () => {
  // Failing closed here would take the whole site's withdrawals down whenever
  // ChangeNow has a bad minute.
  const fn = SERVICE.slice(SERVICE.indexOf('async function getWithdrawalMinUsd'),
                           SERVICE.indexOf('async function estimateDeposit'));
  assert.match(fn, /catch\s*\{\s*return 0;/, 'an unknown minimum must return 0, not throw');

  const guard = WALLET.slice(WALLET.indexOf('const liveMin'), WALLET.indexOf('const liveMin') + 400);
  assert.match(guard, /liveMin > 0 &&/, '0 must mean "no opinion", not "minimum of zero"');
});

test('it asks for the withdrawal direction, not the deposit one', () => {
  // getMinAmount is coin→USDC. A payout is USDC→coin, and the two floors are
  // different numbers.
  const fn = SERVICE.slice(SERVICE.indexOf('async function getWithdrawalMinUsd'),
                           SERVICE.indexOf('async function estimateDeposit'));
  assert.match(fn, /\$\{BASE_STABLE\}_\$\{ticker\}/,
    'the pair must be USDC→coin; the reverse is the deposit minimum');
});

test('the rejection tells the player what to do', () => {
  const guard = WALLET.slice(WALLET.indexOf('const liveMin'), WALLET.indexOf('const liveMin') + 700);
  assert.match(guard, /\$\$\{liveMin/, 'it must name the actual number required');
  assert.match(guard, /USDC or SOL/, 'and point at the coins with no swap in the path');
});
