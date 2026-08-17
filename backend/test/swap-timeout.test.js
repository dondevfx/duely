// How long a swap is watched for, and what happens when it outlives that.
//
// The ceiling was one hour. A BTC deposit waits on TWO Bitcoin confirmations in
// sequence — ours forwarding to ChangeNow, then ChangeNow's own requirement —
// so an hour is routinely not enough.
//
// Timing out did not merely stop the clock, it stopped the POLLING. When
// ChangeNow finished twenty minutes later and sent the USDC, our wallet took
// delivery and nobody credited the player. The money arrived; the deposit
// stayed unpaid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'swapPoller.js'), 'utf8');

test('a swap is watched for longer than two Bitcoin confirmations take', () => {
  const m = SRC.match(/const MAX_WAIT_MS\s*=\s*([^;]+);/);
  assert.ok(m, 'MAX_WAIT_MS is gone');
  const ms = eval(m[1]);   // eslint-disable-line no-eval -- a constant expression from our own source
  const hours = ms / 3600000;
  assert.ok(hours >= 6,
    `watching for ${hours}h is shorter than a BTC deposit routinely takes, and giving up strands the credit`);
});

// Comments stripped. The first version of the test below matched the word
// 'stuck' anywhere in the claim block — and the comment ABOVE the claim
// explains the word 'stuck', so reverting the code still passed. A test that
// reads its own documentation proves nothing.
const CODE = SRC.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

test('a swap that finishes late is still credited', () => {
  // The claim previously required status 'converting'. Rows the old timeout had
  // already marked 'stuck' could never satisfy that, so even a resumed poll
  // would refuse to credit them.
  const claim = CODE.slice(CODE.indexOf(".update({ status: 'confirmed'"), CODE.indexOf(".select('id')"));
  assert.match(claim, /\.in\('status',\s*\[[^\]]*'stuck'/,
    'a row marked stuck by the old timeout must still be creditable when the swap completes');
  assert.match(claim, /'converting'/, 'the normal case must keep working');
});

test('abandoned swaps are picked up again on restart', () => {
  const resume = CODE.slice(CODE.indexOf('function init'), CODE.indexOf('function watch'));
  assert.match(resume, /\.in\('status',\s*\[[^\]]*'stuck'/,
    'without this, every swap the old one-hour timeout abandoned stays unpaid forever');
});

test('crediting stays single-claim, so waiting longer cannot pay twice', () => {
  // Relaxing the claim filter is the risky half of this change: widen it
  // carelessly and a resumed poll credits a row that was already paid.
  const claim = SRC.slice(SRC.indexOf('.update({ status: \'confirmed\''), SRC.indexOf('.select(\'id\')'));
  assert.ok(!/'confirmed'/.test(claim.replace("update({ status: 'confirmed'", '')),
    'an already-confirmed row must never be re-claimable, or the credit runs twice');
  assert.match(SRC, /if \(claimed && claimed\.length > 0\)/,
    'only the poll that actually flipped the row may credit');
});

test('polling backs off instead of hammering for a day', () => {
  assert.match(SRC, /function pollDelay/, 'a 24h ceiling at a fixed 30s is 2880 API calls per deposit');
  assert.match(SRC, /pollDelay\(Date\.now\(\) - startedAt\)/, 'the backoff must actually be used');
});

test('a genuinely failed swap still ends immediately', () => {
  // The long ceiling must only apply to swaps still legitimately running.
  assert.match(SRC, /\['failed', 'refunded', 'expired'\]\.includes\(result\.status\)/,
    'a terminal status must end the watch regardless of the ceiling');
});
