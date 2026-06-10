const fetch = require('node-fetch');

const CN_BASE = 'https://api.changenow.io/v1';
const API_KEY = process.env.CHANGENOW_API_KEY;

// Our base stablecoin — USDC on Solana
const BASE_STABLE = 'usdcsol';

// Map our internal coin IDs to ChangeNow tickers
const SS_TICKERS = {
  btc:  'btc',
  eth:  'eth',
  sol:  'sol',
  ltc:  'ltc',
  trx:  'trx',
  doge: 'doge',
  bnb:  'bnbbsc',
  usdc: 'usdcsol',
};

async function cnGet(path) {
  const res  = await fetch(`${CN_BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `ChangeNow ${res.status}`);
  return data;
}

async function cnPost(path, body) {
  const res  = await fetch(`${CN_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `ChangeNow ${res.status}`);
  return data;
}

// Get min swap amount for a coin → USDC swap
async function getMinAmount(coin) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker) throw new Error(`Unsupported coin: ${coin}`);
  const data = await cnGet(`/min-amount/${ticker}_${BASE_STABLE}?api_key=${API_KEY}`);
  return parseFloat(data.minAmount || 0);
}

// Estimate how much USDC we receive for a given coin amount
async function estimateDeposit(coin, amount) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  const data   = await cnGet(`/exchange-amount/${amount}/${ticker}_${BASE_STABLE}/?api_key=${API_KEY}`);
  return parseFloat(data.estimatedAmount || 0);
}

// Estimate how much coin a player receives for a given USD amount withdrawal
async function estimateWithdrawal(coin, amountUsd) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  const data   = await cnGet(`/exchange-amount/${amountUsd}/${BASE_STABLE}_${ticker}/?api_key=${API_KEY}`);
  return parseFloat(data.estimatedAmount || 0);
}

// Create a deposit swap: coin → USDC → our Phantom wallet
async function createDepositSwap({ coin, amount, ourStableAddress, refundAddress }) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker) throw new Error(`Unsupported coin: ${coin}`);
  const exchange = await cnPost(`/transactions/${API_KEY}`, {
    from:           ticker,
    to:             BASE_STABLE,
    amount,
    address:        ourStableAddress,
    extraId:        '',
    refundAddress:  refundAddress || '',
    refundExtraId:  '',
    userId:         '',
    payload:        '',
    contactEmail:   '',
  });
  return {
    exchangeId:      exchange.id,
    depositAddress:  exchange.payinAddress,
    estimatedOutput: parseFloat(exchange.amount || 0),
  };
}

// Create a withdrawal swap: USDC → coin → player's address
async function createWithdrawalSwap({ coin, amountUsd, playerAddress, playerMemo }) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker) throw new Error(`Unsupported coin: ${coin}`);
  const exchange = await cnPost(`/transactions/${API_KEY}`, {
    from:           BASE_STABLE,
    to:             ticker,
    amount:         amountUsd,
    address:        playerAddress,
    extraId:        playerMemo || '',
    refundAddress:  '',
    refundExtraId:  '',
    userId:         '',
    payload:        '',
    contactEmail:   '',
  });
  return {
    exchangeId:      exchange.id,
    depositAddress:  exchange.payinAddress,
    estimatedOutput: parseFloat(exchange.amount || 0),
  };
}

// Get exchange status
// ChangeNow statuses: waiting, confirming, exchanging, sending, finished, failed, refunded, expired
async function getExchangeStatus(exchangeId) {
  const data = await cnGet(`/transactions/${exchangeId}/${API_KEY}`);
  return {
    status:       data.status,
    amountFrom:   parseFloat(data.amountFrom || 0),
    amountTo:     parseFloat(data.amountTo   || 0),
    currencyFrom: data.fromCurrency,
    currencyTo:   data.toCurrency,
    txFrom:       data.payinHash,
    txTo:         data.payoutHash,
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
