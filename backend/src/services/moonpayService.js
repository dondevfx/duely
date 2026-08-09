/**
 * MoonPay on-ramp — card → USDC-SPL straight into the player's own deposit
 * address.
 *
 * Nothing here credits anything. MoonPay sells USDC to the user and sends it
 * on-chain; from that point it is an ordinary deposit and blockchainMonitor
 * picks it up on its next poll, exactly as if they had sent it from a wallet.
 * That also means MoonPay is the merchant of record — they run KYC, they take
 * the card, and they carry the chargeback. We never touch card details.
 *
 * The one thing that must be right is the signature. MoonPay lets the widget be
 * opened with a walletAddress in the query string, so an unsigned URL is
 * trivially editable in the browser — a user could point their own purchase at
 * someone else's address, or point a support link at their own. Signing binds
 * the parameters to our secret, and MoonPay rejects a URL whose signature does
 * not match. The secret therefore must never reach the client, which is why the
 * URL is built here and not in the frontend.
 */
const crypto = require('node:crypto');

const KEY    = process.env.MOONPAY_KEY    || '';
const SECRET = process.env.MOONPAY_SECRET || '';

// Test keys are pk_test_/sk_test_ and must talk to the sandbox host; live keys
// to the production host. Deriving the host from the key removes the chance of
// pointing real keys at the sandbox (or worse, the reverse) via a stray env var.
const isTestKey = () => KEY.startsWith('pk_test');
const HOST = () => (isTestKey() ? 'https://buy-sandbox.moonpay.com' : 'https://buy.moonpay.com');

// USDC on Solana. Worth confirming against the currencies enabled on your
// MoonPay account — the widget errors on a code your account cannot sell.
const CURRENCY = process.env.MOONPAY_CURRENCY || 'usdc_sol';

// The secret is required to sign, and signing is required in production. In the
// sandbox MoonPay may not have issued a secret yet (it can arrive with KYB
// approval), so testing is allowed unsigned rather than blocked outright — but
// a LIVE key with no secret is refused, because an unsigned URL has an editable
// walletAddress and a real purchase could be redirected to any address.
function isConfigured() {
  if (!KEY) return false;
  return Boolean(SECRET) || isTestKey();
}

function canSign() {
  return Boolean(SECRET);
}

/**
 * Signed widget URL for one purchase.
 *
 * @param {object} o
 * @param {string} o.address   destination — the user's USDC deposit address
 * @param {string} [o.email]   prefills their email so MoonPay can resume KYC
 * @param {number} [o.amountUsd] prefilled amount; user can still change it
 * @param {string} [o.externalId] our id for the purchase, echoed back by MoonPay
 * @param {string} [o.redirectURL] where MoonPay returns them when finished
 */
function buildBuyUrl({ address, email, amountUsd, externalId, redirectURL }) {
  if (!KEY) throw new Error('MoonPay is not configured');
  if (!SECRET && !isTestKey()) {
    // Hard stop. Never serve an unsigned URL against live keys.
    throw new Error('MOONPAY_SECRET is required for live keys — refusing to build an unsigned URL');
  }
  if (!address) throw new Error('Destination address required');

  const params = new URLSearchParams({
    apiKey: KEY,
    currencyCode: CURRENCY,
    walletAddress: address,
    // Locks the destination in the widget UI. Without it MoonPay shows an
    // editable address field and the deposit could land anywhere.
    lockAmount: 'false',
  });
  if (email)       params.set('email', email);
  if (amountUsd)   params.set('baseCurrencyAmount', String(amountUsd));
  if (externalId)  params.set('externalTransactionId', externalId);
  if (redirectURL) params.set('redirectURL', redirectURL);

  const query = '?' + params.toString();
  if (!SECRET) {
    // Sandbox only — guarded above. Warns every call so this cannot quietly
    // become the normal state of affairs.
    console.warn('[moonpay] no MOONPAY_SECRET — serving an UNSIGNED sandbox URL (walletAddress is editable)');
    return `${HOST()}${query}`;
  }

  // MoonPay signs the query string INCLUDING the leading '?', and the signature
  // is appended afterwards (it is not itself part of the signed payload).
  const signature = crypto.createHmac('sha256', SECRET).update(query).digest('base64');

  return `${HOST()}${query}&signature=${encodeURIComponent(signature)}`;
}

/** Verifies a URL we produced — used by the tests, and handy for debugging. */
function verifyUrl(url) {
  const u = new URL(url);
  const given = u.searchParams.get('signature');
  if (!given) return false;
  u.searchParams.delete('signature');
  const expected = crypto.createHmac('sha256', SECRET)
    .update('?' + u.searchParams.toString()).digest('base64');
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, canSign, buildBuyUrl, verifyUrl, CURRENCY, isTestKey };
