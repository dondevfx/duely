// What the deposit monitor costs to run.
//
// Detection is only as good as the provider allowance behind it. Every coin
// used to be polled on the same 45-second pass — a number chosen for nothing
// in particular — so a hot address cost 80 requests an hour whether its chain
// produced a block every 12 seconds or every 10 minutes.
//
// BlockCypher's free tier is about 100 requests an hour in total, so one player
// on the Litecoin deposit page took most of it and a Litecoin plus a Dogecoin
// depositor exceeded it. Past the limit the provider errors, and deposits stop
// being detected while real money is arriving.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const monitor = require('../src/services/blockchainMonitor');
const { coinDueThisPass, COIN_EVERY_PASSES } = monitor;
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');

const PASS_MS = 45_000;
const PASSES_PER_HOUR = 3_600_000 / PASS_MS;

// Requests one hot address of this coin makes in an hour.
const perHour = (coin) => {
  let n = 0;
  for (let p = 0; p < PASSES_PER_HOUR; p++) if (coinDueThisPass(coin, p)) n++;
  return n;
};

test('the poll interval is still the one this budget assumes', () => {
  // Every number below is derived from it. If it changes, these stop meaning
  // anything and should fail rather than quietly mislead.
  assert.match(SRC, /const POLL_INTERVAL_MS\s*=\s*45_000/,
    'the poll interval moved — the request budget in this file needs recomputing');
  assert.match(SRC, /const SWEEP_EVERY_PASSES = 480/,
    'the sweep cadence moved — the idle budget needs recomputing');
});

test('BlockCypher stays inside its free tier with two depositors', () => {
  // The measured failure. ltc and doge are the coins it serves outright; btc
  // reaches it only when blockstream is down.
  const both = perHour('ltc') + perHour('doge');
  assert.ok(both <= 60,
    `${both} requests/hour against a ~100/hour allowance leaves no headroom ` +
    `for the btc fallback or a retry`);

  // And the worst case, with blockstream down so btc falls through too.
  const worst = both + perHour('btc');
  assert.ok(worst < 100,
    `${worst} requests/hour exceeds the allowance when blockstream is down`);
});

test('detection latency stays within a few minutes on every coin', () => {
  // The player-facing promise, and the honest ceiling — not block time.
  //
  // A deposit is treated as confirmed at one confirmation, so the wait a player
  // actually experiences is the chain's own confirmation time PLUS up to one
  // poll interval. The poll interval is the only half we control, and a few
  // minutes on top of a chain that already takes minutes is not noticeable.
  //
  // An earlier version of this test used block time as the ceiling and failed
  // Dogecoin for being polled every 3 minutes against 1-minute blocks. That was
  // the test being wrong: 3 minutes of extra latency is fine, and polling
  // Dogecoin 80 times an hour is what breaks the provider allowance.
  const MAX_ADDED_LATENCY_S = 6 * 60;
  for (const coin of Object.keys(COIN_EVERY_PASSES)) {
    const everySec = COIN_EVERY_PASSES[coin] * (PASS_MS / 1000);
    assert.ok(everySec <= MAX_ADDED_LATENCY_S,
      `${coin} adds up to ${everySec}s to a deposit — past what a player will sit through`);
  }
});

test('slow chains are not polled at the speed of fast ones', () => {
  // The waste this exists to remove: Bitcoin makes a block every ten minutes,
  // so polling it every 45 seconds spends 13 of every 14 requests asking a
  // chain that has not moved — and those requests come out of the same
  // allowance the coins that need it are drawing on.
  assert.ok(COIN_EVERY_PASSES.btc >= 4,
    'bitcoin does not need asking every 45 seconds');
  assert.ok(COIN_EVERY_PASSES.ltc >= 2 && COIN_EVERY_PASSES.doge >= 2,
    'the BlockCypher coins are the ones whose allowance is tightest');
  assert.ok(perHour('btc') < perHour('eth'),
    'a ten-minute chain should cost less per hour than a twelve-second one');
});

test('a sweep asks about everything, whatever the cadence says', () => {
  // The cadence is an optimisation for hot addresses. The sweep is the backstop
  // that catches a player who saved an address weeks ago and sent to it without
  // opening the page — it has to see every address, or that deposit is lost.
  const fn = SRC.slice(SRC.indexOf('async function pollOnce'), SRC.indexOf('const SWEEP_INTERVAL_MS') === -1
    ? SRC.indexOf('async function sweepStrandedUsdc')
    : SRC.indexOf('async function sweepStrandedUsdc'));
  const guarded = fn.slice(fn.indexOf('if (!sweeping) {'), fn.indexOf('const byCoin'));
  assert.match(guarded, /coinDueThisPass/,
    'the cadence must be applied only inside the non-sweep branch');
});

test('every coin is due on pass zero, so a restart checks everything at once', () => {
  // The first pass after boot sweeps, and pass 0 is also due for every cadence.
  // A coin that was not due on the first pass would wait its full interval
  // after every deploy, and Railway redeploys often.
  for (const coin of Object.keys(COIN_EVERY_PASSES)) {
    assert.ok(coinDueThisPass(coin, 0), `${coin} is not polled on the first pass`);
  }
});

test('an unknown coin is polled every pass rather than never', () => {
  // Failing the other way would silently stop detecting a newly added coin.
  assert.equal(coinDueThisPass('somenewcoin', 1), true);
  assert.equal(coinDueThisPass('somenewcoin', 7), true);
});

test('the idle cost is a handful of requests a day', () => {
  // With nobody depositing, only the sweep runs: four passes a day over every
  // address. This is the number that has to stay small, because it is paid
  // whether or not anyone is using the site.
  const sweepsPerDay = (86_400_000 / PASS_MS) / 480;
  assert.equal(sweepsPerDay, 4);
  const addresses = 23;                       // live rows today
  assert.ok(sweepsPerDay * addresses < 200,
    'the idle poll cost has grown past a few hundred requests a day');
});

test('Solana is heard from, not asked, while webhooks are on', () => {
  // The expensive one. Polling Solana addresses on every pass is what burned
  // an entire month of RPC credits; a webhook is both faster and free.
  const fn = SRC.slice(SRC.indexOf('async function pollOnce'), SRC.indexOf('const byCoin'));
  assert.match(fn, /heliusOn && SOL_COINS\.has/,
    'solana coins must be skipped on non-sweep passes when webhooks are carrying them');
});
