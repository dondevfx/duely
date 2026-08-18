// Can a player be paid on-chain AND refunded for the same withdrawal?
//
// A Solana send broadcasts first and confirms second. When confirmation times
// out — congestion, a slow RPC, a dropped socket — the send throws, and the
// withdrawal handler refunded on any payout error. So a timeout paid the player
// on-chain and put their coins back.
//
// It is fishable, not just unlucky: retry withdrawals during congestion until a
// confirmation happens to time out, and every hit is free money. Nothing in the
// old path could tell that case apart from a send that never left.
//
// The fix is that the signature is captured at BROADCAST time and carried on the
// error, so the outcome can be read off the chain before anything is refunded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PayoutError, checkSolanaSignature } = require('../src/services/chainSend');

// ── The error carries what is needed to check ──────────────────────────────

test('a failure before broadcast carries no signature — nothing can have moved', () => {
  const e = new PayoutError('rpc rejected', null);
  assert.equal(e.signature, null);
});

test('a failure after broadcast carries the signature', () => {
  const e = new PayoutError('could not confirm: timeout', 'SIG123');
  assert.equal(e.signature, 'SIG123', 'without this the outcome is unknowable and the refund is a guess');
});

// ── Reading the outcome off the chain ──────────────────────────────────────

// Stub connection: getSignatureStatuses is the only call checkSolanaSignature makes.
function stubSolana(responses) {
  const solWeb3 = require('@solana/web3.js');
  const original = solWeb3.Connection;
  let i = 0;
  solWeb3.Connection = function () {
    return {
      getSignatureStatuses: async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return { value: [r] };
      },
    };
  };
  return () => { solWeb3.Connection = original; };
}

const FAST = { attempts: 3, delayMs: 0 };

test('a landed transaction reports confirmed — the player must NOT be refunded', async () => {
  const restore = stubSolana([{ err: null, confirmationStatus: 'confirmed' }]);
  try {
    assert.equal(await checkSolanaSignature('SIG', FAST), 'confirmed');
  } finally { restore(); }
});

test('a finalized transaction also counts as paid', async () => {
  const restore = stubSolana([{ err: null, confirmationStatus: 'finalized' }]);
  try {
    assert.equal(await checkSolanaSignature('SIG', FAST), 'confirmed');
  } finally { restore(); }
});

test('a transaction that landed and reverted is safe to refund', async () => {
  const restore = stubSolana([{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }]);
  try {
    assert.equal(await checkSolanaSignature('SIG', FAST), 'failed');
  } finally { restore(); }
});

test('a transaction the chain never saw is safe to refund', async () => {
  const restore = stubSolana([null]);
  try {
    assert.equal(await checkSolanaSignature('SIG', FAST), 'missing');
  } finally { restore(); }
});

test('one slow confirmation is waited out rather than called missing', async () => {
  // The dangerous mistake: give up on the first null and refund a payment that
  // was merely late.
  const restore = stubSolana([null, null, { err: null, confirmationStatus: 'confirmed' }]);
  try {
    assert.equal(await checkSolanaSignature('SIG', FAST), 'confirmed');
  } finally { restore(); }
});

test('an RPC that never answers reports unknown, not missing', async () => {
  // 'missing' would refund. An RPC being down is not evidence the money stayed
  // put, and treating it as such is exactly the double-spend.
  const restore = stubSolana([new Error('ECONNREFUSED')]);
  try {
    assert.equal(await checkSolanaSignature('SIG', FAST), 'unknown');
  } finally { restore(); }
});

test('no signature at all means nothing was broadcast', async () => {
  assert.equal(await checkSolanaSignature(null, FAST), 'missing');
});

// ── The handler acts on it ─────────────────────────────────────────────────

const WALLET = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');

function payoutCatch() {
  const at = WALLET.indexOf('} catch (payoutErr) {');
  assert.notEqual(at, -1, 'the payout catch block is gone');
  // Up to the recordFailure/refund machinery that follows it.
  const end = WALLET.indexOf('const recordFailure', at);
  assert.ok(end > at, 'could not bound the payout catch block');
  return WALLET.slice(at, end);
}

test('the outcome is checked BEFORE any refund is issued', () => {
  const body = payoutCatch();
  const check  = body.indexOf('checkSolanaSignature');
  assert.notEqual(check, -1,
    'the handler refunds on the error alone — a confirmation timeout pays the player twice');
  const refund = WALLET.indexOf('creditCoins(supabase, req.user.id, amount)');
  assert.ok(check < refund, 'the chain must be consulted before the balance is restored');
});

test('a confirmed payout returns success instead of refunding', () => {
  const body = payoutCatch();
  assert.match(body, /=== 'confirmed'/, 'a landed transaction must be recognised');
  assert.match(body, /return res\.json\(\{ success: true/,
    'a payout that landed after a timeout is a successful withdrawal, not a failed one');
});

test('an unknown outcome refunds nothing and escalates', () => {
  const body = payoutCatch();
  assert.match(body, /=== 'unknown'/);
  assert.match(body, /payout_uncertain/,
    'an indeterminate payout needs its own status — refunding it may pay twice, not refunding may rob the player');
  assert.match(body, /CRITICAL/, 'it must reach a human');
});

test('payout_uncertain is on the critical alert list', () => {
  const alerts = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'alertService.js'), 'utf8');
  const critical = alerts.slice(alerts.indexOf('const CRITICAL'), alerts.indexOf('\n', alerts.indexOf('const CRITICAL')));
  assert.match(critical, /payout_uncertain/,
    'a withdrawal nobody can resolve must alert, or it sits in the table forever');
});

// The payout path must not go back to a helper that discards the signature.
test('the SPL payout does not use a wrapper that throws the signature away', () => {
  // sendSplToken serves both USDC and USDT now; it was sendUsdcSpl.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'chainSend.js'), 'utf8');
  const at = src.indexOf('async function sendSplToken');
  assert.notEqual(at, -1, 'the SPL send is gone — was it renamed?');
  const end = src.indexOf('// ── TRX', at);
  assert.notEqual(end, -1, 'the end marker no longer exists; this slice would run to EOF');
  const fn = src.slice(at, end);
  assert.ok(!/splToken\.transfer\s*\(/.test(fn),
    'splToken.transfer wraps sendAndConfirmTransaction and loses the signature on timeout');
  assert.match(fn, /sendAndVerify\s*\(/, 'it must use the path that captures the signature');
});
