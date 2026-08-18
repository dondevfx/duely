// The row that says "a swap is in flight".
//
// It is the only record that coins were forwarded to ChangeNow and are owed
// back as USDC, and it is the ONLY thing swapPoller's restart-resume reads.
// Railway restarts the container on every deploy, so without it the watcher is
// lost — and when ChangeNow finishes, the USDC lands in our wallet with nobody
// left to credit the player.
//
// It was inserted with no error check, no log and no retry: the one row that
// must exist could silently fail to be written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
// Comment-stripped so an assertion cannot be satisfied by the prose above it.
const CODE = SRC.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

test('the converting row reports its own failure', () => {
  const at = CODE.indexOf("tx_hash: swap.exchangeId");
  assert.notEqual(at, -1, 'the converting insert is gone');
  // Start well BEFORE the insert: the result destructuring sits to the left of
  // both `insert(` and `await supabase`, so anchoring on either slices past the
  // very thing being checked. A fixed window backwards cannot make that mistake.
  const block = CODE.slice(Math.max(0, at - 400), at + 900);
  assert.match(block, /error:\s*convErr|const \{ error/,
    'the insert result must be inspected — a silent failure here loses the credit on the next restart');
  assert.match(block, /could not record the converting row/,
    'losing this row means a player is owed money nobody is tracking; it must be logged');
});

test('the failure log carries what is needed to diagnose it', () => {
  const at = CODE.indexOf('could not record the converting row');
  assert.notEqual(at, -1, 'the failure log is gone');
  const line = CODE.slice(at, at + 500);
  for (const [what, re] of [
    ['the deposit tx',  /\$\{txHash\}/],
    ['the user',        /\$\{userId\}/],
    ['the amount',      /\$\{netAmount\}/],
    ['the reason',      /convErr\.message/],
  ]) {
    assert.match(line, re, `the log must name ${what}, or recovery means guessing`);
  }
});

test('a failed insert stops the forward, so nothing is sent unrecorded', () => {
  // The insert runs BEFORE sendCrypto, so the coins are still in the player's
  // deposit address at this point. Forwarding anyway would send real money to
  // ChangeNow with no record that it is owed back — recoverable only from a log
  // line, and only until the container restarts.
  //
  // My first version of this fix continued past the failure on the belief the
  // coins had already gone. They had not. Checking the ORDER is what settles
  // it, so that is what this asserts.
  const insertAt = CODE.indexOf("tx_hash: swap.exchangeId");
  const sendAt   = CODE.indexOf('sendCrypto({ coin, privKey, toAddress: swap.depositAddress');
  assert.ok(insertAt !== -1 && sendAt !== -1, 'the insert or the forward is gone');
  assert.ok(insertAt < sendAt,
    'the record must be written before the coins move, or a failure cannot be made safe');

  const handler = CODE.slice(CODE.indexOf('if (convErr)'), sendAt);
  assert.match(handler, /return;/,
    'a deposit whose record could not be written must not be forwarded');
  assert.match(handler, /pending_retry/,
    'the claim must be handed back, or the deposit is never retried');
  assert.ok(!/_seenTxs\.add/.test(handler),
    'marking it seen would make a transient database failure permanent');
});

test('every insert in the deposit path is checked or explicitly best-effort', () => {
  // The pattern that caused this: `await supabase.from(...).insert({...});`
  // with the result thrown away. Best-effort inserts are fine when they are
  // marked as such with a .catch — silent ones are not.
  const inserts = [...CODE.matchAll(/await supabase\s*\.?\s*from\('transactions'\)\s*\.insert\(/g)];
  for (const m of inserts) {
    const tail = CODE.slice(m.index, m.index + 600);
    const checked = /const \{ error/.test(CODE.slice(Math.max(0, m.index - 120), m.index))
      || /\.catch\(/.test(tail)
      || /\.then\(\)/.test(tail);
    assert.ok(checked,
      `an unchecked transactions insert at offset ${m.index} — a silent failure here loses money tracking`);
  }
});

// ── The same discipline on the withdrawal side ─────────────────────────────
//
// The withdrawal success row also writes extra_id, so the index that ate the
// deposit could reject it too — and its insert result was discarded the same
// way. The payout has already gone on-chain by then, so a failure costs the
// audit trail rather than the money, but it still needs a human: the
// withdrawal appears in no history and counts toward no total.

test('a paid withdrawal that cannot be recorded says so', () => {
  const wallet = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8')
    .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

  // Anchored on the payout hash, which only the SUCCESS row carries. Matching
  // on type:'withdrawal' finds recordFailure first — a different insert, with
  // different (correct) handling — and the test then passes or fails for the
  // wrong reason.
  const at = wallet.indexOf('tx_hash:       String(payoutId)');
  assert.notEqual(at, -1, 'the withdrawal record insert is gone');
  const block = wallet.slice(Math.max(0, at - 400), at + 900);
  assert.match(block, /const \{ error/,
    'a discarded insert result is how the deposit went missing; the same shape is here');
  assert.match(block, /CRITICAL/,
    'a payout with no record needs a person, not a silent success');
});
