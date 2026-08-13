// Deposit detection latency is a product of the loop's shape, not of any one
// API being slow.
//
// Every user gets an address per coin, and the poll used to walk the whole list
// as a single sequence with one flat delay between entries. So a BTC lookup
// queued behind every SOL address and vice versa, despite hitting unrelated
// providers — a pass cost users x coins x delay, and detection got slower with
// every signup rather than staying flat.
//
// Guarded by reading the source, since this is the arrangement of the loop
// rather than a computable result. Comments are stripped first: an earlier test
// in this repo passed against its own prose instead of the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const pollOnce = src.slice(src.indexOf('async function pollOnce'));

// Parse the delay map out of the source. It is module-private, and exporting it
// only so a test can read it would be worse than reading it here.
const DELAYS = eval(
  '(' + src.slice(
    src.indexOf('{', src.indexOf('const COIN_DELAY_MS')),
    src.indexOf('}', src.indexOf('const COIN_DELAY_MS')) + 1
  ) + ')'
);

test('coins are polled in parallel, not behind one another', () => {
  assert.match(pollOnce, /Promise\.all/,
    'coin groups hit unrelated providers — serialising them buys nothing');
  assert.match(pollOnce, /byCoin/, 'addresses must be grouped by coin before polling');
});

test('addresses within a coin stay staggered', () => {
  // Parallelising across providers is free; parallelising within one is what
  // trips a rate limit. The stagger has to survive.
  const pollCoin = src.slice(src.indexOf('async function pollCoin'), src.indexOf('async function pollOnce'));
  assert.match(pollCoin, /setTimeout\(r, delay\)/, 'the per-address delay must remain');
  assert.doesNotMatch(pollCoin, /Promise\.all/, 'addresses of one coin share a provider');
});

test('the delay is per provider rather than one number for all of them', () => {
  // BlockCypher caps hourly as well as per second, so it stays the slow one.
  for (const coin of ['btc', 'ltc', 'doge']) {
    assert.equal(DELAYS[coin], 500, `${coin} must keep BlockCypher's spacing`);
  }
  // If every provider wanted the same spacing we would have kept one constant.
  assert.ok(new Set(Object.values(DELAYS)).size > 1, 'delays must differ by provider');
  for (const [coin, ms] of Object.entries(DELAYS)) {
    assert.ok(ms > 0, `${coin} must keep some spacing`);
  }
});

test('every polled coin has an explicit delay', () => {
  // A coin missing from the map silently falls back to the slowest setting, so
  // adding a coin and forgetting the delay costs latency with no error.
  //
  // Checked against the parsed map rather than by searching the file: several
  // other per-coin objects live in here (gasReserveMap among them) and a loose
  // regex would happily match one of those and pass while the map was empty.
  const dispatchStart = src.indexOf('async function fetchTxs');
  const dispatch = src.slice(dispatchStart, src.indexOf('}', src.indexOf('switch (coin)', dispatchStart)));
  const coins = [...dispatch.matchAll(/case '(\w+)':/g)].map(m => m[1]);
  assert.ok(coins.length >= 7, `expected the full coin dispatch, found ${coins.length}`);

  for (const coin of coins) {
    assert.ok(coin in DELAYS, `${coin} is polled but has no entry in COIN_DELAY_MS`);
  }
});

test('a pass that outruns its interval says so', () => {
  // Growth past this fix is a rate-limit problem, and it should be visible
  // before players start reporting slow deposits.
  assert.match(pollOnce, /POLL_INTERVAL_MS/);
  assert.match(pollOnce, /console\.warn/);
});
