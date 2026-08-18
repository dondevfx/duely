// Which coins may be deposited.
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
  path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
const FRONTEND = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Wallet.jsx'), 'utf8');

const backendDepositCoins = () => {
  const m = BACKEND.match(/DEPOSIT_COINS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'DEPOSIT_COINS not found');
  return new Set([...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]));
};

// The frontend deposit grid, ignoring commented-out entries.
const frontendDepositCoins = () => {
  const at = FRONTEND.indexOf('const COINS = [');
  assert.notEqual(at, -1, 'the deposit coin grid is gone');
  const end = FRONTEND.indexOf('];', at);
  assert.notEqual(end, -1, 'could not bound the deposit coin grid');
  const body = FRONTEND.slice(at, end)
    .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
  return new Set([...body.matchAll(/id:\s*'(\w+)'/g)].map(x => x[1]));
};

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

test('BNB can still be withdrawn', () => {
  // Withdrawals send USDC to ChangeNow, which does the conversion. They never
  // read a BSC explorer, so the detection problem does not touch them —
  // removing BNB from withdrawals would strand anyone holding a balance.
  const at = FRONTEND.indexOf('const WITHDRAW_COINS');
  assert.notEqual(at, -1, 'the withdrawal coin list is gone');
  const block = FRONTEND.slice(at, FRONTEND.indexOf('];', at));
  assert.match(block, /id:\s*'bnb'/, 'BNB withdrawals are unaffected and must stay');
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
