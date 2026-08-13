// USDC is the only coin whose deposit needs no swap, and that is exactly why it
// went wrong twice.
//
// 1. Every other coin forwards on arrival. The USDC branch credited the player
//    and returned, so deposits piled up in per-user addresses while the payout
//    wallet only ever drained. Nothing failed loudly — the other coins kept the
//    wallet funded, so the hole stayed invisible.
//
// 2. The withdrawal path read the source token account from ADMIN_USDC_ATA with
//    a hardcoded fallback. The transfer signs with the admin keypair as OWNER of
//    that account, so the variable could never legitimately differ from the
//    keypair's own ATA — it could only go stale. Rotating the wallet did exactly
//    that and every USDC withdrawal failed on an owner mismatch.
//
// Both are shape-of-the-code bugs rather than logic bugs, so both are guarded by
// reading the source. Comments are stripped first: an earlier test in this repo
// passed against its own explanatory prose rather than the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs
  .readFileSync(path.join(__dirname, '..', 'src', 'services', rel), 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const monitor   = read('blockchainMonitor.js');
const chainSend = read('chainSend.js');

test('the USDC deposit branch forwards instead of stopping at the credit', () => {
  // The branch runs from the `coin === 'usdc'` test to its `return`.
  const start = monitor.indexOf("if (coin === 'usdc')");
  assert.ok(start > 0, 'USDC deposit branch not found');
  const branch = monitor.slice(start, monitor.indexOf('const creditUser', start));

  assert.match(branch, /sweepUsdc\(/, 'USDC deposits must be swept to the payout wallet');
  assert.ok(
    branch.indexOf('creditCoins') < branch.indexOf('sweepUsdc'),
    'sweep must come after the credit — a failed sweep costs nothing, an uncredited player does'
  );
});

test('a failed sweep cannot block or undo the credit', () => {
  const start = monitor.indexOf('sweepUsdc(');
  const around = monitor.slice(start - 400, start + 400);
  assert.match(around, /try\s*\{/, 'the sweep must be wrapped — the player is already paid');
  assert.match(around, /catch/, 'a sweep failure must be caught, not thrown');
});

test('the sweep pays fees from the admin wallet, not the deposit address', () => {
  // Deposit addresses hold no SOL. If the sweep did not set an explicit fee
  // payer it would default to the source and fail on every address.
  assert.match(chainSend, /feePayer\s*=\s*adminKp\.publicKey/);
});

test('the sweep refuses to run when the key and the payout address disagree', () => {
  // Otherwise a half-finished wallet rotation quietly funds the wrong wallet.
  assert.match(chainSend, /adminKp\.publicKey\.equals\(adminPub\)/);
});

test('the withdrawal source account is derived, never read from an env var', () => {
  assert.doesNotMatch(chainSend, /ADMIN_USDC_ATA/,
    'ADMIN_USDC_ATA can only go stale — derive the ATA from the admin keypair');
  assert.match(chainSend, /getAssociatedTokenAddressSync\(usdcMint, keypair\.publicKey\)/);
});

test('no old wallet address is left hardcoded anywhere in the send path', () => {
  assert.doesNotMatch(chainSend, /GGakQrHowCPNcd9VJJqTfwjYEtJfDm6bjwC2GvmSwAxV/);
});

test('the stranded-USDC backfill exists and is bounded', () => {
  // The per-deposit sweep only fires on arrival, so an address that never sees
  // another deposit needs this to ever be collected.
  const { sweepStrandedUsdc } = require('../src/services/blockchainMonitor');
  assert.equal(typeof sweepStrandedUsdc, 'function');
  assert.match(monitor, /SWEEP_MAX_PER_RUN/, 'the backfill must cap work per run');
});

test('the backfill skips a user rather than abandoning the run', () => {
  const start = monitor.indexOf('async function sweepStrandedUsdc');
  const body = monitor.slice(start, start + 1200);
  assert.match(body, /catch/, 'one bad address must not stop the rest of the sweep');
});
