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
  return expected === sign;
}

module.exports = { getDepositAddress, createPayout, verifyWebhook, COINS };
