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
  usdt: 'usdtsol',
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

// Minimum for the WITHDRAWAL direction: USDC → coin, in USDC.
//
// getMinAmount above is the deposit direction (coin → USDC) and is the wrong
// number for a payout. ChangeNow's floor moves with the destination network's
// fees, so it is routinely higher than our own for ETH and can change hour to
// hour — which is why this is asked live rather than hardcoded.
//
// Returns 0 when it cannot be determined. Callers treat that as "no opinion"
// and fall back to the static minimum: a ChangeNow outage must not block every
// withdrawal on the site.
async function getWithdrawalMinUsd(coin) {
  const ticker = SS_TICKERS[coin.toLowerCase()];
  if (!ticker || ticker === BASE_STABLE) return 0;   // USDC needs no swap
  try {
    const data = await cnGet(`/min-amount/${BASE_STABLE}_${ticker}?api_key=${API_KEY}`);
    const min = parseFloat(data.minAmount);
    return Number.isFinite(min) && min > 0 ? min : 0;
  } catch {
    return 0;
  }
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
  // ChangeNow's v1 transaction status calls these amountSend and amountReceive.
  //
  // This read amountFrom and amountTo, which the response does not contain, so
  // `parseFloat(undefined || 0)` was 0 on every single call. swapPoller credits
  // the received amount and refuses anything under $3, so EVERY ChangeNow
  // deposit was read as zero USDC and never credited — which is why, in the
  // whole history of the platform, no BTC, ETH, LTC, DOGE or TRX deposit had
  // ever reached a player's balance. The money arrived every time; the number
  // saying how much did not.
  //
  // Found on a real $8 ETH deposit: status "finished", payoutHash present, and
  // amountReceive 7.46551 USDC sitting in our treasury, while the poller logged
  // "$0 USDC received, no user credit".
  //
  // The old names are kept as a fallback in case a v2 endpoint is ever used.
  return {
    status:       data.status,
    amountFrom:   parseFloat(data.amountSend    ?? data.amountFrom ?? 0),
    amountTo:     parseFloat(data.amountReceive ?? data.amountTo   ?? 0),
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
  getWithdrawalMinUsd,
  estimateDeposit,
  estimateWithdrawal,
  createDepositSwap,
  createWithdrawalSwap,
  getExchangeStatus,
};
