// Support tickets and the operator actions on stuck money.
//
// These move real balances and expose one player's transactions to staff, so
// the things worth pinning are: money never moves without being asked, one
// player can never reach another's data, and an alert storm cannot bury the
// alert that matters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const adminSrc   = read('routes/admin.js');
const supportSrc = read('routes/support.js');
const alert      = require('../src/services/alertService');

// ── Operator actions ──────────────────────────────────────────────────────

test('every action is explicit — none of them credit by default', () => {
  // Several stuck states mean the player was ALREADY paid. A single "fix it"
  // button that always credited would pay twice.
  assert.match(adminSrc, /const ACTIONS = new Set\(\['credit', 'deduct', 'mark_sent', 'decline'\]\)/);
  const fn = adminSrc.slice(adminSrc.indexOf("router.post('/transactions/:id/resolve'"));
  assert.match(fn, /if \(!ACTIONS\.has\(action\)\)/, 'an unknown action must be refused, not guessed');
  assert.match(fn, /if \(action === 'credit'\) \{ await creditCoins/);
  assert.match(fn, /if \(action === 'deduct'\) \{ await deductCoins/);
  // mark_sent and decline must not touch a balance at all.
  const moveBlock = fn.slice(fn.indexOf('let moved = 0;'), fn.indexOf('if (moved !== 0)'));
  assert.ok(!/mark_sent|decline/.test(moveBlock),
    'mark_sent and decline record an outcome — they must never move money');
});

test('an amount is required before money moves', () => {
  const fn = adminSrc.slice(adminSrc.indexOf("router.post('/transactions/:id/resolve'"));
  assert.match(fn, /\(action === 'credit' \|\| action === 'deduct'\) && amt <= 0/,
    'crediting zero silently resolves a row while paying nothing');
});

test('resolving claims the row before moving money, and rolls back', () => {
  const fn = adminSrc.slice(adminSrc.indexOf("router.post('/transactions/:id/resolve'"));
  const claim = fn.indexOf('status: outcome');
  const move  = fn.indexOf('await creditCoins(');
  assert.ok(claim > 0 && move > claim, 'claim first, move second');
  assert.match(fn, /if \(!claimed\?\.length\) return res\.status\(409\)/,
    'two admins clicking at once must not both pay');
  const rollback = fn.slice(fn.indexOf('} catch (e) {'));
  assert.match(rollback.slice(0, 400), /update\(\{ status: tx\.status \}\)/,
    'a failed move must put the row back in the queue');
});

test('a manual credit leaves its own audit row', () => {
  const fn = adminSrc.slice(adminSrc.indexOf("router.post('/transactions/:id/resolve'"));
  assert.match(fn, /notes: 'admin ' \+ action \+ ' for transaction ' \+ tx\.id/,
    'the audit row must reference the original, or the next operator cannot tell it was settled');
});

test('context tells the operator whether it was already paid', () => {
  // The difference between owing someone and having already paid them is the
  // whole question, and it must not be answered from memory.
  const fn = adminSrc.slice(adminSrc.indexOf("router.get('/transactions/:id/context'"));
  assert.match(fn, /alreadyCredited/);
  assert.match(fn, /balance:/,  'the current balance is the sanity check');
  assert.match(fn, /explorer:/, 'an on-chain link beats trusting our own row');
});

// ── Tickets ───────────────────────────────────────────────────────────────

test('a player can only read their own ticket', () => {
  // These routes run on the service key, which bypasses RLS — so ownership has
  // to be enforced in the query itself.
  const fn = supportSrc.slice(supportSrc.indexOf("router.get('/tickets/:id'"));
  assert.match(fn, /\.eq\('id', req\.params\.id\)\.eq\('user_id', req\.user\.id\)/,
    'without the user_id filter any ticket id would read any player\'s thread');
});

test('a ticket cannot be attached to someone else\'s transaction', () => {
  // Otherwise a ticket could be pointed at another player's withdrawal and its
  // details read back through the admin view.
  const fn = supportSrc.slice(supportSrc.indexOf("router.post('/tickets'"));
  assert.match(fn, /\.eq\('id', req\.body\.transactionId\)\.eq\('user_id', req\.user\.id\)/);
});

test('replying reopens a closed ticket', () => {
  // If a reply could not reopen, a player whose problem was not actually fixed
  // has to raise a second ticket and lose the history.
  const fn = supportSrc.slice(supportSrc.indexOf("router.post('/tickets/:id/reply'"));
  assert.match(fn, /status: 'open'/);
});

test('a staff reply hands the ticket back rather than closing it', () => {
  const fn = adminSrc.slice(adminSrc.indexOf("router.post('/support/tickets/:id/reply'"));
  assert.match(fn, /req\.body\?\.close \? 'closed' : 'awaiting_user'/,
    'closing on reply forces the player to open a new ticket to continue');
});

test('open tickets are capped, but not so low it blocks a real problem', () => {
  assert.match(supportSrc, /MAX_OPEN_TICKETS = 5/);
  const fn = supportSrc.slice(supportSrc.indexOf("router.post('/tickets'"));
  assert.match(fn, /neq\('status', 'closed'\)/, 'closed tickets must not count toward the cap');
});

// ── Alerting ──────────────────────────────────────────────────────────────

test('money owed alerts on the first occurrence', () => {
  // payout_uncertain belongs here, not in WARNING: the coins are deducted and
  // deliberately not refunded, so a single one is a player who is out of pocket
  // until somebody reads the tx_hash. Waiting for three of those is not a thing
  // to do to one real person.
  assert.deepEqual(alert.CRITICAL, ['refund_failed', 'payout_failed', 'payout_uncertain', 'withdraw_failed']);
  assert.ok(alert.WARN_AT > 1,
    'self-healing states should alert in bulk, not one at a time');
});

test('a persistent problem does not alert every sweep', async () => {
  // A fault that takes a day to fix would otherwise produce 96 identical
  // alerts, and then every alert gets ignored.
  const rows = [{ id: 'a', status: 'refund_failed', amount_c: 5, created_at: new Date().toISOString() }];
  const db = { from: () => ({ select: () => ({ in: () => ({ limit: () => Promise.resolve({ data: rows }) }) }) }) };

  const seen = [];
  const origErr = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  await alert.sweepOnce(db);
  await alert.sweepOnce(db);
  await alert.sweepOnce(db);
  console.error = origErr;

  const alerts = seen.filter(l => l.includes('alert:critical'));
  assert.equal(alerts.length, 1, `same fault alerted ${alerts.length} times across three sweeps`);
});

test('a clean sweep re-arms, so the next fault is not swallowed', async () => {
  const empty = { from: () => ({ select: () => ({ in: () => ({ limit: () => Promise.resolve({ data: [] }) }) }) }) };
  const bad = { from: () => ({ select: () => ({ in: () => ({ limit: () => Promise.resolve({
    data: [{ id: 'b', status: 'refund_failed', amount_c: 9, created_at: new Date().toISOString() }] }) }) }) }) };

  await alert.sweepOnce(empty);           // clears the signature
  const seen = [];
  const origErr = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  await alert.sweepOnce(bad);
  console.error = origErr;
  assert.ok(seen.some(l => l.includes('alert:critical')),
    'a fault after a clean sweep must alert even if it looks like an earlier one');
});
