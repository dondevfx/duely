const fetch = require('node-fetch');

const NP_BASE = 'https://api.nowpayments.io/v1';

function headers() {
  return {
    'x-api-key': process.env.NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json',
  };
}

async function npFetch(path, opts = {}) {
  const res = await fetch(`${NP_BASE}${path}`, { ...opts, headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `NOWPayments ${res.status}`);
  return data;
}

// Create a deposit payment — returns pay_address, pay_amount, extra_id
// amountUsd defaults to 5 (minimum). User can send any amount >= 5.
async function createPayment({ amountUsd = 5, coin, orderId }) {
  return npFetch('/payment', {
    method: 'POST',
    body: JSON.stringify({
      price_amount:        Math.max(5, parseFloat(amountUsd)),
      price_currency:      'usd',
      pay_currency:        coin,
      order_id:            orderId,
      ipn_callback_url:    `${process.env.BACKEND_URL}/api/webhooks/nowpayments`,
      is_fee_paid_by_user: true,
      is_fixed_rate:       false,
    }),
  });
}

// Estimate how much crypto equals $amountUsd
async function getEstimate(amountUsd, coin) {
  return npFetch(`/estimate?amount=${amountUsd}&currency_from=usd&currency_to=${coin}`);
}

// Estimate how much USD equals coinAmount of coin
async function getCoinUsdEstimate(coinAmount, coin) {
  return npFetch(`/estimate?amount=${coinAmount}&currency_from=${coin}&currency_to=usd`);
}

// Minimum deposit amount for a coin (in that coin's units)
// currency_to=usdttrc20 reflects NowPayments' real conversion minimum for that coin
async function getMinAmount(coin) {
  return npFetch(`/min-amount?currency_from=${coin}&currency_to=usdttrc20`);
}

// Create a payout withdrawal — amount is in the target coin's units
async function createPayout({ address, coin, amount, extraId }) {
  const withdrawal = { address, currency: coin, amount: parseFloat(amount) };
  if (extraId) withdrawal.extra_id = extraId;
  return npFetch('/payout', {
    method: 'POST',
    body: JSON.stringify({
      ipn_callback_url: `${process.env.BACKEND_URL}/api/webhooks/nowpayments`,
      withdrawals: [withdrawal],
    }),
  });
}

// Get payment status by ID
async function getPaymentStatus(paymentId) {
  return npFetch(`/payment/${paymentId}`);
}

module.exports = { createPayment, getEstimate, getCoinUsdEstimate, getMinAmount, createPayout, getPaymentStatus };
