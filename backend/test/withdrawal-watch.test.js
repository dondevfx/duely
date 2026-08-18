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
// A deposit that fails means we never took the money. A withdrawal that fails
// means we took it and delivered nothing, so this path REFUNDS.
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
  const at = WALLET.indexOf('let exchangeId = null;');
  assert.notEqual(at, -1, 'the exchange id is not tracked');
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
  // The poller claims that row before refunding. Watching before it is written
  // means a failure has nothing to claim, and the refund could run repeatedly.
  const insertAt = WALLET.indexOf('const { error: recErr }');
  const watchAt  = WALLET.indexOf('watchWithdrawal(exchangeId');
  assert.ok(insertAt !== -1 && watchAt !== -1, 'the insert or the watch is gone');
  assert.ok(insertAt < watchAt, 'the row must exist before the conversion is watched');
  assert.match(WALLET.slice(watchAt - 200, watchAt), /!recErr/,
    'a row that failed to insert must not be watched');
});

// ── The failure path ───────────────────────────────────────────────────────

test('a failed conversion refunds the player', () => {
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  assert.match(fn, /\['failed', 'refunded', 'expired'\]\.includes\(result\.status\)/,
    'every terminal failure must be handled, not just one');
  assert.match(fn, /creditCoins\(/, 'the player must get their coins back');
});

test('the refund cannot run twice', () => {
  // Two polls of the same exchange, or a poll racing the restart-resume, would
  // otherwise both refund — handing back the stake twice for one failure.
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  const claim = fn.slice(fn.indexOf("update({ status: 'refunding' })"));
  assert.match(claim.slice(0, 300), /\.eq\('status', 'converting'\)/,
    'the claim must only take a row that is still converting');
  assert.match(claim.slice(0, 500), /if \(!claimed\?\.length\)/,
    'only the poll that actually flipped the row may refund');
});

test('a refund that itself fails is escalated', () => {
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  assert.match(fn, /'refund_failed'/,
    'coins owed with no automatic path to deliver them need a person');
  assert.match(fn, /CRITICAL/);
});

test('an unresolved conversion is NOT refunded automatically', () => {
  // A conversion still running after a day has not told us it failed. Refunding
  // one that later completes pays the player twice.
  const fn = POLLER.slice(POLLER.indexOf('async function pollWithdrawal'));
  const timeout = fn.slice(fn.indexOf('MAX_WAIT_MS'));
  assert.match(timeout.slice(0, 600), /'stuck'/, 'it must be flagged for review');
  assert.ok(!/creditCoins/.test(timeout.slice(0, 600)),
    'a timeout is not evidence of failure, and refunding on it can pay twice');
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

test('a stalled refund reaches the attention queue', () => {
  // 'refunding' is transient by design. One sitting there means the process
  // died between claiming the row and crediting, and the player is owed.
  const listed = ADMIN.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1];
  assert.ok(listed.includes("'refunding'"),
    'a refund that stalled mid-flight is money owed and must be visible');
});
