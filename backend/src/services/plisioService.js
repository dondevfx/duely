const fetch = require('node-fetch');
const crypto = require('crypto');

const PLISIO_BASE = 'https://api.plisio.net/api/v1';
const API_KEY = process.env.PLISIO_SECRET_KEY;

// Plisio coin IDs → our internal coin IDs
const PLISIO_COINS = {
  btc:       'BTC',
  eth:       'ETH',
  sol:       'SOL',
  ltc:       'LTC',
  trx:       'TRX',
  doge:      'DOGE',
  shib:      'SHIB',
  usdttrc20: 'USDT_TRX',
};

// Our internal coin IDs → Plisio coin IDs
const TO_PLISIO = Object.fromEntries(Object.entries(PLISIO_COINS).map(([k, v]) => [k, v]));

async function plisioGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${PLISIO_BASE}${path}${sep}api_key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (data.status === 'error') {
    throw new Error(data.data?.message || data.data?.name || 'Plisio error');
  }
  return data.data ?? data;
}

// Get or create a permanent deposit address for a user + coin combo.
// Plisio returns the same address every time for the same uid + psys_cid.
async function getDepositAddress(coin, userId) {
  const psisCid = PLISIO_COINS[coin.toLowerCase()];
  if (!psisCid) throw new Error(`Unsupported coin: ${coin}`);
  const data = await plisioGet(
    `/operations/deposit?psys_cid=${psisCid}&uid=${encodeURIComponent(userId)}`
  );
  return {
    address:   data.address,
    memo:      data.memo || null,   // for coins that need a memo/tag
    coin,
    psisCid,
  };
}

// Send a payout to a player's address.
// amount is in the target coin's units.
async function createPayout({ address, coin, amount }) {
  const psisCid = PLISIO_COINS[coin.toLowerCase()];
  if (!psisCid) throw new Error(`Unsupported coin: ${coin}`);
  const data = await plisioGet(
    `/operations/withdraw?psys_cid=${psisCid}&to=${encodeURIComponent(address)}&amount=${amount}&type=cash_out`
  );
  return data;
}

// Verify Plisio webhook signature.
// Plisio sends a verify_hash field inside the payload itself.
function verifyWebhook(body) {
  if (!body.verify_hash) return false;
  const { verify_hash, ...rest } = body;
  // Sort keys alphabetically, stringify, hash with secret key
  const sorted = Object.keys(rest).sort().reduce((acc, k) => {
    acc[k] = rest[k];
    return acc;
  }, {});
  const str = JSON.stringify(sorted);
  const expected = crypto
    .createHmac('sha1', API_KEY)
    .update(str)
    .digest('hex');
  return expected === verify_hash;
}

// Get current USD price for a coin from Plisio's currency list (cached 60s)
let _rateCache = {};
let _rateCacheTime = 0;
async function getUsdRate(psisCid) {
  const now = Date.now();
  if (now - _rateCacheTime > 60_000) {
    const data = await plisioGet('/currencies');
    _rateCache = {};
    (data || []).forEach(c => {
      if (c.cid) _rateCache[c.cid] = parseFloat(c.price_usd || 0);
    });
    _rateCacheTime = now;
  }
  return _rateCache[psisCid] || 0;
}

module.exports = { getDepositAddress, createPayout, verifyWebhook, getUsdRate, PLISIO_COINS };
