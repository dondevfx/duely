// US bank account validation for ACH.
//
// The same principle as addressValidator: verify a CHECKSUM, not a shape. A
// regex on "nine digits" accepts a transposed pair, and the consequence is
// worse than a bad crypto address. A malformed routing number fails days later
// as an ACH return; a routing number that is wrong but VALID sends real money
// to a different bank, and getting it back means asking them to reverse it.
//
// Account numbers have no checksum — the format is per-bank and there is no
// standard to verify against — so all that can be done is reject the obviously
// impossible and rely on the processor's prenote or micro-deposit to confirm
// the account actually exists.

// ── ABA routing number ──────────────────────────────────────────────────────
//
// Nine digits with a mod-10 check digit:
//
//   3(d1+d4+d7) + 7(d2+d5+d8) + 1(d3+d6+d9)  ≡ 0 (mod 10)
//
// The weights are what catch a transposition. A plain digit sum would not:
// 021000021 and 021000012 both sum to 6, and only the weighting tells them
// apart.
function routingChecksumOk(digits) {
  const d = [...digits].map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

// The first two digits are the Federal Reserve routing symbol, and only some
// ranges were ever issued. This catches a number that passes the checksum by
// coincidence but was never a real routing number — 000000000 being the obvious
// one, which sums to zero and would otherwise pass.
function routingPrefixOk(digits) {
  const p = Number(digits.slice(0, 2));
  return (
    (p >= 1  && p <= 12) ||   // Federal Reserve districts
    (p >= 21 && p <= 32) ||   // thrift institutions
    (p >= 61 && p <= 72) ||   // electronic transactions
    p === 80                  // traveler's cheques
  );
  // 00 is government and not valid for consumer ACH, so it is deliberately out.
}

function isValidRoutingNumber(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{9}$/.test(s)) return false;
  if (!routingPrefixOk(s)) return false;
  return routingChecksumOk(s);
}

// ── Account number ──────────────────────────────────────────────────────────
//
// No checksum exists. US account numbers run roughly 4 to 17 digits depending
// on the bank, and some carry leading zeros that matter — which is why this
// takes a string and never a number. Parsing "00012345" as an integer silently
// drops the zeros and pays the wrong account.
function isValidAccountNumber(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4,17}$/.test(s)) return false;
  // All-identical digits are placeholder data, never a real account.
  if (/^(\d)\1+$/.test(s)) return false;
  return true;
}

// ── Account type ────────────────────────────────────────────────────────────
// ACH distinguishes these and a mismatch is a common return reason.
const ACCOUNT_TYPES = new Set(['checking', 'savings']);

/**
 * Validate a full set of bank details.
 *
 * Returns { ok: true } or { ok: false, field, error } so the caller can point
 * at the offending input rather than rejecting the whole form with one message.
 */
function validateBankDetails({ routingNumber, accountNumber, accountType } = {}) {
  if (!isValidRoutingNumber(routingNumber)) {
    return {
      ok: false,
      field: 'routingNumber',
      error: 'That routing number is not valid. It is the nine digits on the bottom left of a cheque.',
    };
  }
  if (!isValidAccountNumber(accountNumber)) {
    return {
      ok: false,
      field: 'accountNumber',
      error: 'That account number is not valid. Enter it exactly, including any leading zeros.',
    };
  }
  if (!ACCOUNT_TYPES.has(String(accountType ?? '').toLowerCase())) {
    return { ok: false, field: 'accountType', error: 'Choose checking or savings.' };
  }
  return { ok: true };
}

// Last four, for showing a saved account back to a player without storing or
// displaying the whole number anywhere it does not need to be.
function maskAccountNumber(value) {
  const s = String(value ?? '').trim();
  if (s.length < 4) return '••••';
  return '••••' + s.slice(-4);
}

module.exports = {
  isValidRoutingNumber,
  isValidAccountNumber,
  validateBankDetails,
  maskAccountNumber,
  ACCOUNT_TYPES,
};
