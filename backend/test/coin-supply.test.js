// "Total coins in circulation" on the admin page was summing c_coins across
// every row in profiles — demo accounts and the admin account itself
// included. Both distort the number: demo accounts play for free, so their
// balance is not real money owed to anyone, and the admin balance is
// collected rake, not a player's holding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
const ADMIN = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8'));

function coinSupplyRoute() {
  const at = ADMIN.indexOf("router.get('/coin-supply'");
  assert.notEqual(at, -1, 'the coin-supply route is gone');
  return ADMIN.slice(at, ADMIN.indexOf('});', at) + 3);
}

test('demo accounts are excluded from coins-in-circulation', () => {
  assert.match(coinSupplyRoute(), /filterDemos\(query\)/,
    'demo balances are not real money owed to anyone and must not inflate this number');
});

test('the admin account itself is excluded', () => {
  assert.match(coinSupplyRoute(), /\.neq\('id', process\.env\.ADMIN_USER_ID\)/,
    'the admin balance is collected rake, not a player holding — counting it here overstates circulation');
});

test('the old unfiltered sum_c_coins RPC path is gone, not just bypassed', () => {
  // The RPC sums every row at the database level with no way to pass it an
  // exclusion list — keeping it as a "fallback" would silently reintroduce
  // the exact bug being fixed the moment the primary path ever errored.
  assert.ok(!/rpc\(\s*'sum_c_coins'/.test(coinSupplyRoute()),
    'sum_c_coins cannot exclude demo/admin accounts and must not be called here in any form');
});
