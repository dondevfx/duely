// Stuck-money operator queue.
//
// The point of all this is that money can never go missing quietly. A failed
// withdrawal used to leave nothing but a console line, so it was recoverable
// only by scrolling logs — and the dashboard counter that was supposed to
// surface it looked for a status nothing ever wrote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const walletSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
const adminSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');

// ── Phase 1: failures are recorded ────────────────────────────────────────

test('a refunded withdrawal failure writes a row', () => {
  const block = walletSrc.slice(walletSrc.indexOf('} catch (payoutErr)'),
                               walletSrc.indexOf('// ── Record transaction'));
  assert.match(block, /recordFailure\('failed'/,
    'a payout that failed but refunded must still be recorded, or support cannot explain it');
});

test('a failed refund is recorded under its own status', () => {
  // This is the case where real money is owed to a real person. It must be
  // distinguishable from an ordinary failure, or it sinks into the same list.
  const block = walletSrc.slice(walletSrc.indexOf('} catch (payoutErr)'),
                               walletSrc.indexOf('// ── Record transaction'));
  assert.match(block, /recordFailure\('refund_failed'/);
  const critical = block.slice(block.indexOf('CRITICAL'));
  assert.match(critical, /recordFailure\('refund_failed'/,
    'the CRITICAL path must write a row, not only log');
});

test('the failure row carries the reason', () => {
  const block = walletSrc.slice(walletSrc.indexOf('const recordFailure'),
                                walletSrc.indexOf('const recordFailure') + 700);
  assert.match(block, /notes:\s*String\(err\)/,
    'without the error the row says something broke but not what');
  assert.match(block, /user_id:\s*req\.user\.id/);
  assert.match(block, /amount_c:\s*amount/, 'the amount owed is the whole point');
});

test('recording a failure cannot itself throw away the response', () => {
  // If the database is why the payout failed, the insert fails too. That must
  // not turn a handled failure into an unhandled one.
  const block = walletSrc.slice(walletSrc.indexOf('const recordFailure'),
                                walletSrc.indexOf('const recordFailure') + 700);
  assert.match(block, /\.catch\(/, 'the insert must be best-effort');
});

// ── Phase 2: the queue ────────────────────────────────────────────────────
//
// The claim-before-credit ordering and the opt-in nature of crediting are
// asserted in support-tickets.test.js against the action-based resolve endpoint
// that replaced the original. Duplicating them here would mean two tests of the
// same property, one of them written for a signature that no longer exists.

test('the attention queue covers every stuck state', () => {
  // Any status written by a failure path but missing here is money that is
  // stuck and invisible — the exact problem this exists to solve.
  const written = new Set();
  for (const f of ['services/blockchainMonitor.js', 'services/swapPoller.js',
                   'routes/webhooks.js', 'routes/wallet.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    for (const m of src.matchAll(/status:\s*'([a-z_]+)'/g)) written.add(m[1]);
    for (const m of src.matchAll(/update\(\{\s*status:\s*'([a-z_]+)'/g)) written.add(m[1]);
  }
  // 'refunded' is benign: a withdrawal whose conversion failed and whose refund
  // SUCCEEDED. The player has their coins back, so there is nothing to action.
  // The failure of that refund is 'refund_failed', which is top of the queue.
  const benign = new Set(['confirmed', 'paid', 'pending', 'claiming', 'forwarded',
                          'below_min', 'failed', 'resolved', 'accepted']);
  const stuck = [...written].filter(s => !benign.has(s));

  const listed = adminSrc.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1];
  for (const s of stuck) {
    assert.ok(listed.includes(`'${s}'`),
      `status '${s}' is written by a failure path but is not in the attention queue`);
  }
});

test('worst first, then oldest', () => {
  // payout_uncertain ranks second: the coins are deducted and deliberately not
  // refunded, because the player may already hold the crypto. So it is money
  // possibly owed, behind refund_failed which is money definitely owed, and
  // ahead of payout_failed where the refund already succeeded.
  // 'pending' ranks above payout_failed: a payout_failed row already refunded
  // successfully, so the player is whole, whereas a 'pending' withdrawal is a
  // state nothing currently writes — nothing will ever move it on, and the
  // coins may have been deducted without a payout.
  const rank = ['refund_failed', 'withdraw_failed', 'payout_uncertain', 'pending', 'payout_failed', 'stuck', 'pending_retry', 'converting'];
  const listed = adminSrc.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1]
    .split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(listed, rank, 'order encodes severity — the queue sorts by it');
  assert.match(adminSrc, /ATTENTION_RANK\[a\.status\] - ATTENTION_RANK\[b\.status\]/);
  assert.match(adminSrc, /new Date\(a\.created_at\) - new Date\(b\.created_at\)/,
    'a row broken for days outranks one broken a minute ago');
});

test('in-progress swaps are not treated as stuck', () => {
  // 'converting' is normal for a while. Listing it immediately fills the queue
  // with healthy deposits and buries the real failures.
  assert.match(adminSrc, /CONVERTING_STALE_MS/);
  assert.match(adminSrc, /t\.status !== 'converting'\s*\|\|/);
});

test('a failed credit puts the row back in the queue', () => {
  const fn = adminSrc.slice(adminSrc.indexOf("router.post('/transactions/:id/resolve'"));
  const catchBlock = fn.slice(fn.indexOf('} catch (e) {'));
  assert.match(catchBlock.slice(0, 400), /update\(\{ status: tx\.status \}\)/,
    'otherwise it looks dealt with when nothing was paid');
});

test('the dashboard counter no longer reads a status nothing writes', () => {
  // It queried status='pending' on withdrawals, which is never written, so it
  // showed zero forever while real failures piled up.
  assert.ok(!/eq\('type', 'withdrawal'\)\.eq\('status', 'pending'\)/.test(adminSrc),
    'that counter was permanently zero and hid exactly what it was meant to show');
  assert.match(adminSrc, /needs_attention:/);
});

// ── Stranded withdrawals ───────────────────────────────────────────────────
//
// A live database turned up one withdrawal sitting at status 'pending' — a
// status NOTHING in the current code writes. Left over from an older version,
// so no process will ever move it on, and it was invisible: not in the
// attention queue, not in the dashboard counter, not labelled in the UI.
//
// It is either a payout that happened and got recorded wrong, or coins that
// were deducted and never paid out. Only a human can tell, which is exactly
// what the attention queue is for.

test('a stranded withdrawal reaches the attention queue', () => {
  const listed = adminSrc.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1];
  assert.ok(listed.includes("'pending'"),
    "a withdrawal stuck at 'pending' is money that may be owed and nothing will ever move it on");
});

test('the dashboard counter counts it too', () => {
  // The queue and the badge read from separate lists, so one can surface a
  // problem the other hides.
  // Matched with a regex rather than a literal containing \n — this file is
  // checked out with CRLF endings, so a \n anchor silently matches nothing and
  // the test passes or fails for the wrong reason.
  const inLists = [...adminSrc.matchAll(/\.in\('status',\s*\[([^\]]*)\]/g)].map(m => m[1]);
  assert.ok(inLists.length > 0, "no .in('status', [...]) query found in admin.js");
  assert.ok(inLists.some(l => l.includes("'pending'")),
    'the badge must agree with the queue, or a real problem shows a count of zero');
});

test('nothing in the code writes a pending withdrawal', () => {
  // The reason it is treated as stranded rather than in-progress. If some path
  // ever starts writing it legitimately, this fails and the ranking above
  // should be revisited before the queue fills with normal traffic.
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const wallet = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
  const writes = [...wallet.matchAll(/status:\s*'pending'/g)];
  assert.equal(writes.length, 0,
    "wallet.js now writes status 'pending' — it is ranked in the attention queue as a stranded row, which would be wrong for a normal in-progress state");
});
