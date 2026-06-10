const fetch = require('node-fetch');

const SS_BASE  = 'https://api.simpleswap.io';
const API_KEY  = process.env.SIMPLESWAP_API_KEY;

// Our base stablecoin — USDC on Solana (near-zero transfer fees ~$0.001)
const BASE_STABLE = 'usdcspl';

// Map our internal coin IDs to SimpleSwap tickers
const SS_TICKERS = {
  btc:  'btc',
  eth:  'eth',
  sol:  'sol',
  ltc:  'ltc',
  trx:  'trx',
  doge: 'doge',
  bnb:  'bnbbsc',
  usdc: 'usdcspl',
};

async function ssGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${SS_BASE}${path}${sep}api_key=${API_KEY}`);
  const data = await res.json().catch(() => ({}));
  if (data.error || !res.ok) {
    throw new Error(data.message || data.error || `SimpleSwap ${res.status}`);
  }
  return data;
}

async function ssPost(path, body) {
  const res = await fetch(`${SS_BASE}${path}?api_key=${API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error || !res.ok) {
    throw new Error(data.message || data.error || `SimpleSwap ${res.status}`);
  }
  return data;
}

// Get min swap amount (in fromCurrency units) for a coin → BASE_STABLE swap
async function getMinAmount(coin) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker) throw new Error(`Unsupported coin: ${coin}`);
  const data = await ssGet(
    `/get_ranges?fixed=false&currency_from=${ticker}&currency_to=${BASE_STABLE}`
  );
  return parseFloat(data.min || 0);
}

// Estimate how much BASE_STABLE we receive for a given coin amount
async function estimateDeposit(coin, amount) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  const data = await ssGet(
    `/get_estimated?fixed=false&currency_from=${ticker}&currency_to=${BASE_STABLE}&amount=${amount}`
  );
  return parseFloat(data) || 0;
}

// Estimate how much coin a player receives for a given USD amount withdrawal
async function estimateWithdrawal(coin, amountUsd) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  const data = await ssGet(
    `/get_estimated?fixed=false&currency_from=${BASE_STABLE}&currency_to=${ticker}&amount=${amountUsd}`
  );
  return parseFloat(data) || 0;
}

// Create a deposit conversion swap: coin → BASE_STABLE → our stablecoin wallet
// Returns the address to send the coin to, and the exchange ID for polling.
async function createDepositSwap({ coin, amount, ourStableAddress, refundAddress }) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker) throw new Error(`Unsupported coin: ${coin}`);
  const exchange = await ssPost('/create_exchange', {
    fixed:                false,
    currency_from:        ticker,
    currency_to:          BASE_STABLE,
    amount,
    address_to:           ourStableAddress,
    extra_id_to:          '',
    user_refund_address:  refundAddress || '',
    user_refund_extra_id: '',
  });
  return {
    exchangeId:      exchange.id,
    depositAddress:  exchange.address_from,  // where we send the coin
    estimatedOutput: parseFloat(exchange.amount_to || 0),
  };
}

// Create a withdrawal swap: BASE_STABLE → coin → player's address
// Returns the address to send our USDC to, and the exchange ID.
async function createWithdrawalSwap({ coin, amountUsd, playerAddress, playerMemo }) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker) throw new Error(`Unsupported coin: ${coin}`);
  const exchange = await ssPost('/create_exchange', {
    fixed:                false,
    currency_from:        BASE_STABLE,
    currency_to:          ticker,
    amount:               amountUsd,
    address_to:           playerAddress,
    extra_id_to:          playerMemo || '',
    user_refund_address:  '',
    user_refund_extra_id: '',
  });
  return {
    exchangeId:      exchange.id,
    depositAddress:  exchange.address_from,  // where we send our USDC
    estimatedOutput: parseFloat(exchange.amount_to || 0),
  };
}

// Poll a swap's status. Possible statuses:
//   waiting → confirming → exchanging → sending → finished
//   failed | refunded | expired
async function getExchangeStatus(exchangeId) {
  const data = await ssGet(`/get_exchange?id=${exchangeId}`);
  return {
    status:        data.status,            // e.g. 'finished'
    amountFrom:    parseFloat(data.amount_from || 0),
    amountTo:      parseFloat(data.amount_to || 0),  // actual output (set when finished)
    currencyFrom:  data.currency_from,
    currencyTo:    data.currency_to,
    txFrom:        data.tx_from,
    txTo:          data.tx_to,
  };
}

module.exports = {
  BASE_STABLE,
  SS_TICKERS,
  getMinAmount,
  estimateDeposit,
  estimateWithdrawal,
  createDepositSwap,
  createWithdrawalSwap,
  getExchangeStatus,
};
