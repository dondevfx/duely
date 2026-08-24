// The fiat withdrawal route.
//
// It shares every guard with the crypto route and differs only in what it
// validates and what it hands the money to. Nothing can pay out today —
// fiatConfig.ENABLED is empty and both provider adapters throw — which is the
// point: the route is written and tested BEFORE an approval lands, so enabling
// a rail later is a config change against tested code rather than new code
// written in a hurry against a deadline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const WALLET = strip(read('src', 'routes', 'wallet.js'));
const fiatCfg = require('../src/services/fiatConfig');

function route() {
  const at = WALLET.indexOf("router.post('/withdraw-fiat'");
  assert.notEqual(at, -1, 'the fiat withdrawal route is gone');
  const end = WALLET.indexOf("router.get('/estimate-withdrawal'", at);
  assert.notEqual(end, -1, 'could not bound the route');
  return WALLET.slice(at, end);
}

// ── Guards are shared, not copied ──────────────────────────────────────────

test('both withdrawal routes run the same guards', () => {
  // Two near-identical copies of one rule is how ETH and BNB ended up on
  // different API keys. These decide whether a person may take money out at
  // all, which has nothing to do with which rail carries it.
  const crypto = WALLET.slice(
    WALLET.indexOf("router.post('/withdraw'"),
    WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(crypto, /await withdrawalGuards\(req\)/, 'the crypto route must use the shared guards');
  assert.match(route(), /await withdrawalGuards\(req\)/, 'so must the fiat route');
});

test('the shared guards still cover every case', () => {
  const fn = WALLET.slice(
    WALLET.indexOf('async function withdrawalGuards'),
    WALLET.indexOf("router.post('/withdraw'"));
  assert.match(fn, /isDemo\(/,               'demo accounts cannot withdraw');
  assert.match(fn, /email_confirmed_at/,     'email must be verified');
  assert.match(fn, /aal2/,                   'MFA step-up must be enforced server-side');
  assert.match(fn, /isLocked\(/,             'not while in a match');
  assert.match(fn, /activeWithdrawals\.has/, 'one withdrawal at a time');
});

// ── Nothing is live ────────────────────────────────────────────────────────

test('no fiat method is enabled yet', () => {
  assert.equal(fiatCfg.ENABLED.size, 0,
    'a method enabled before a provider exists is a button that deducts and then fails');
  assert.equal(fiatCfg.withdrawMethods().length, 0);
});

test('an un-enabled method is refused before anything is touched', () => {
  const r = route();
  const check = r.indexOf('canWithdraw(method)');
  const lock  = r.indexOf('activeWithdrawals.add');
  assert.ok(check !== -1 && lock !== -1, 'the check or the lock is gone');
  assert.ok(check < lock,
    'validation must run before the in-flight lock, or a rejected request bars the player until restart');
});

// ── Money ordering ─────────────────────────────────────────────────────────

test('identity is checked before the balance moves', () => {
  const r = route();
  assert.ok(r.indexOf('kycApproved(') < r.indexOf('deductCoins('),
    'a payout to someone unidentified is the one that cannot be undone');
});

test('the identity check fails closed', () => {
  // A missing column, an unreadable profile and an error all have to mean "no".
  const fn = WALLET.slice(
    WALLET.indexOf('async function kycApproved'),
    WALLET.indexOf('async function withdrawalGuards'));
  assert.match(fn, /catch\s*\{\s*return false;/, 'an error must not read as approved');
  assert.match(fn, /=== 'approved'/, 'only an explicit approval counts');
});

test('coins are deducted before the payout is submitted', () => {
  const r = route();
  assert.ok(r.indexOf('deductCoins(') < r.indexOf('providerFor(method).send('),
    'otherwise the balance can be spent while a payout is in flight');
});

// ── The refund decision ────────────────────────────────────────────────────

test('only a payout that certainly never left is refunded', () => {
  // The same distinction chainSend needed for Solana. A timeout may or may not
  // have created a real payout, and refunding on the error alone pays twice.
  const r = route();
  assert.match(r, /e\.submitted === false/,
    'the refund must be gated on the request definitely not having been sent');
  const uncertain = r.slice(r.indexOf('CRITICAL: fiat payout outcome unknown'));
  assert.ok(!/creditCoins/.test(uncertain), 'an unknown outcome must not refund');
  assert.match(uncertain, /payout_uncertain/, 'it needs its own status and a person');
});

test('a failed refund is escalated rather than swallowed', () => {
  const r = route();
  assert.match(r, /refund_failed/, 'coins owed with no automatic path need a person');
  assert.match(r, /CRITICAL: fiat payout refund failed/);
});

// ── Recording and watching ─────────────────────────────────────────────────

test('a submitted payout is recorded as sending, not confirmed', () => {
  // Handing a payout to a provider is not delivery. The watcher decides which
  // it becomes.
  const r = route();
  assert.match(r, /status: 'sending'/,
    "'confirmed' would claim a delivery we have no evidence of");
  assert.ok(!/status: 'confirmed'/.test(r), 'nothing here may claim delivery');
});

test('the row is written before the watcher starts', () => {
  // The watcher claims that row before acting, so without it a failure has
  // nothing to claim.
  const r = route();
  const insert = r.indexOf('const { error: recErr }');
  const watch  = r.indexOf('payoutWatcher.watch(');
  assert.ok(insert !== -1 && watch !== -1, 'the insert or the watch is gone');
  assert.ok(insert < watch, 'the row must exist first');
  assert.match(r.slice(watch - 200, watch), /!recErr/,
    'a row that failed to insert must not be watched');
});

test('a submitted payout that cannot be recorded says so', () => {
  const r = route();
  assert.match(r, /CRITICAL: fiat payout SUBMITTED but not recorded/,
    'the money has gone and the row has not — that needs a person');
});

// ── Destination validation ─────────────────────────────────────────────────

// Destination checking lives in validateDestination, which sits ABOVE the
// route — so these read that function, not the route body. Slicing the route
// and asserting against it found nothing and failed for the wrong reason.
function destinationFn() {
  const at = WALLET.indexOf('function validateDestination');
  assert.notEqual(at, -1, 'validateDestination is gone');
  const end = WALLET.indexOf("router.post('/withdraw-fiat'", at);
  assert.notEqual(end, -1, 'could not bound validateDestination');
  return WALLET.slice(at, end);
}

test('a bank destination is checked properly, not just for shape', () => {
  assert.match(destinationFn(), /validateBankDetails\(/,
    'a routing number has a checksum, and a typo caught here is a payout that never goes wrong');
});

test('the account number is masked before it reaches a record', () => {
  assert.match(destinationFn(), /maskAccountNumber\(/,
    'a full account number does not belong in a notes field an operator reads');
});

test('a wallet destination requires an email', () => {
  const fn = WALLET.slice(
    WALLET.indexOf('function validateDestination'),
    WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(fn, /paypal|venmo/, 'both wallet rails must be handled');
  assert.match(fn, /@/, 'an address is the destination for both');
});

test('an unknown method cannot reach a provider', () => {
  const fn = WALLET.slice(
    WALLET.indexOf('function validateDestination'),
    WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(fn, /Unsupported withdrawal method/,
    'a method with no destination shape must be refused, not passed through');
});
