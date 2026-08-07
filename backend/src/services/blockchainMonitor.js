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

const fetch = require('node-fetch');
const { getAddress }        = require('./addressService');
const { sendCrypto }        = require('./chainSend');
const { createDepositSwap } = require('./simpleSwapService');
const { swapSolToUsdc }     = require('./jupiterService');

const POLL_INTERVAL_MS      = 45_000;
const OUR_FEE               = 0.001; // 0.1% platform fee on all deposits
// The UI shows a $5 min (SOL/USDC) and $10 min (other coins), but we credit
// generously: any deposit that nets at least MIN_CREDIT_USD in USDC (after the
// swap + network fees) is credited its exact received value minus the 0.1% fee.
// Only deposits worth under $3 are not credited.
const MIN_CREDIT_USD        = 3.00;

// CoinGecko IDs for price lookups
const COINGECKO_IDS = {
  btc:  'bitcoin',
  eth:  'ethereum',
  sol:  'solana',
  ltc:  'litecoin',
  trx:  'tron',
  doge: 'dogecoin',
  bnb:  'binancecoin',
  usdc: 'usd-coin',
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
  const key = process.env.ETHERSCAN_API_KEY || '';
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

async function fetchUsdcSplTxs(walletAddress) {
  const splToken = require('@solana/spl-token');
  const solWeb3  = require('@solana/web3.js');
  const USDC_MINT = new solWeb3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

  // Derive the associated token account address for USDC on this wallet
  let tokenAccountStr;
  try {
    const walletPubkey = new solWeb3.PublicKey(walletAddress);
    const tokenAccount = splToken.getAssociatedTokenAddressSync(USDC_MINT, walletPubkey);
    tokenAccountStr = tokenAccount.toBase58();
  } catch {
    return [];
  }

  // Get recent signatures for the token account
  const sigRes = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [tokenAccountStr, { limit: 10 }],
    }),
  });
  const sigData = await sigRes.json();
  const sigs = sigData.result || [];

  const results = [];
  for (const sig of sigs) {
    if (sig.err) continue;
    try {
      const txRes = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
      });
      const txData = await txRes.json();
      const tx = txData.result;
      if (!tx) continue;

      // Parse all instructions (including inner) for USDC transfer to our token account
      const allIx = [
        ...(tx.transaction?.message?.instructions || []),
        ...(tx.meta?.innerInstructions || []).flatMap(i => i.instructions || []),
      ];
      for (const ix of allIx) {
        const p = ix.parsed;
        if (!p?.info) continue;
        const { type, info } = p;
        if ((type === 'transfer' || type === 'transferChecked') &&
            info.destination === tokenAccountStr) {
          const amount = parseFloat(info.tokenAmount?.uiAmount ?? 0) ||
                         parseFloat(info.amount ?? 0) / 1e6;
          if (amount > 0) results.push({ txHash: sig.signature, amount, confirmed: true });
        }
      }
    } catch {}
  }
  return results;
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
    `https://api.trongrid.io/v1/accounts/${address}/transactions?only_confirmed=true&limit=20&direction=in`
  );
  const d = await r.json();
  if (!d.data) return [];
  return d.data
    .filter(tx => {
      const contract = tx.raw_data?.contract?.[0];
      if (contract?.type !== 'TransferContract') return false;
      const v = contract.parameter?.value;
      if (!v?.amount || v.amount <= 0) return false;
      // TronGrid returns to_address as hex — compare case-insensitively
      // Also accept if the decoded base58 matches
      return true;  // direction=in filter already ensures it's incoming
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
    case 'usdc': return fetchUsdcSplTxs(address);
    case 'ltc':
    case 'doge': return fetchBlockcypherTxs(coin, address);
    default:     return [];
  }
}

// ── Deposit processor ─────────────────────────────────────────────────────────

// In-memory cache of tx hashes we've already seen (processed OR skipped).
// Prevents repeated DB lookups and log spam for old/dust transactions.
const _seenTxs = new Set();

/**
 * Atomically claim a deposit before doing anything irreversible with it.
 *
 * The claim is an INSERT. The unique index on transactions.tx_hash is what makes
 * it atomic: exactly one caller can win, everyone else gets 23505 and backs off.
 * That index is load-bearing — without it this degrades to a plain insert that
 * always succeeds, and two monitor passes could both credit the same deposit.
 * See PENDING_SQL.sql.
 *
 * A previous attempt that gave up (pending_retry / failed) left funds sitting in
 * the deposit wallet, so those rows may be taken over — but only by whoever wins
 * the conditional UPDATE, which is atomic for the same reason.
 *
 * @returns {'claimed'|'taken'|'error'} 'taken' = someone else owns it, skip
 *          quietly. 'error' = could not record it, so do NOT credit; leaving it
 *          unclaimed lets the next poll retry cleanly.
 */
async function claimDeposit(supabase, row) {
  const { error } = await supabase.from('transactions').insert(row);
  if (!error) return 'claimed';

  if (error.code === '23505') {
    const { data: retaken } = await supabase
      .from('transactions')
      .update({ status: row.status })
      .eq('tx_hash', row.tx_hash)
      .in('status', ['pending_retry', 'failed'])
      .select('id');
    return (retaken && retaken.length) ? 'claimed' : 'taken';
  }

  console.error(`[monitor] claim failed for ${row.tx_hash} — not crediting:`, error.message);
  return 'error';
}

async function processDeposit(supabase, { userId, coin, address, txHash, amount }) {
  if (_seenTxs.has(txHash)) return; // already handled this poll cycle or prior

  // Idempotency check — did we already process this tx?
  const { data: dup } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('tx_hash', txHash)
    .maybeSingle();
  if (dup) {
    // pending_retry / failed = swap previously failed but SOL still in wallet — retry
    if (dup.status !== 'pending_retry' && dup.status !== 'failed') {
      _seenTxs.add(txHash);
      return;
    }
    // Fall through to retry the swap
  }

  // ── Gas reserve check (before any logging so dust txs produce no output) ──────
  // SOL reserve covers: ATA creation rent (~0.00204 SOL) + tx fees (~0.000005 SOL)
  const gasReserveMap = { btc: 0.00002, eth: 0.0004, bnb: 0.0005, sol: 0.003, ltc: 0.001, trx: 5, doge: 1 };
  const gasRes    = (coin !== 'usdc') ? (gasReserveMap[coin] || 0) : 0;
  const netAmount = Math.max(0, amount - gasRes);
  if (coin !== 'usdc' && netAmount <= 0) { _seenTxs.add(txHash); return; } // dust — silent

  console.log(`[monitor] deposit detected userId=${userId} coin=${coin} amount=${amount} tx=${txHash}`);

  const priceUsd     = await getPriceUsd(coin);
  const estimatedUsd = amount * priceUsd;

  const { creditCoins, recordDeposit } = require('./walletService');
  const gameEvents = require('./gameEvents');
  const usdcAddress = process.env.USDC_SPL_ADDRESS;

  // ── USDC: credit directly, no swap needed — apply 0.1% fee ──────────────────
  if (coin === 'usdc') {
    if (amount < MIN_CREDIT_USD) {
      console.warn(`[monitor] USDC $${amount.toFixed(2)} below $${MIN_CREDIT_USD} minimum — skipping ${txHash}`);
      _seenTxs.add(txHash);
      return;
    }
    const credited = Math.floor(amount * (1 - OUR_FEE) * 100) / 100;
    // Claim BEFORE crediting. If we credited first and crashed before recording,
    // a restart would re-credit the same deposit (minting money). Claiming first
    // flips the only failure window to a recorded-but-uncredited row — safe, and
    // reconcilable by hand.
    const claim = await claimDeposit(supabase, {
      user_id: userId, type: 'deposit', amount_c: credited,
      crypto_amount: amount, crypto_symbol: 'USDC', tx_hash: txHash, status: 'confirmed',
    });
    // 'taken' — already credited by an earlier pass; stop looking at it.
    if (claim === 'taken') { _seenTxs.add(txHash); return; }
    // 'error' — do NOT add to _seenTxs, so the next poll retries cleanly.
    if (claim !== 'claimed') return;

    await creditCoins(supabase, userId, credited);
    await recordDeposit(supabase, userId, credited, 'crypto');
    console.log(`[monitor] USDC deposit — received $${amount}, credited $${credited} (0.1% fee) to user ${userId}`);
    gameEvents.emit('deposit_credited', { userId, amount: credited, currency: 'coins' });
    _seenTxs.add(txHash);
    return;
  }

  // netAmount already computed above (amount - gasRes)

  // ── SOL: swap via Jupiter, credit exact USDC received minus 0.1% ─────────────
  if (coin === 'sol') {
    // netUsd is a CoinGecko price estimate — used only for logging and the
    // Jupiter-failure fallback. The real credit decision is made AFTER the swap
    // from the actual USDC received (see below), so a price-API blip can't cause
    // a real deposit to be swapped but left uncredited.
    const netUsd = netAmount * priceUsd;

    if (!usdcAddress) { console.error('[monitor] USDC_SPL_ADDRESS not set'); return; }
    const { privKey } = getAddress(userId, coin);

    // Claim before swapping, so a restart mid-swap cannot credit this twice.
    //
    // This used to be an upsert with { onConflict: 'tx_hash' }. Postgres cannot
    // infer a PARTIAL unique index from a bare ON CONFLICT (tx_hash), so against
    // uniq_deposit_tx_hash that upsert errors — and the error was swallowed by a
    // bare .catch(). The row was never written: missing from the user's history,
    // and invisible to the restart dup-check that is supposed to stop a second
    // credit. An insert-and-inspect claim needs no conflict target at all.
    const claim = await claimDeposit(supabase, {
      user_id: userId, type: 'deposit', amount_c: 0,
      crypto_amount: amount, crypto_symbol: 'SOL', tx_hash: txHash, status: 'converting',
    });
    if (claim === 'taken') { _seenTxs.add(txHash); return; }
    if (claim !== 'claimed') return;   // unrecorded — retry next poll, never credit

    // Swap SOL → USDC (awaited so we get the real output amount)
    let usdcReceived = 0;
    let swapTxHash   = null;
    try {
      const result = await swapSolToUsdc(privKey, netAmount, usdcAddress);
      usdcReceived  = result.usdcReceived;
      swapTxHash    = result.txHash;
      console.log(`[monitor] Jupiter swapped ${netAmount} SOL → ${usdcReceived} USDC tx=${swapTxHash}`);
    } catch (e) {
      console.error(`[monitor] Jupiter failed (${e.message}) — sending SOL to admin wallet`);
      try {
        const tx = await sendCrypto({ coin, privKey, toAddress: usdcAddress, amount: netAmount });
        console.log(`[monitor] fallback: sent ${netAmount} SOL to admin wallet tx=${tx}`);
        // Estimate USDC from price for fallback credit
        usdcReceived = netUsd;
      } catch (e2) {
        console.error(`[monitor] fallback failed:`, e2.message);
        // Mark pending_retry — the SOL is still in the deposit wallet, so a later
        // poll can take the claim back over and try again. The row is guaranteed
        // to exist here because we claimed it above, so one update is enough.
        const { error: retryErr } = await supabase.from('transactions')
          .update({ status: 'pending_retry' })
          .eq('tx_hash', txHash);
        if (retryErr) {
          console.error(`[monitor] CRITICAL: could not mark ${txHash} pending_retry — deposit is stranded as 'converting':`, retryErr.message);
        }
        return; // do NOT add to _seenTxs — allow retry next poll
      }
    }

    // Credit decision based on the ACTUAL USDC received from the swap, not the
    // CoinGecko estimate. (On the Jupiter-failure fallback above, usdcReceived is
    // set to the price estimate, so that rare path still uses the estimate.)
    const creditUser = usdcReceived >= MIN_CREDIT_USD;

    // Credit user with exact USDC received minus the 0.1% platform fee.
    const credited = creditUser ? Math.floor(usdcReceived * (1 - OUR_FEE) * 100) / 100 : 0;

    if (creditUser && credited > 0) {
      await creditCoins(supabase, userId, credited);
      await recordDeposit(supabase, userId, credited, 'crypto');
      gameEvents.emit('deposit_credited', { userId, amount: credited, currency: 'coins' });
      console.log(`[monitor] ✓ SOL credited $${credited} to user ${userId} ($${usdcReceived} USDC received, 0.1% fee)`);
    } else {
      console.log(`[monitor] SOL — swapped ${usdcReceived} USDC (below $${MIN_CREDIT_USD}), no user credit`);
    }

    await supabase.from('transactions')
      .update({ status: creditUser ? 'confirmed' : 'below_min', amount_c: credited })
      .eq('tx_hash', txHash);

    return;
  }

  // ── Non-SOL, non-USDC: forward to ChangeNow, swapPoller credits exact USDC received ─
  // Forward anything worth at least MIN_CREDIT_USD; swapPoller then credits the
  // exact USDC that arrives (minus the 0.1% fee) as long as it's >= MIN_CREDIT_USD.
  // No "platform keeps" band — players always get their money above the floor.
  if (estimatedUsd < MIN_CREDIT_USD) {
    console.warn(`[monitor] non-SOL $${estimatedUsd.toFixed(2)} below $${MIN_CREDIT_USD} min — skipping ${txHash}`);
    _seenTxs.add(txHash);
    return;
  }

  const creditUser = true; // credit is gated on the ACTUAL received USDC in swapPoller

  if (!usdcAddress) { console.error('[monitor] USDC_SPL_ADDRESS not set'); return; }
  const { privKey } = getAddress(userId, coin);

  // Claim the on-chain tx BEFORE creating the swap. The old order created the
  // exchange first and only recorded afterwards, so two passes over the same
  // deposit could both open an exchange and both forward funds — the same race
  // the Cryptomus webhook was fixed for.
  const rawClaim = await claimDeposit(supabase, {
    user_id: userId, type: 'deposit_raw', amount_c: 0,
    crypto_amount: amount, crypto_symbol: coin.toUpperCase(),
    tx_hash: txHash, status: 'forwarded',
  });
  if (rawClaim === 'taken') { _seenTxs.add(txHash); return; }
  if (rawClaim !== 'claimed') return;

  let swap;
  try {
    swap = await createDepositSwap({ coin, amount: netAmount, ourStableAddress: usdcAddress, refundAddress: '' });
  } catch (e) {
    // Nothing has moved yet, so release the claim rather than stranding the
    // deposit — the next poll retries from scratch.
    console.error(`[monitor] ChangeNow error for ${txHash}, releasing claim:`, e.message);
    await supabase.from('transactions').delete()
      .eq('tx_hash', txHash).eq('type', 'deposit_raw').eq('status', 'forwarded');
    return;
  }

  // Record as 'converting' — swapPoller polls until done then credits (if creditUser)
  await supabase.from('transactions').insert({
    user_id: userId, type: 'deposit', amount_c: 0,
    crypto_amount: netAmount, crypto_symbol: coin.toUpperCase(),
    tx_hash: swap.exchangeId, status: 'converting',
    extra_id: creditUser ? 'credit' : 'no_credit',
  });

  try {
    const sendTx = await sendCrypto({ coin, privKey, toAddress: swap.depositAddress, amount: netAmount });
    console.log(`[monitor] forwarded ${netAmount} ${coin} → ChangeNow exchange=${swap.exchangeId} creditUser=${creditUser} tx=${sendTx}`);
  } catch (e) {
    // Funds never left the deposit wallet. Hand the claim back so a later poll
    // can take it over, and close out the exchange row so swapPoller stops
    // waiting on USDC that will never arrive.
    console.error(`[monitor] sendCrypto failed for ${txHash}:`, e.message);
    await supabase.from('transactions')
      .update({ status: 'pending_retry' }).eq('tx_hash', txHash).eq('type', 'deposit_raw');
    await supabase.from('transactions')
      .update({ status: 'failed' }).eq('tx_hash', swap.exchangeId);
    return;
  }

  const { watch } = require('./swapPoller');
  watch(swap.exchangeId, userId, Date.now(), creditUser);
  console.log(`[monitor] watching exchange ${swap.exchangeId} creditUser=${creditUser}`);
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

module.exports = { init, claimDeposit };
