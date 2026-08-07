// Coin Flip settles the moment the server picks a side, so the displayed
// balance moved while the coin was still spinning and gave the result away.
// The money still settles immediately; only the DISPLAY is deferred.
//
// The dangerous failure here is not a missed refresh — it is a hold that leaks,
// which would freeze the balance across the whole site. So the leak paths are
// tested as carefully as the happy path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const holdSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'balanceHold.js'), 'utf8');

// The module is ESM in the frontend; evaluate it here without a bundler.
function loadHold() {
  const body = holdSrc
    .replace(/export function/g, 'function')
    .replace(/export /g, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return { holdBalance, isBalanceHeld, onBalanceRelease };`)();
}

test('a hold defers, and releasing lets the refresh through', () => {
  const { holdBalance, isBalanceHeld, onBalanceRelease } = loadHold();
  let released = 0;
  onBalanceRelease(() => released++);

  assert.equal(isBalanceHeld(), false, 'nothing held to begin with');
  const release = holdBalance();
  assert.equal(isBalanceHeld(), true, 'the flip is playing, so the display is held');
  release();
  assert.equal(isBalanceHeld(), false, 'the coin landed');
  assert.equal(released, 1, 'the deferred refresh must be signalled exactly once');
});

test('releasing twice does not unbalance the counter', () => {
  const { holdBalance, isBalanceHeld } = loadHold();
  const release = holdBalance();
  release();
  release();                       // unmount after the timer already released
  assert.equal(isBalanceHeld(), false);
});

test('overlapping holds only release once everything is done', () => {
  const { holdBalance, isBalanceHeld, onBalanceRelease } = loadHold();
  let released = 0;
  onBalanceRelease(() => released++);

  const a = holdBalance();
  const b = holdBalance();
  a();
  assert.equal(isBalanceHeld(), true, 'still held while the second is outstanding');
  assert.equal(released, 0, 'must not signal early');
  b();
  assert.equal(isBalanceHeld(), false);
  assert.equal(released, 1);
});

test('a hold that is never released expires on its own', async () => {
  const { holdBalance, isBalanceHeld } = loadHold();
  holdBalance(60);                 // caller vanishes without releasing
  assert.equal(isBalanceHeld(), true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(isBalanceHeld(), false,
    'a leaked hold must expire, or the balance freezes site-wide until reload');
});

test('the reveal finishes before the hold is released', () => {
  // The coin lands at 4200ms and the result screen shows at 6200ms; the release
  // has to sit on the later of the two or the balance still moves mid-spin.
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'CoinFlipGame.jsx'), 'utf8');
  const landAt = Number(page.match(/setResultLanded\(true\).*?\}, (\d+)\)\)/s)[1]);
  const releaseBlock = page.slice(page.indexOf('releaseBalanceRef.current?.();',
    page.indexOf('setResultData(res)') - 400));
  const showAt = Number(page.match(/setPhase\('result'\);[\s\S]{0,200}?\}, (\d+)\)\)/)[1]);
  assert.ok(showAt >= landAt,
    `release at ${showAt}ms must not precede the coin landing at ${landAt}ms`);
  assert.ok(/releaseBalanceRef\.current\?\.\(\)/.test(releaseBlock),
    'the hold must be released when the result screen appears');
});

test('BalanceSync defers rather than dropping a change', () => {
  const sync = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'BalanceSync.jsx'), 'utf8');
  assert.ok(/isBalanceHeld\(\)/.test(sync), 'it must check for a hold');
  assert.ok(/pendingRef\.current = true/.test(sync),
    'a change arriving during a hold must be remembered, not discarded');
  assert.ok(/onBalanceRelease\(/.test(sync),
    'and replayed once the hold lifts, or the balance stays stale');
});

test('leaving mid-flip releases the hold', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'CoinFlipGame.jsx'), 'utf8');
  const cleanup = page.slice(page.indexOf("socket.off('coin_flip_result')") - 400,
                             page.indexOf("socket.off('coin_flip_result')") + 80);
  assert.ok(/releaseBalanceRef\.current\?\.\(\)/.test(cleanup),
    'unmounting mid-flip must release, not wait for the safety timer');
});
