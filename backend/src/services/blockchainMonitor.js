/**
 * blockchainMonitor.js
 *
 * Background service that polls each active deposit address for new incoming
 * transactions. When a deposit is detected:
 *   1. Get USD value via CoinGecko (free, no key)
 *   2. Check >= $4.50 minimum
 *   3. Create SimpleSwap exchange (coin → USDC SPL)
 *   4. Forward received crypto to SimpleSwap deposit address (chainSend)
 *   5. Insert transaction as 'converting' — swapPoller credits player when done
 *
 * Polling interval: 45 seconds per address (staggered to avoid rate limits)
 * Addresses are loaded from `deposit_addresses` table on start.
 */

const fetch     = require('node-fetch');
const { getAddress }         = require('./addressService');
const { sendCrypto, GAS_RESERVE } = require('./chainSend');
const { createDepositSwap }  = require('./simpleSwapService');
const { watch }              = require('./swapPoller');

const POLL_INTERVAL_MS = 45_000;
const MIN_USD          = 4.50;
const OUR_USDC_ADDRESS = () => process.env.USDC_SPL_ADDRESS;

// CoinGecko IDs for price lookups
const COINGECKO_IDS = {
  btc:  'bitcoin',
  eth:  'ethereum',
  sol:  'solana',
  ltc:  'litecoin',
  trx:  'tron',
  doge: 'dogecoin',
  bnb:  'binancecoin',
  xrp:  'ripple',
};

// Price cache
let _prices     = {};
let _priceTime  = 0;

async function getPriceUsd(coin) {
  if (Date.now() - _priceTime > 60_000) {
    try {
      const ids = Object.values(COINGECKO_IDS).join(',');
      const r   = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
      const d   = await r.json();
      _prices = {};
      for (const [coin, id] of Object.entries(COINGECKO_IDS)) {
        _prices[coin] = d[id]?.usd || 0;
      }
      _priceTime = Date.now();
    } catch (e) {
      console.error('[monitor] price fetch error:', e.message);
    }
  }
  return _prices[coin.toLowerCase()] || 0;
}

// ── Blockchain API fetchers ───────────────────────────────────────────────────

// Returns array of { txHash, amount (in coin units), confirmed }
async function fetchBtcTxs(address) {
  const r = await fetch(`https://blockstream.info/api/address/${address}/txs`);
  const txs = await r.json();
  if (!Array.isArray(txs)) return [];
  return txs.map(tx => {
    const out = tx.vout?.find(o => o.scriptpubkey_address === address);
    const satoshis = out?.value || 0;
    return {
      txHash:    tx.txid,
      amount:    satoshis / 1e8,
      confirmed: tx.status?.confirmed ?? false,
    };
  }).filter(t => t.amount > 0);
}

async function fetchEthTxs(address) {
  const key = process.env.ETHERSCAN_API_KEY || '';
  const r = await fetch(
    `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${key}`
  );
  const d = await r.json();
  if (d.status !== '1') return [];
  return d.result
    .filter(tx => tx.to?.toLowerCase() === address.toLowerCase() && tx.isError === '0')
    .map(tx => ({
      txHash:    tx.hash,
      amount:    parseFloat(tx.value) / 1e18,
      confirmed: parseInt(tx.confirmations) >= 1,
    }))
    .filter(t => t.amount > 0);
}

async function fetchBnbTxs(address) {
  const key = process.env.BSCSCAN_API_KEY || '';
  const r = await fetch(
    `https://api.bscscan.com/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${key}`
  );
  const d = await r.json();
  if (d.status !== '1') return [];
  return d.result
    .filter(tx => tx.to?.toLowerCase() === address.toLowerCase() && tx.isError === '0')
    .map(tx => ({
      txHash:    tx.hash,
      amount:    parseFloat(tx.value) / 1e18,
      confirmed: parseInt(tx.confirmations) >= 1,
    }))
    .filter(t => t.amount > 0);
}

async function fetchXrpTxs(address) {
  const r = await fetch(
    `https://api.xrpscan.com/api/v1/account/${address}/transactions?type=Payment`
  );
  const d = await r.json();
  if (!d.transactions) return [];
  return d.transactions
    .filter(tx => tx.Destination === address && tx.Amount && typeof tx.Amount === 'string')
    .map(tx => ({
      txHash:    tx.hash,
      amount:    parseInt(tx.Amount) / 1_000_000,  // drops → XRP
      confirmed: true,
    }))
    .filter(t => t.amount > 0);
}

async function fetchSolTxs(address) {
  const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const r   = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'getSignaturesForAddress',
      params:  [address, { limit: 10 }],
    }),
  });
  const d = await r.json();
  const sigs = d.result || [];

  const results = [];
  for (const sig of sigs) {
    if (sig.err) continue;
    try {
      const txR = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'getTransaction',
          params:  [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
      });
      const txD = await txR.json();
      const tx  = txD.result;
      if (!tx) continue;

      // Find balance change for our address
      const accIdx = tx.transaction.message.accountKeys?.findIndex(
        k => (k.pubkey || k) === address
      );
      if (accIdx === -1) continue;
      const pre  = tx.meta?.preBalances?.[accIdx]  || 0;
      const post = tx.meta?.postBalances?.[accIdx] || 0;
      const lamports = post - pre;
      if (lamports <= 0) continue;

      results.push({
        txHash:    sig.signature,
        amount:    lamports / 1e9,
        confirmed: !sig.err,
      });
    } catch {}
  }
  return results;
}

async function fetchTrxTxs(address) {
  const r = await fetch(
    `https://api.trongrid.io/v1/accounts/${address}/transactions?only_confirmed=true&limit=20`
  );
  const d = await r.json();
  if (!d.data) return [];
  return d.data
    .filter(tx => {
      const contract = tx.raw_data?.contract?.[0];
      if (contract?.type !== 'TransferContract') return false;
      const v = contract.parameter?.value;
      return v?.to_address === address && v?.amount > 0;
    })
    .map(tx => ({
      txHash:    tx.txID,
      amount:    tx.raw_data.contract[0].parameter.value.amount / 1e6,
      confirmed: true,
    }));
}

async function fetchUsdtTrc20Txs(address) {
  const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const r = await fetch(
    `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?only_confirmed=true&limit=20&contract_address=${usdtContract}`
  );
  const d = await r.json();
  if (!d.data) return [];
  return d.data
    .filter(tx => tx.to === address && parseFloat(tx.value) > 0)
    .map(tx => ({
      txHash:    tx.transaction_id,
      amount:    parseFloat(tx.value) / 1e6,
      confirmed: true,
    }));
}

async function fetchBlockcypherTxs(coin, address) {
  const chains = { btc: 'btc/main', ltc: 'ltc/main', doge: 'doge/main' };
  const chain  = chains[coin];
  const token  = process.env.BLOCKCYPHER_TOKEN ? `?token=${process.env.BLOCKCYPHER_TOKEN}` : '';
  const r = await fetch(`https://api.blockcypher.com/v1/${chain}/addrs/${address}/full?limit=5${token}`);
  const d = await r.json();
  if (!d.txs) return [];
  return d.txs.map(tx => {
    const out = tx.outputs?.find(o => o.addresses?.includes(address));
    const val = out?.value || 0;
    return {
      txHash:    tx.hash,
      amount:    val / 1e8,
      confirmed: (tx.confirmations || 0) >= 1,
    };
  }).filter(t => t.amount > 0);
}

async function fetchTxs(coin, address) {
  switch (coin) {
    case 'btc':  return fetchBtcTxs(address);
    case 'eth':  return fetchEthTxs(address);
    case 'bnb':  return fetchBnbTxs(address);
    case 'sol':  return fetchSolTxs(address);
    case 'trx':  return fetchTrxTxs(address);
    case 'xrp':  return fetchXrpTxs(address);
    case 'ltc':
    case 'doge': return fetchBlockcypherTxs(coin, address);
    default:     return [];
  }
}

// ── Deposit processor ─────────────────────────────────────────────────────────

async function processDeposit(supabase, { userId, coin, address, txHash, amount }) {
  console.log(`[monitor] deposit detected userId=${userId} coin=${coin} amount=${amount} tx=${txHash}`);

  // Idempotency check — did we already process this tx?
  const { data: dup } = await supabase
    .from('transactions')
    .select('id')
    .eq('tx_hash', txHash)
    .maybeSingle();
  if (dup) {
    console.log(`[monitor] ${txHash} already processed — skipping`);
    return;
  }

  // USD value check
  const priceUsd = await getPriceUsd(coin);
  const estimatedUsd = amount * priceUsd;
  if (estimatedUsd < MIN_USD) {
    console.warn(`[monitor] $${estimatedUsd.toFixed(2)} below minimum — skipping ${txHash}`);
    return;
  }

  const usdc = OUR_USDC_ADDRESS();
  if (!usdc) {
    console.error('[monitor] USDC_SPL_ADDRESS not configured');
    return;
  }

  // Deduct realistic gas reserve so we don't try to send more than we can
  const gasReserveMap = { btc: 0.00002, eth: 0.0004, bnb: 0.0005, sol: 0.000005, ltc: 0.001, trx: 5, doge: 1, xrp: 0.01 };
  const gasRes   = gasReserveMap[coin] || 0;
  const netAmount = Math.max(0, amount - gasRes);
  if (netAmount <= 0) {
    console.warn(`[monitor] amount ${amount} too small after gas reserve — skipping`);
    return;
  }

  // Create SimpleSwap exchange: coin → USDC SPL
  let swap;
  try {
    swap = await createDepositSwap({ coin, amount: netAmount, ourStableAddress: usdc, refundAddress: '' });
  } catch (e) {
    console.error(`[monitor] SimpleSwap error for ${txHash}:`, e.message);
    return;
  }

  // Insert converting transaction BEFORE sending (prevents double-send on crash)
  await supabase.from('transactions').insert({
    user_id:       userId,
    type:          'deposit',
    amount_c:      0,
    crypto_amount: netAmount,
    crypto_symbol: coin.toUpperCase(),
    tx_hash:       swap.exchangeId,
    status:        'converting',
  });

  // Mark original on-chain tx so we don't reprocess it
  await supabase.from('transactions').insert({
    user_id:       userId,
    type:          'deposit_raw',
    amount_c:      0,
    crypto_amount: amount,
    crypto_symbol: coin.toUpperCase(),
    tx_hash:       txHash,
    status:        'forwarded',
  }).then().catch(() => {});   // best-effort

  // Get our private key for this address and send crypto to SimpleSwap
  const { privKey } = getAddress(userId, coin);
  try {
    const sendTxHash = await sendCrypto({
      coin,
      privKey,
      toAddress: swap.depositAddress,
      amount:    netAmount,
    });
    console.log(`[monitor] forwarded ${netAmount} ${coin} → SimpleSwap tx=${sendTxHash}`);
  } catch (e) {
    console.error(`[monitor] sendCrypto failed for ${txHash}:`, e.message);
    // Transaction already inserted as 'converting' — swapPoller will timeout and mark 'stuck'
  }

  // Start polling SimpleSwap for USDC arrival
  watch(swap.exchangeId, userId);
}

// ── Main polling loop ─────────────────────────────────────────────────────────

let supabaseRef = null;

// Load all watched addresses from DB
async function loadAddresses() {
  const { data } = await supabaseRef
    .from('deposit_addresses')
    .select('user_id, coin, address');
  return data || [];
}

async function pollOnce(supabase) {
  const addresses = await loadAddresses();
  if (!addresses.length) return;

  // Stagger polls so we don't hammer APIs all at once
  for (let i = 0; i < addresses.length; i++) {
    const { user_id, coin, address } = addresses[i];
    try {
      const txs = await fetchTxs(coin, address);
      for (const tx of txs) {
        if (!tx.confirmed) continue;
        await processDeposit(supabase, {
          userId:  user_id,
          coin,
          address,
          txHash:  tx.txHash,
          amount:  tx.amount,
        });
      }
    } catch (e) {
      console.error(`[monitor] poll error ${coin}/${address}:`, e.message);
    }
    // Small delay between addresses to avoid rate limiting
    if (i < addresses.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

function init(supabase) {
  supabaseRef = supabase;
  console.log('[monitor] blockchain monitor started');

  async function loop() {
    await pollOnce(supabase).catch(e => console.error('[monitor] loop error:', e.message));
    setTimeout(loop, POLL_INTERVAL_MS);
  }

  // Start after 10s to let server fully boot
  setTimeout(loop, 10_000);
}

module.exports = { init };
