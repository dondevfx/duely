// Watching a fiat payout until it lands, or until a person needs to look.
//
// Same machine as the ChangeNow withdrawal watcher, different status map, and
// the same governing rule: handing money to a provider is not delivery. A
// payout nobody watches is a payout that fails quietly.
//
// It does NOT refund, for the reason already settled on the crypto side — a
// returned ACH and an unclaimed PayPal payout mean different things, and the
// state alone cannot tell you which deserves the coins back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fiat = require('../src/services/fiatPayouts');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const WATCHER = strip(read('src', 'services', 'payoutWatcher.js'));
const ADMIN   = strip(read('src', 'routes', 'admin.js'));

// ── The status map ─────────────────────────────────────────────────────────

test('PayPal states map to the five we act on', () => {
  const m = fiat.providers.paypal.map;
  assert.equal(m('SUCCESS'),    'settled');
  assert.equal(m('PENDING'),    'pending');
  assert.equal(m('PROCESSING'), 'pending');
  assert.equal(m('RETURNED'),   'returned');
  assert.equal(m('DENIED'),     'returned');
  assert.equal(m('REVERSED'),   'returned');
});

test('UNCLAIMED is its own state, not folded into success or failure', () => {
  // The one that matters. The recipient has no account, the money sits with
  // the provider for ~30 days, and it may yet be collected. Reading it as
  // failure refunds a player who is about to be paid; reading it as success
  // marks delivered something that never arrived.
  const m = fiat.providers.paypal.map;
  assert.equal(m('UNCLAIMED'), 'unclaimed');
  assert.notEqual(m('UNCLAIMED'), 'settled');
  assert.notEqual(m('UNCLAIMED'), 'returned');
});

test('an unrecognised state is unknown, never assumed', () => {
  // A provider adding a status must not silently become "delivered".
  const m = fiat.providers.paypal.map;
  assert.equal(m('SOME_NEW_STATUS'), 'unknown');
  assert.equal(m(''), 'unknown');
  assert.equal(m(undefined), 'unknown');
});

// ── Windows and pacing ─────────────────────────────────────────────────────

test('overdue is per rail, because one number is meaningless', () => {
  // ACH over a weekend is slower than ACH on a Tuesday, and a PayPal payout
  // sitting unclaimed is not late at all.
  const day = 86400000;
  assert.ok(fiat.overdueMsFor('bank') >= 5 * day, 'ACH needs room for a weekend');
  assert.ok(fiat.overdueMsFor('paypal') > 30 * day,
    'the window must outlast the ~30-day unclaimed period, or every unclaimed payout is called failed');
});

test('polling backs off, or a long window is unaffordable', () => {
  // 32 days at 30-second intervals is ~92,000 calls for one payout.
  const d = fiat.pollDelay;
  assert.ok(d(0) <= 60_000, 'the first minutes should be quick — wallets land there');
  assert.ok(d(2 * 86400000) >= 60 * 60_000, 'a payout days old should be checked hourly at most');
  assert.ok(d(2 * 86400000) > d(0), 'delay must grow with age');
});

// ── What it does with each state ───────────────────────────────────────────

test('a returned payout is flagged, never auto-refunded', () => {
  const at = WATCHER.indexOf("state === 'returned'");
  assert.notEqual(at, -1, 'the returned branch is gone');
  const branch = WATCHER.slice(at, at + 700);
  assert.match(branch, /withdraw_failed/, 'it must land somewhere a person will see');
  assert.ok(!/creditCoins/.test(WATCHER),
    'the watcher must never credit — that decision belongs to an operator');
});

test('an unclaimed payout keeps being watched rather than judged', () => {
  const at = WATCHER.indexOf("state === 'unclaimed'");
  assert.notEqual(at, -1);
  const branch = WATCHER.slice(at, at + 900);
  assert.match(branch, /overdueMsFor/, 'it must stay watched while the window is open');
  assert.match(branch, /schedule\(/, 'and be re-scheduled rather than resolved');
});

test('an unreachable provider is not a failed payout', () => {
  // The distinction that stops an outage from refunding every payout at once.
  const at = WATCHER.indexOf('could not read');
  assert.notEqual(at, -1);
  const branch = WATCHER.slice(at, at + 600);
  assert.match(branch, /payout_uncertain/, 'an unknown outcome has its own status');
  assert.ok(!/withdraw_failed/.test(branch),
    'a provider we cannot reach has not told us the payout failed');
});

test('nothing resolves twice', () => {
  // Two polls, or a poll racing the restart resume.
  const fn = WATCHER.slice(WATCHER.indexOf('async function claim'), WATCHER.indexOf('async function poll'));
  assert.match(fn, /\.eq\('status', 'sending'\)/,
    'only a row still in flight may be settled');
  assert.match(fn, /\.select\('id, amount_c, user_id'\)/,
    'the claim must report whether it actually took the row');
});

test('payouts resume after a restart', () => {
  const fn = WATCHER.slice(WATCHER.indexOf('function init'), WATCHER.indexOf('const methodOf'));
  assert.match(fn, /\.eq\('status', 'sending'\)/);
  assert.match(fn, /watch\(/, 'and are handed back to the watcher');
});

// ── It reaches an operator ─────────────────────────────────────────────────

test('an in-flight payout is not treated as stale after an hour', () => {
  // 'converting' is stale after 60 minutes because a swap should be quick. ACH
  // takes days. Sharing that window would fill the queue with healthy payouts
  // and bury the real failures.
  assert.match(ADMIN, /SENDING_STALE_MS/, 'fiat needs its own staleness window');
  const m = ADMIN.match(/SENDING_STALE_MS = ([^;]+);/);
  assert.ok(m, 'SENDING_STALE_MS is gone');
  assert.ok(eval(m[1]) >= 3 * 86400000,   // eslint-disable-line no-eval -- our own constant
    'the backstop must outlast a normal ACH, or it fires on every healthy payout');
});

test('a payout in flight is still visible if the watcher dies', () => {
  const listed = ADMIN.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1];
  assert.ok(listed.includes("'sending'"),
    'if the watcher stops, these rows must still surface rather than sitting forever');
});

test('the admin page labels it', () => {
  const ui = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Admin.jsx'), 'utf8');
  assert.match(ui, /sending:\s*\{ label:/, 'a raw status is not an operator-facing label');
});

// ── Providers ──────────────────────────────────────────────────────────────

test('an unconfigured provider refuses rather than pretending', () => {
  // A stub returning a plausible success would be worse than nothing: it would
  // mark payouts delivered that were never sent.
  assert.equal(fiat.isConfigured('bank'), false);
  assert.rejects(() => fiat.providerFor('bank').send({}), /not configured/i);
  assert.rejects(() => fiat.providerFor('paypal').status('x'), /not configured/i);
});

test('every withdrawable method has a provider mapped', () => {
  const fc = require('../src/services/fiatConfig');
  for (const [name, m] of Object.entries(fc.METHODS)) {
    if (!m.withdraw) continue;
    assert.ok(fiat.RAIL_PROVIDER[name],
      `${name} can be withdrawn to but has no payout provider — the route would accept it and then have nothing to send with`);
  }
});
