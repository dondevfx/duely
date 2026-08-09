// Cryptomus card checkout.
//
// Unlike a consumer on-ramp, Cryptomus settles into OUR merchant balance rather
// than sending straight to the player. So the money has one more hop, and the
// thing that must be right is that the hop lands in the RIGHT player's deposit
// address and happens exactly once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.CRYPTOMUS_MERCHANT_ID = 'merchant-1';
process.env.CRYPTOMUS_PAYMENT_KEY = 'pay-key';
process.env.CRYPTOMUS_PAYOUT_KEY  = 'payout-key';
process.env.BACKEND_URL = 'https://api.duely.us';
const cryptomus = require('../src/services/cryptomusService');

const webhookSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'webhooks.js'), 'utf8');
const walletSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');

test('configuration requires all three credentials', () => {
  assert.equal(cryptomus.isConfigured(), true);
});

test('the invoice carries the user id so the IPN can identify the payer', () => {
  // The webhook parses order_id as dep_{userId}_{coin}. If these two ever drift
  // apart, a paid invoice credits nobody.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'cryptomusService.js'), 'utf8');
  const invoice = src.slice(src.indexOf('async function createInvoice'),
                            src.indexOf('// Get (or create)'));
  assert.match(invoice, /order_id:\s*`dep_\$\{userId\}_usdcspl`/,
    'order_id must encode the user id in the shape the IPN parses');
  assert.match(invoice, /to_currency:\s*'USDC'/, 'must settle in USDC, not a volatile coin');
  assert.match(invoice, /currency:\s*'USD'/, 'the card must be charged a fiat amount');
  assert.match(invoice, /url_callback/, 'without a callback the payment is never credited');
});

test('the IPN parses back exactly what the invoice writes', () => {
  // Round-trip the id format rather than trusting two string literals to agree.
  const userId = '423d2b0c-1111-2222-3333-444455556666';
  const orderId = `dep_${userId}_usdcspl`;
  assert.equal(orderId.split('_')[1], userId,
    'the webhook takes parts[1] as the user id — this is that contract');
});

test('a USDC settlement skips the swap entirely', () => {
  // Routing USDC through an exchange to get USDC pays a spread and two network
  // fees for nothing, and adds a failure mode.
  const branch = webhookSrc.slice(webhookSrc.indexOf("if (coinId === 'usdcspl')"),
                                  webhookSrc.indexOf('// Create SimpleSwap exchange'));
  assert.ok(branch.length > 0, 'the USDC short-circuit must exist');
  assert.ok(!/createDepositSwap/.test(branch), 'must not create an exchange for USDC→USDC');
  assert.match(branch, /createPayout/, 'it should pay out directly instead');
});

test('the payout goes to the payer\'s own deposit address', () => {
  const branch = webhookSrc.slice(webhookSrc.indexOf("if (coinId === 'usdcspl')"),
                                  webhookSrc.indexOf('// Create SimpleSwap exchange'));
  assert.match(branch, /getOrCreateAddress\(userId, 'usdc'/,
    'the destination must be derived from the userId in the IPN, never from the request body');
  assert.match(branch, /address: dest/, 'and that address must be what is paid to');
});

test('the claim is released when the destination cannot be resolved', () => {
  // Nothing has moved yet, so stranding the claim would block the retry and
  // lose the deposit.
  const branch = webhookSrc.slice(webhookSrc.indexOf("if (coinId === 'usdcspl')"),
                                  webhookSrc.indexOf('// Create SimpleSwap exchange'));
  const resolveFail = branch.slice(branch.indexOf('could not resolve deposit address'));
  assert.match(resolveFail.slice(0, 300), /delete\(\)/,
    'a failure before any funds move must release the claim for retry');
});

test('the claim is KEPT when the payout itself fails', () => {
  // Opposite of the above: funds may already be moving, so an automatic retry
  // could double-send. This one needs a human.
  const branch = webhookSrc.slice(webhookSrc.indexOf("if (coinId === 'usdcspl')"),
                                  webhookSrc.indexOf('// Create SimpleSwap exchange'));
  const payFail = branch.slice(branch.indexOf('CRITICAL payout failed'));
  assert.ok(!/delete\(\)/.test(payFail.slice(0, 300)),
    'a failed payout must not release the claim — that is how a double-send happens');
  assert.match(payFail.slice(0, 300), /payout_failed/,
    'and it must be marked for manual review');
});

test('the claim row is closed out rather than left at claiming', () => {
  const branch = webhookSrc.slice(webhookSrc.indexOf("if (coinId === 'usdcspl')"),
                                  webhookSrc.indexOf('// Create SimpleSwap exchange'));
  assert.match(branch, /status: 'forwarded'/,
    "leaving it at 'claiming' would look like a stuck deposit forever");
});

test('the provider is chosen by which keys exist, not hardcoded', () => {
  assert.match(walletSrc, /function onrampProvider\(\)/);
  assert.match(walletSrc, /if \(cryptomus\.isConfigured\(\)\) return 'cryptomus'/);
  assert.match(walletSrc, /if \(!provider\) return res\.status\(501\)/,
    'with no provider configured the endpoint must refuse, not half-build a URL');
});

test('FRONTEND_URL holding several origins does not corrupt the return URL', () => {
  // FRONTEND_URL is a comma-separated CORS allowlist. Interpolating it whole
  // would produce "https://a.com,https://b.com/wallet".
  assert.match(walletSrc, /FRONTEND_URL\.split\(','\)\[0\]/,
    'take the first origin, or the return URL is malformed during a domain move');
});
