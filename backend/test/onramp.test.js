// MoonPay on-ramp URL building.
//
// The signature is the whole security story. MoonPay accepts walletAddress as a
// query parameter, so an unsigned URL is editable in the address bar — a user
// could point a purchase at someone else's deposit address, or edit a shared
// link to redirect funds to their own. The signature binds the parameters to
// our secret and MoonPay rejects a mismatch.
//
// These tests set the env BEFORE requiring the service, because it reads the
// key and secret at module load.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.MOONPAY_KEY = 'pk_test_abc123';
process.env.MOONPAY_SECRET = 'sk_test_supersecret';
const moonpay = require('../src/services/moonpayService');

const ADDR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

test('a built URL carries a signature that verifies', () => {
  const url = moonpay.buildBuyUrl({ address: ADDR });
  assert.ok(url.includes('signature='), 'unsigned URLs are editable — always sign');
  assert.equal(moonpay.verifyUrl(url), true);
});

test('the signature is over the query string including the leading ?', () => {
  // This is MoonPay's documented scheme. Getting it wrong produces a URL that
  // looks fine and is rejected at their end, so it is pinned explicitly.
  const url = new URL(moonpay.buildBuyUrl({ address: ADDR }));
  const given = url.searchParams.get('signature');
  url.searchParams.delete('signature');
  const expected = crypto.createHmac('sha256', 'sk_test_supersecret')
    .update('?' + url.searchParams.toString()).digest('base64');
  assert.equal(given, expected);
});

test('tampering with the destination address invalidates it', () => {
  const url = moonpay.buildBuyUrl({ address: ADDR });
  const attacker = url.replace(ADDR, '9zZZtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  assert.notEqual(attacker, url, 'the address must actually appear in the URL');
  assert.equal(moonpay.verifyUrl(attacker), false,
    'a redirected purchase must not verify');
});

test('tampering with the amount invalidates it', () => {
  const url = moonpay.buildBuyUrl({ address: ADDR, amountUsd: 50 });
  assert.equal(moonpay.verifyUrl(url.replace('baseCurrencyAmount=50', 'baseCurrencyAmount=5000')), false);
});

test('a stripped signature does not pass', () => {
  const url = moonpay.buildBuyUrl({ address: ADDR });
  assert.equal(moonpay.verifyUrl(url.replace(/&signature=[^&]*/, '')), false);
});

test('test keys point at the sandbox, never at production', () => {
  // Pointing live keys at the sandbox loses real purchases; pointing test keys
  // at production fails confusingly. The host is derived from the key so an env
  // var cannot get this pair out of step.
  assert.ok(moonpay.buildBuyUrl({ address: ADDR }).startsWith('https://buy-sandbox.moonpay.com'));
  assert.equal(moonpay.isTestKey(), true);
});

test('the destination and amount actually make it into the URL', () => {
  const url = new URL(moonpay.buildBuyUrl({ address: ADDR, amountUsd: 25, email: 'a@b.com' }));
  assert.equal(url.searchParams.get('walletAddress'), ADDR);
  assert.equal(url.searchParams.get('baseCurrencyAmount'), '25');
  assert.equal(url.searchParams.get('email'), 'a@b.com');
  assert.equal(url.searchParams.get('currencyCode'), 'usdc_sol', 'must be USDC on Solana');
  assert.equal(url.searchParams.get('apiKey'), 'pk_test_abc123');
});

test('building without a destination is refused', () => {
  assert.throws(() => moonpay.buildBuyUrl({}), /address/i);
});

test('the secret is never sent to the browser', () => {
  const url = moonpay.buildBuyUrl({ address: ADDR, amountUsd: 25 });
  assert.ok(!url.includes('sk_test'), 'the signing secret must stay server-side');

  // And the route must build the URL rather than handing the client anything
  // it could sign with.
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
  assert.ok(!/MOONPAY_SECRET/.test(route), 'the route must not touch the secret directly');
  assert.ok(/getOrCreateAddress\(req\.user\.id, 'usdc'/.test(route),
    'the address must come from the session, never from the request');
});

test('the address is not taken from the query string', () => {
  // If the route ever accepted an address parameter, one user could fund
  // another account — or be tricked into funding an attacker's.
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
  const handler = route.slice(route.indexOf("router.get('/onramp-url'"),
                              route.indexOf("router.get('/min-deposit'"));
  assert.ok(!/req\.query\.address|req\.body\.address/.test(handler),
    'the destination must be derived from the authenticated user only');
});

test('an unconfigured install reports disabled instead of half-working', () => {
  // Fresh module with no env, so a missing key is a clean "not enabled" rather
  // than a broken URL.
  const keep = { k: process.env.MOONPAY_KEY, s: process.env.MOONPAY_SECRET };
  delete process.env.MOONPAY_KEY; delete process.env.MOONPAY_SECRET;
  delete require.cache[require.resolve('../src/services/moonpayService')];
  const fresh = require('../src/services/moonpayService');
  assert.equal(fresh.isConfigured(), false);
  assert.throws(() => fresh.buildBuyUrl({ address: ADDR }), /not configured/i);
  process.env.MOONPAY_KEY = keep.k; process.env.MOONPAY_SECRET = keep.s;
  delete require.cache[require.resolve('../src/services/moonpayService')];
});
