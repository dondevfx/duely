// What happens to a withdrawal AFTER we hand the USDC to ChangeNow.
//
// Nothing did. The row was marked 'confirmed' the moment the USDC left our
// wallet and then forgotten — but handing coins to an exchange is not delivery.
// They still have to convert and pay out, and that can fail, expire or refund.
//
// When it did, the player's coins were already deducted, no crypto arrived, and
// our records said the withdrawal had gone fine. Silent, and discoverable only
// by complaint — the same shape as every deposit bug in this codebase.
//
// It is now watched and flagged. It is deliberately NOT auto-refunded: see the
// failure-path tests below for why that looks right and is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const POLLER = strip(read('src', 'services', 'swapPoller.js'));
const WALLET = strip(read('src', 'routes', 'wallet.js'));
const ADMIN  = strip(read('src', 'routes', 'admin.js'));

// ── The row says what is actually true ─────────────────────────────────────

test("a ChangeNow withdrawal is not 'confirmed' until it is delivered", () => {
  // 'confirmed' has to mean DELIVERED. Marking it on send makes the record a
  // statement about our outbound transfer, not about the player receiving
  // anything — and the two differ exactly when it matters.
  assert.match(WALLET, /status:\s*pending \? 'converting' : 'confirmed'/,
    'an exchange still converting must not be recorded as a completed withdrawal');
});

test('a direct payout is still confirmed immediately', () => {
  // SOL, USDC and USDT are delivered by the time their send returns. Making
  // them wait on a poller that has nothing to poll would leave them pending
  // forever.
  assert.match(WALLET, /let exchangeId = null;/, 'the exchange id is not tracked');
  assert.match(WALLET, /const pending = Boolean\(exchangeId\)/,
    'only the ChangeNow path should be treated as in flight');
});

test('the exchange id is stored, not just logged', () => {
  // It was only ever in a console line. Without it in the row, neither the
  // poller nor support can find the conversion again after a restart.
  assert.match(WALLET, /exchangeId = swap\.exchangeId/);
  assert.match(WALLET, /tx_hash:\s*String\(pending \? exchangeId : payoutId\)/,
    'the row must carry the exchange id for a conversion still in flight');
});

test('the watcher starts only once the row exists', () => {
  // The poller claims that row before acting on it. Watching before it is
  // written means a failure has nothing to claim.
  const insertAt = WALLET.indexOf('const { error: recErr }');
  const watchAt  = WALLET.indexOf('watchWithdrawal(exchangeId');
  assert.ok(insertAt !== -1 && watchAt !== -1, 'the insert or the watch is gone');
  assert.ok(insertAt < watchAt, 'the row must exist before the conversion is watched');
  assert.match(WALLET.slice(watchAt - 200, watchAt), /!recErr/,
    'a row that failed to insert must not be watched');
});

// ── The failure path ───────────────────────────────────────────────────────

test('a failed conversion is flagged, NOT auto-refunded', () => {
  // An automatic refund looks obviously right and is not. ChangeNow's terminal
  // statuses do not all mean the same thing to us: 'refunded' means the crypto
  // is coming BACK to our address, 'failed' can include a payout that partly
  // went, 'expired' usually means nothing moved. Crediting on all three would
  // sometimes pay a player who already holds their crypto, and a wrong refund
  // is real money gone with nothing to reverse it.
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  assert.match(fn, /\['failed', 'refunded', 'expired'\]\.includes\(result\.status\)/,
    'every terminal failure must be handled, not just one');
  assert.match(fn, /'withdraw_failed'/, 'it must be flagged for a decision');
  assert.ok(!/creditCoins/.test(fn),
    'the poller must not refund on its own — the status alone cannot tell these cases apart');
});

test('the flag carries what a person needs to decide', () => {
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  assert.match(fn, /ChangeNow reported/, 'the notes must say what ChangeNow actually said');
  assert.match(fn, /exchange=\$\{exchangeId\}/, 'the exchange id is how it is looked up');
  assert.match(fn, /NOT auto-refunded/,
    'the row must be explicit that the coins are still deducted');
});

test('flagging cannot happen twice for one failure', () => {
  // Two polls of the same exchange, or a poll racing the restart-resume.
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  const claim = fn.slice(fn.indexOf("status: 'withdraw_failed'"));
  assert.match(claim.slice(0, 400), /\.eq\('status', 'converting'\)/,
    'only a row still converting may be flagged');
});

test('an unresolved conversion is left alone, not assumed failed', () => {
  // A conversion still running after a day has not told us it failed.
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  const timeout = fn.slice(fn.indexOf('MAX_WAIT_MS'));
  assert.match(timeout.slice(0, 600), /'stuck'/, 'it must be flagged for review');
  assert.ok(!/creditCoins/.test(timeout.slice(0, 600)),
    'a timeout is not evidence of failure');
});

// ── Surviving a restart ────────────────────────────────────────────────────

test('withdrawals are resumed after a restart, not just deposits', () => {
  // Railway restarts on every deploy. An unwatched withdrawal that fails leaves
  // the coins deducted with nothing delivered.
  const fn = POLLER.slice(POLLER.indexOf('function init'), POLLER.indexOf('function watch('));
  assert.match(fn, /\.in\('type', \['deposit', 'withdrawal'\]\)/,
    'the resume query must cover both');
  assert.match(fn, /watchWithdrawal\(/, 'and dispatch them to the right watcher');
});

// ── It reaches a human ─────────────────────────────────────────────────────

test('a failed withdrawal reaches the attention queue near the top', () => {
  // Coins are deducted and nothing is coming automatically, so it outranks
  // everything except money already known to be owed.
  const listed = ADMIN.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1]
    .split(',').map(x => x.trim().replace(/'/g, ''));
  const at = listed.indexOf('withdraw_failed');
  assert.notEqual(at, -1, 'a failed withdrawal must be visible to an operator');
  assert.ok(at <= 1, "it holds a player's money — it belongs at the top");
});

test('it alerts on the first occurrence', () => {
  // Anchored on the constant and bounded by length, rather than split on a
  // newline. Writing this file through a shell turned the newline ESCAPE into a
  // real newline three times over, which splits the string literal and makes
  // the whole file a syntax error — and a test that cannot parse asserts
  // nothing at all.
  const alerts = read('src', 'services', 'alertService.js');
  const critAt = alerts.indexOf('const CRITICAL');
  assert.notEqual(critAt, -1, 'the CRITICAL list is gone');
  assert.match(alerts.slice(critAt, critAt + 200), /withdraw_failed/,
    'one player unable to withdraw is not something to sit on until three accumulate');
});

test('the admin page labels it and offers a choice', () => {
  const ui = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Admin.jsx'), 'utf8');
  assert.match(ui, /withdraw_failed:\s*\{ label:/, 'it needs a human-readable label, not a raw status');
  // The decision itself: pay them back, or record that they were paid after all.
  assert.match(ui, /onResolve\('credit'/, 'Refund');
  assert.match(ui, /onResolve\('mark_sent'/, 'Money arrived');
  assert.match(ui, /onResolve\('decline'/, 'Decline');
  assert.match(ui, /useState\(String\(tx\.amount_c/,
    'the amount must be prefilled, or every refund is retyped from the row above it');
});
