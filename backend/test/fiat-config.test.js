// The fiat method table, and the bank details that go with it.
//
// Two failure modes are being designed out here, both of which the crypto side
// hit for real:
//
//   A page offering something the server rejects. DEPOSIT_COINS lived in the
//   HTTP route, so the monitor had its own idea of which coins existed and
//   disabling BNB left the poller warning about it every 45 seconds forever.
//
//   A method offered in a direction it cannot go. Cash App and Apple Pay can
//   take money and can never send it, and a player who funds with one has to
//   withdraw somewhere else. That must be enforced, not remembered.
const test = require('node:test');
const assert = require('node:assert/strict');

const fiat = require('../src/services/fiatConfig');
const {
  isValidRoutingNumber, isValidAccountNumber, validateBankDetails, maskAccountNumber,
} = require('../src/services/bankValidator');

// ── Direction is capability, not preference ────────────────────────────────

test('the one-way rails can never be made two-way by config', () => {
  // Not a toggle. There is no third-party payout API for either, so a future
  // edit that "enables" the withdrawal is enabling something that cannot work.
  for (const m of ['cash_app', 'apple_pay', 'card']) {
    assert.equal(fiat.METHODS[m].withdraw, false, `${m} cannot send money`);
    assert.equal(fiat.METHODS[m].minWithdraw, null,
      `${m} has a withdrawal minimum, which implies a withdrawal exists`);
  }
});

test('enabling a method does not grant it a direction it lacks', () => {
  // The dangerous interaction: someone adds cash_app to ENABLED expecting
  // deposits, and payouts quietly come with it.
  fiat.ENABLED.add('cash_app');
  try {
    assert.equal(fiat.canDeposit('cash_app'), true, 'deposits should switch on');
    assert.equal(fiat.canWithdraw('cash_app'), false, 'payouts must stay impossible');
    assert.ok(!fiat.withdrawMethods().includes('cash_app'));
  } finally {
    fiat.ENABLED.delete('cash_app');
  }
});

test('deposit-only methods are named for the page', () => {
  // So a player is warned when they fund, not when they try to cash out.
  fiat.ENABLED.add('cash_app');
  fiat.ENABLED.add('bank');
  try {
    const cfg = fiat.publicConfig();
    assert.ok(cfg.depositOnly.includes('cash_app'), 'cash_app must be flagged one-way');
    assert.ok(!cfg.depositOnly.includes('bank'), 'bank goes both ways');
  } finally {
    fiat.ENABLED.delete('cash_app');
    fiat.ENABLED.delete('bank');
  }
});

test('nothing is live until a provider has approved something', () => {
  // The correct state before the first approval. A method being in the table
  // means the rail can do it, not that we can.
  assert.equal(fiat.ENABLED.size, 0, 'fiat should ship switched off');
  assert.deepEqual(fiat.depositMethods(), []);
  assert.deepEqual(fiat.withdrawMethods(), []);
});

test('minimums follow the fee shape', () => {
  // Flat-fee rails are wrong for small amounts; percentage rails are fine.
  // Same reasoning that gives BTC a $10 floor against $5 elsewhere.
  assert.ok(fiat.minFor('bank', 'withdraw') > fiat.minFor('paypal', 'withdraw'),
    'a flat-fee rail needs a higher floor than a percentage one');
  assert.equal(fiat.METHODS.bank.feeShape, 'flat');
  assert.equal(fiat.METHODS.paypal.feeShape, 'percent');
});

// ── Routing numbers ────────────────────────────────────────────────────────
//
// A malformed routing number fails days later as an ACH return. One that is
// wrong but VALID sends real money to a different bank, and recovering it means
// asking them to reverse it.

test('real routing numbers pass', () => {
  // Published ABA numbers with correct check digits.
  for (const rn of ['021000021', '011401533', '091000019', '121000248']) {
    assert.ok(isValidRoutingNumber(rn), `${rn} should be valid`);
  }
});

test('a transposed pair is caught', () => {
  // This is the whole reason for a weighted checksum. An unweighted digit sum
  // cannot tell these apart — both sum to the same total.
  assert.ok(isValidRoutingNumber('021000021'));
  assert.ok(!isValidRoutingNumber('021000012'), 'the last two digits are swapped');
});

test('a single wrong digit is caught', () => {
  assert.ok(!isValidRoutingNumber('021000022'));
  assert.ok(!isValidRoutingNumber('121000249'));
});

test('all zeros does not sneak through the checksum', () => {
  // Sums to zero, so the mod-10 test alone passes it. The routing-symbol range
  // is what rejects it.
  assert.ok(!isValidRoutingNumber('000000000'));
});

test('numbers outside the issued ranges are rejected', () => {
  // 13-20, 33-60, 73-79 and 81+ were never issued as routing symbols.
  assert.ok(!isValidRoutingNumber('130000004'), 'prefix 13 was never issued');
  assert.ok(!isValidRoutingNumber('990000001'), 'prefix 99 was never issued');
});

test('shape alone is not enough', () => {
  for (const bad of ['', '12345678', '1234567890', 'abcdefghi', '02100002x', null, undefined]) {
    assert.ok(!isValidRoutingNumber(bad), `${bad} should be rejected`);
  }
});

// ── Account numbers ────────────────────────────────────────────────────────

test('leading zeros survive', () => {
  // The reason this takes a string. Parsing "00012345" as a number drops the
  // zeros and pays a different account.
  assert.ok(isValidAccountNumber('00012345'));
  assert.equal(maskAccountNumber('00012345'), '••••2345');
});

test('placeholder data is rejected', () => {
  assert.ok(!isValidAccountNumber('000000000'));
  assert.ok(!isValidAccountNumber('1111'));
});

test('impossible lengths are rejected', () => {
  assert.ok(!isValidAccountNumber('123'));
  assert.ok(!isValidAccountNumber('123456789012345678'));
  assert.ok(!isValidAccountNumber('1234-5678'));
});

// ── The whole form ─────────────────────────────────────────────────────────

test('a valid set passes', () => {
  const r = validateBankDetails({
    routingNumber: '021000021', accountNumber: '00012345', accountType: 'checking',
  });
  assert.equal(r.ok, true);
});

test('a rejection names the field that is wrong', () => {
  // So the page can point at the input rather than failing the whole form with
  // one unhelpful message.
  assert.equal(validateBankDetails({
    routingNumber: '021000012', accountNumber: '00012345', accountType: 'checking',
  }).field, 'routingNumber');

  assert.equal(validateBankDetails({
    routingNumber: '021000021', accountNumber: '12', accountType: 'checking',
  }).field, 'accountNumber');

  assert.equal(validateBankDetails({
    routingNumber: '021000021', accountNumber: '00012345', accountType: 'crypto',
  }).field, 'accountType');
});

test('account type is checked — a mismatch is a common ACH return', () => {
  assert.equal(validateBankDetails({
    routingNumber: '021000021', accountNumber: '00012345', accountType: 'savings',
  }).ok, true);
  assert.equal(validateBankDetails({
    routingNumber: '021000021', accountNumber: '00012345', accountType: '',
  }).ok, false);
});
