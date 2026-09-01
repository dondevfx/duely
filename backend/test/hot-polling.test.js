// Polling on intent instead of on a timer, for the five chains that have no
// webhook here.
//
// Solana got pushed deliveries, so an idle Solana address costs nothing.
// BlockCypher, Etherscan and TronGrid are asked and never tell, so they need
// the other answer to the same problem: nobody announces a deposit, but they
// do announce the intent to make one by opening the deposit page and picking a
// coin. That is the only signal there is, and it was being ignored — every
// address ever issued was polled every 45 seconds forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const monitor = require('../src/services/blockchainMonitor');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const SRC = read('src', 'services', 'blockchainMonitor.js');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const WALLET = read('src', 'routes', 'wallet.js');

test('an address nobody asked for is not hot', () => {
  assert.equal(monitor.isHot('nobody', 'btc'), false);
});

test('asking for an address makes it hot', () => {
  monitor.markActive('u1', 'btc');
  assert.equal(monitor.isHot('u1', 'btc'), true);
});

test('hot is per coin, not per player', () => {
  // A player looking at the BTC tab tells us nothing about their LTC address,
  // and polling all eight because they opened one would give back most of the
  // saving.
  monitor.markActive('u2', 'btc');
  assert.equal(monitor.isHot('u2', 'btc'), true);
  assert.equal(monitor.isHot('u2', 'ltc'), false);
});

test('the coin is matched case-insensitively', () => {
  // The route lowercases, the table stores lowercase, but a key mismatch here
  // would fail silently — the address would simply never be hot, and the only
  // symptom is a deposit noticed six hours late.
  monitor.markActive('u3', 'BTC');
  assert.equal(monitor.isHot('u3', 'btc'), true);
});

test('hot expires', () => {
  const realNow = Date.now;
  monitor.markActive('u4', 'eth');
  assert.equal(monitor.isHot('u4', 'eth'), true);
  try {
    Date.now = () => realNow() + 3 * 60 * 60 * 1000;   // two hours is the window
    assert.equal(monitor.isHot('u4', 'eth'), false);
  } finally {
    Date.now = realNow;
  }
});

test('the window is generous enough for an exchange withdrawal', () => {
  // A withdrawal from an exchange can sit pending for an hour before it is
  // even broadcast. Thirty minutes would expire while the player is still
  // waiting on Coinbase, and the symptom is a confirmed deposit going
  // unnoticed until the next sweep.
  assert.match(CODE, /HOT_MS = 2 \* 60 \* 60 \* 1000/);
});

test('the hot set is bounded', () => {
  // Expired entries are dropped on read, but an address that is never polled
  // again is never read — so without a ceiling a long-running process holds
  // every key it has ever seen.
  //
  // Driven rather than pattern-matched: the first version of this test only
  // asserted the source contained the size check, and passed happily when the
  // check was disabled, because the same text also appears on the line below
  // it. Filling the map past the cap is the only thing that tells them apart.
  const CAP = 10_000;
  for (let i = 0; i < CAP + 500; i++) monitor.markActive(`bulk${i}`, 'btc');
  // Every key here is live, so nothing can be dropped for being expired — the
  // ceiling is the only thing holding this down.
  assert.ok(monitor.hotSize() <= CAP,
    `hot set grew to ${monitor.hotSize()}, past its ${CAP} ceiling`);
  // And the most recent entry survived the eviction: dropping what was just
  // added would defeat the point.
  assert.equal(monitor.isHot(`bulk${CAP + 499}`, 'btc'), true);
});

test('handing out an address is what marks it', () => {
  // The signal has to be wired to the one route that gives a player an
  // address, or the whole scheme silently degrades to sweep-only.
  const route = WALLET.slice(WALLET.indexOf("router.post('/get-address'"));
  assert.match(route.slice(0, 1200), /markActive\(req\.user\.id, coin\.toLowerCase\(\)\)/);
});

test('a non-sweep pass polls only what is hot', () => {
  const poll = CODE.slice(CODE.indexOf('async function pollOnce'));
  assert.match(poll, /if \(!sweeping\) \{/);
  assert.match(poll, /return isHot\(a\.user_id, a\.coin\)/);
});

test('Solana is left to its webhook during the hot window', () => {
  // A webhook is both faster than a 45-second poll and free, so polling
  // Solana while it is armed buys nothing and costs credits. With webhooks
  // off it becomes an ordinary chain again.
  const poll = CODE.slice(CODE.indexOf('async function pollOnce'));
  assert.match(poll, /if \(heliusOn && SOL_COINS\.has\(String\(a\.coin\)\.toLowerCase\(\)\)\) return false/);
});

test('the sweep still covers every chain', () => {
  // The backstop for what intent cannot see: an address saved weeks ago and
  // sent to without opening the page.
  assert.match(CODE, /SWEEP_EVERY_PASSES = 480/);
  const poll = CODE.slice(CODE.indexOf('async function pollOnce'));
  assert.match(poll, /const sweeping = \(_passNo % SWEEP_EVERY_PASSES\) === 0/);
  // On a sweep pass the list is untouched — no coin is filtered out of it.
  const filterAt = poll.indexOf('list = addresses.filter');
  const guardAt = poll.indexOf('if (!sweeping)');
  assert.ok(guardAt > 0 && filterAt > guardAt, 'the filter must sit inside the non-sweep branch');
});
