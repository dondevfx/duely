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
  assert.match(block, /CRITICAL/,
    'losing this row means a player is owed money nobody is tracking; it must be loud');
});

test('the failure log carries what is needed to recover by hand', () => {
  const at = CODE.indexOf('could not record the converting row');
  assert.notEqual(at, -1, 'the failure log is gone');
  const line = CODE.slice(at, at + 500);
  for (const [what, re] of [
    ['the exchange id', /swap\.exchangeId/],
    ['the user',        /\$\{userId\}/],
    ['the amount',      /\$\{netAmount\}/],
    ['the reason',      /convErr\.message/],
  ]) {
    assert.match(line, re, `the log must name ${what}, or recovery means guessing`);
  }
});

test('a failed insert does not stop the watch', () => {
  // The coins are already at ChangeNow by this point, so there is nothing to
  // undo. Bailing out here would guarantee the loss it is trying to report.
  const at = CODE.indexOf('could not record the converting row');
  const after = CODE.slice(at, CODE.indexOf('}', CODE.indexOf('convErr.message', at)) + 400);
  assert.ok(!/\breturn\b/.test(after),
    'returning early abandons a swap whose coins have already been sent');
  assert.match(CODE.slice(at), /watch\(swap\.exchangeId/,
    'the in-memory watch must still start, so it credits if the process survives');
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
