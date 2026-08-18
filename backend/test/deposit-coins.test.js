// Which coins may be deposited, and which may be withdrawn.
//
// A deposit address we hand out for a coin we cannot DETECT is money taken and
// never credited. That is not a bug that shows up as an error — the player
// sends real funds, the poller never sees them, and nothing anywhere says so.
//
// BNB is the live example: BSC detection needs a paid Etherscan plan, and the
// free tier answers "Free API access is not supported for this chain". The
// wallet page went on offering BNB deposits regardless.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'coinConfig.js'), 'utf8');
const MONITOR_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
const WALLET_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
const FRONTEND = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Wallet.jsx'), 'utf8');

const backendDepositCoins = () => {
  const m = BACKEND.match(/DEPOSIT_COINS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'DEPOSIT_COINS not found');
  return new Set([...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]));
};

// A coin list from the page, ignoring commented-out entries — a coin explained
// in a comment is not a coin on offer, and counting it would let a disabled one
// look enabled.
function coinsInList(constName) {
  const at = FRONTEND.indexOf(constName);
  assert.notEqual(at, -1, `${constName} is gone`);
  const end = FRONTEND.indexOf('];', at);
  assert.notEqual(end, -1, `could not bound ${constName}`);
  const body = FRONTEND.slice(at, end)
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  return new Set([...body.matchAll(/id:\s*'(\w+)'/g)].map(x => x[1]));
}

const frontendDepositCoins = () => coinsInList('const COINS = [');
const withdrawCoins        = () => coinsInList('const WITHDRAW_COINS');

test('the page offers exactly the coins the server will accept', () => {
  // Drift either way is a real failure: offering more than the server accepts
  // is a dead button, and accepting more than the page offers hides a coin
  // that works.
  assert.deepEqual([...frontendDepositCoins()].sort(), [...backendDepositCoins()].sort(),
    'the deposit coin list must be the same on both sides');
});

test('BNB is not offered for deposit while BSC detection is unavailable', () => {
  assert.ok(!backendDepositCoins().has('bnb'),
    'BSC detection needs a paid Etherscan plan — a BNB deposit would be taken and never credited');
  assert.ok(!frontendDepositCoins().has('bnb'),
    'the page must not offer it either');
});

test('BNB is gone from withdrawals too, replaced by USDT', () => {
  // Earlier BNB was deposit-disabled but left withdrawable, on the reasoning
  // that removing it would strand anyone holding a balance. That reasoning was
  // wrong: a balance is coins, not BNB — it can be withdrawn as USDC, SOL, BTC
  // or anything else still listed. Nobody is stranded.
  //
  // USDT takes its place and is strictly better here: one Jupiter swap on
  // Solana at near-1:1, against ChangeNow at several percent and two
  // confirmation waits.
  assert.ok(!withdrawCoins().has('bnb'), 'BNB is no longer offered for withdrawal');
  assert.ok(withdrawCoins().has('usdt'), 'USDT replaces it');
});

test('every withdrawable coin can actually be paid out', () => {
  // A coin on the page with no ticker is rejected by the route as unsupported —
  // a button that looks live and cannot work.
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'simpleSwapService.js'), 'utf8');
  const start = service.indexOf('SS_TICKERS = {');
  assert.notEqual(start, -1, 'SS_TICKERS is gone');
  const tickers = service.slice(start, service.indexOf('};', start));

  for (const coin of withdrawCoins()) {
    assert.ok(new RegExp('\\b' + coin + ':').test(tickers),
      `${coin} is offered for withdrawal but has no ticker — the route rejects it as unsupported`);
  }
});

test('every offered deposit coin has a detector', () => {
  // The rule the BNB case broke: if fetchTxs has no branch for a coin, nothing
  // can ever notice a deposit to it.
  const monitor = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  const dispatch = monitor.slice(monitor.indexOf('async function fetchTxs'));
  const handled = new Set([...dispatch.slice(0, 600).matchAll(/case '(\w+)'/g)].map(x => x[1]));
  for (const coin of backendDepositCoins()) {
    assert.ok(handled.has(coin), `${coin} is offered for deposit but fetchTxs has no branch for it`);
  }
});

// ── One list, two readers ──────────────────────────────────────────────────
//
// The deposit list lived in the HTTP route, so the blockchain monitor had no
// idea it existed and polled every address row in the table. Disabling BNB
// stopped new addresses being issued but left the poller warning about the old
// ones every 45 seconds, forever — burying every other message in the log.

test('the route and the monitor read the same list', () => {
  assert.match(WALLET_SRC, /require\('\.\.\/services\/coinConfig'\)/,
    'the route must not keep its own copy');
  assert.match(MONITOR_SRC, /require\('\.\/coinConfig'\)/,
    'the monitor must know which coins are still accepted');
});

test('disabled coins are not polled', () => {
  const fn = MONITOR_SRC.slice(MONITOR_SRC.indexOf('async function loadAddresses'),
                               MONITOR_SRC.indexOf('const COIN_DELAY_MS'));
  assert.match(fn, /DEPOSIT_COINS\.has/,
    'polling an address for a coin we no longer accept produces a warning nobody can act on');
});

test('a repeating explorer failure does not repeat in the log', () => {
  // A plan limit or an outage affects every address at once and does not change
  // between polls. One line per address per pass makes the log unreadable.
  const fn = MONITOR_SRC.slice(MONITOR_SRC.indexOf('function explorerMiss'),
                               MONITOR_SRC.indexOf('async function fetchEthTxs'));
  assert.match(fn, /MISS_REPEAT_MS/, 'identical failures must be throttled');
  assert.match(fn, /\$\{coin\}:\$\{String\(why\)/,
    'the reason must be part of the key, so a DIFFERENT failure still reports immediately');
});
