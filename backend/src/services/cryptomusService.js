const fetch = require('node-fetch');
const crypto = require('crypto');

const BASE        = 'https://api.cryptomus.com/v1';
const MERCHANT_ID = process.env.CRYPTOMUS_MERCHANT_ID;
const PAYMENT_KEY = process.env.CRYPTOMUS_PAYMENT_KEY;
const PAYOUT_KEY  = process.env.CRYPTOMUS_PAYOUT_KEY;

// Internal coin ID → Cryptomus { currency, network }
const COINS = {
  btc:       { currency: 'BTC',  network: 'BTC'  },
  eth:       { currency: 'ETH',  network: 'ETH'  },
  sol:       { currency: 'SOL',  network: 'SOL'  },
  ltc:       { currency: 'LTC',  network: 'LTC'  },
  trx:       { currency: 'TRX',  network: 'TRON' },
  doge:      { currency: 'DOGE', network: 'DOGE' },
  shib:      { currency: 'SHIB', network: 'ETH'  },
  usdttrc20: { currency: 'USDT', network: 'TRON' },
  usdcspl:   { currency: 'USDC', network: 'SOL'  },
};

// Cryptomus sign = md5( base64(JSON.stringify(body)) + key )
function makeSign(body, key) {
  const b64 = Buffer.from(JSON.stringify(body)).toString('base64');
  return crypto.createHash('md5').update(b64 + key).digest('hex');
}

async function post(path, body, isPayout = false) {
  const key = isPayout ? PAYOUT_KEY : PAYMENT_KEY;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'merchant':     MERCHANT_ID,
      'sign':         makeSign(body, key),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.state !== 0) {
    const msg = data.message || JSON.stringify(data.errors || data);
    console.error('[cryptomus] API error:', msg, 'path:', path);
    throw new Error(msg);
  }
  return data.result;
}

function isConfigured() {
  return Boolean(MERCHANT_ID && PAYMENT_KEY && PAYOUT_KEY);
}

/**
 * Hosted checkout for a card purchase.
 *
 * Unlike a consumer on-ramp, Cryptomus settles into OUR merchant balance rather
 * than sending straight to the player. `to_currency: USDC` makes it settle in
 * USDC, and the IPN handler then pays that out to the player's own USDC-SPL
 * deposit address — from which the existing chain monitor credits them. So the
 * player still ends up funded by the same audited path; there is just one extra
 * hop compared with a direct on-ramp.
 *
 * order_id carries the user id in the same `dep_{userId}_{coin}` shape the
 * static-wallet flow uses, because the IPN handler already parses that.
 */
async function createInvoice({ amountUsd, userId, returnUrl }) {
  if (!isConfigured()) throw new Error('Cryptomus is not configured');
  const result = await post('/payment', {
    amount:       String(amountUsd),
    currency:     'USD',      // priced in fiat — the card is charged this
    to_currency:  'USDC',     // settled to us in USDC
    order_id:     `dep_${userId}_usdcspl`,
    url_callback: `${process.env.BACKEND_URL}/api/webhooks/cryptomus`,
    url_return:   returnUrl,
    url_success:  returnUrl,
    lifetime:     3600,
  });
  return { url: result.url, uuid: result.uuid };
}

// Get (or create) a permanent static deposit address for a user+coin.
// Cryptomus returns the same address for the same order_id, so this is idempotent.
async function getDepositAddress(coin, userId) {
  const def = COINS[coin.toLowerCase()];
  if (!def) throw new Error(`Unsupported coin: ${coin}`);

  // order_id encodes userId so the webhook can identify the depositor
  // Format: dep_{userId}_{coin}  e.g. dep_423d2b0c-..._sol
  const result = await post('/wallet', {
    currency:     def.currency,
    network:      def.network,
    order_id:     `dep_${userId}_${coin.toLowerCase()}`,
    url_callback: `${process.env.BACKEND_URL}/api/webhooks/cryptomus`,
  });

  return {
    address: result.address,
    memo:    result.tag || null,
    coin,
  };
}

// Send crypto from our Cryptomus merchant balance to an external address.
// Used to forward received deposits to SimpleSwap, and to send USDC for withdrawals.
async function createPayout({ address, coin, amount }) {
  const def = COINS[coin.toLowerCase()];
  if (!def) throw new Error(`Unsupported payout coin: ${coin}`);

  const result = await post('/payout', {
    amount:       String(amount),
    currency:     def.currency,
    network:      def.network,
    address,
    order_id:     `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url_callback: `${process.env.BACKEND_URL}/api/webhooks/cryptomus`,
  }, true);

  return result;
}

// Verify Cryptomus webhook signature.
// Cryptomus sends { ...fields, sign: "<md5>" } in the POST body.
// We rebuild the sign from the body (minus the sign field) and compare.
function verifyWebhook(body) {
  const { sign, ...rest } = body;
  if (!sign) return false;
  // Re-sort keys to match Cryptomus canonical order (alphabetical)
  const sorted = Object.keys(rest).sort().reduce((acc, k) => {
    acc[k] = rest[k];
    return acc;
  }, {});
  const b64      = Buffer.from(JSON.stringify(sorted)).toString('base64');
  const expected = crypto.createHash('md5').update(b64 + PAYMENT_KEY).digest('hex');
  // Constant-time compare. MD5 is Cryptomus's spec so the digest itself is not
  // our choice, but a plain === leaks how many leading characters matched via
  // timing, which is the standard way to forge a signature one byte at a time.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(sign), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, createInvoice, getDepositAddress, createPayout, verifyWebhook, COINS };
