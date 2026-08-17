// Why every BTC/LTC/DOGE forward failed to broadcast.
//
//   BlockCypher broadcast: [{"error":"Error building input: Error generating
//   scriptsig when building transaction: Invalid signature: Non-canonical
//   signature: wrong length marker."}, ...]
//
// The signature was DER-encoded and then had '01' appended for SIGHASH_ALL. A
// DER signature declares its own length in byte 2, so the extra byte makes the
// blob one longer than it claims to be, and the parser rejects it before it
// ever checks the maths. BlockCypher builds the scriptSig itself and appends
// the hashtype at that point.
//
// The "not enough funds" errors reported alongside it were downstream noise:
// once an input's signature fails, the input is dropped, leaving nothing to
// fund the output. Reading those first sends you looking for a balance problem
// that does not exist.
//
// derEncode is a pure function, so this checks the actual bytes rather than the
// shape of the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const { derEncode } = require('../src/services/chainSend');
const fs = require('node:fs');
const path = require('node:path');

// A raw 64-byte signature: 32 bytes of r followed by 32 of s.
const raw = (rHex, sHex) => Buffer.concat([
  Buffer.from(rHex.padStart(64, '0'), 'hex'),
  Buffer.from(sHex.padStart(64, '0'), 'hex'),
]);

// The check the Bitcoin parser makes, and the one that was failing.
function lengthMarkerIsCorrect(der) {
  return der[0] === 0x30 && der[1] === der.length - 2;
}

test('the declared length matches the actual length', () => {
  const der = derEncode(raw('a'.repeat(64), 'b'.repeat(64)));
  assert.ok(lengthMarkerIsCorrect(der),
    `declared ${der[1]}, actual ${der.length - 2} — this is the "wrong length marker" rejection`);
});

test('appending a sighash byte is what broke it', () => {
  // Demonstrates the old behaviour failing the very check above, so the test
  // documents the bug rather than just asserting the fix.
  const der = derEncode(raw('a'.repeat(64), 'b'.repeat(64)));
  const withSighash = Buffer.concat([der, Buffer.from([0x01])]);
  assert.ok(!lengthMarkerIsCorrect(withSighash),
    'if this passes, the sighash byte was never the problem and the diagnosis is wrong');
});

test('the encoding survives values that need a leading zero', () => {
  // A high bit set on the first byte reads as a negative integer in DER, so a
  // 0x00 pad is prepended. That changes the length, which is exactly where an
  // encoder gets its length marker wrong.
  const der = derEncode(raw('f'.repeat(64), 'f'.repeat(64)));
  assert.ok(lengthMarkerIsCorrect(der), 'padded values must still declare the right length');
  assert.equal(der[2], 0x02, 'r must be an INTEGER');
  assert.equal(der[3], 33, 'r should be 33 bytes once padded');
  assert.equal(der[4], 0x00, 'and the pad byte comes first');
});

test('the encoding survives values with leading zeros to strip', () => {
  // The opposite case: leading zero bytes are stripped, also changing length.
  const der = derEncode(raw('01'.padStart(64, '0'), '01'.padStart(64, '0')));
  assert.ok(lengthMarkerIsCorrect(der), 'stripped values must still declare the right length');
  assert.equal(der[3], 1, 'r should shrink to a single byte');
});

test('every internal INTEGER length is honest too', () => {
  // A correct outer marker can still wrap a wrong inner one.
  for (const [r, s] of [['a'.repeat(64), 'b'.repeat(64)], ['f'.repeat(64), '01'.padStart(64, '0')]]) {
    const der = derEncode(raw(r, s));
    const rLen = der[3];
    assert.equal(der[4 + rLen], 0x02, 's must follow r as an INTEGER');
    const sLen = der[5 + rLen];
    assert.equal(2 + 2 + rLen + 2 + sLen, der.length, 'the parts must add up to the whole');
  }
});

test('the signer does not re-append the sighash byte', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'chainSend.js'), 'utf8');
  const fn = src.slice(src.indexOf('skel.signatures = skel.tosign.map'), src.indexOf('// Step 3'));
  assert.ok(!/\+\s*'01'/.test(fn),
    "appending '01' to the DER signature is what produced 'wrong length marker'");
});

// ── A failed price lookup must not discard a real deposit ──────────────────
//
// getPriceUsd returns 0 when CoinGecko errors or rate-limits. Everything
// downstream then valued the deposit at $0.00, decided it was below the $3
// minimum, and added it to _seenTxs — which is never cleared. So a transient
// API blip discarded a real deposit for the life of the process:
//
//   [monitor] non-SOL $0.00 below $3 min — skipping c004a08a...
//
// That happened to a live BTC deposit while it was already being retried for
// an unrelated reason.

test('an unknown price is not treated as a worthless deposit', () => {
  const mon = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  const guard = mon.slice(mon.indexOf('const priceUsd'), mon.indexOf('const { creditCoins'));
  assert.match(guard, /priceUsd > 0/,
    'a price of 0 means the lookup failed, not that the coin is worthless');

  // And it must NOT mark the transaction seen, or the retry never happens.
  const block = guard.slice(guard.indexOf('no USD price'));
  const upToReturn = block.slice(0, block.indexOf('return;') + 7);
  assert.ok(!/_seenTxs\.add/.test(upToReturn),
    'marking it seen is what made the loss permanent — it must be left for the next poll');
});

test('the price guard runs before the minimum check', () => {
  const mon = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  const guardAt = mon.indexOf('no USD price');
  const minAt   = mon.indexOf('below $${MIN_CREDIT_USD} min');
  assert.ok(guardAt !== -1, 'the price guard is missing');
  assert.ok(minAt === -1 || guardAt < minAt,
    'checking the minimum first is what turns a failed lookup into a discarded deposit');
});
