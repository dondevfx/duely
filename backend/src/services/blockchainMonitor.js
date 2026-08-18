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
const { sendCrypto, sweepUsdc } = require('./chainSend');
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
      const r   = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
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

// A request that cannot hang forever.
//
// node-fetch has no default timeout, so a provider that accepts the connection
// and then goes quiet stalls that coin's entire poll pass — every address
// behind it waits on one dead socket.
async function fetchWithTimeout(url, opts = {}, ms = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Returns array of { txHash, amount (in coin units), confirmed }
//
// Two providers, because this is the ONLY way a BTC deposit is noticed. It read
// blockstream.info alone, so when they were unreachable —
//
//   [monitor] poll error btc/17pF7...: request to https://blockstream.info/... failed
//
// — Bitcoin deposits simply stopped being detected. Nothing was lost (the coins
// sit in the deposit address and the next successful poll finds them), but
// every player depositing during the outage waits with no explanation.
//
// BlockCypher is the fallback rather than the primary because its free tier
// caps per hour as well as per second, and it is already the sole provider for
// LTC and DOGE. Used only when blockstream fails, that budget is untouched on a
// normal day.
async function fetchBtcTxs(address) {
  try {
    const r = await fetchWithTimeout(`https://blockstream.info/api/address/${address}/txs`);
    const txs = await r.json();
    if (Array.isArray(txs)) {
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
    throw new Error('blockstream returned a non-array response');
  } catch (e) {
    console.warn(`[monitor] blockstream failed for ${address} (${e.message}) — trying BlockCypher`);
    // Let this one throw: if BOTH providers are down, the caller's per-address
    // catch logs it and the next poll retries. Swallowing it would report "no
    // deposits" for an address we could not actually read, which is the same
    // shape of lie as a price of 0 meaning "worthless".
    return fetchBlockcypherTxs('btc', address);
  }
}

// An Etherscan-family response that is not a success.
//
// status '0' with "No transactions found" is the normal empty case for an
// address nobody has paid yet. Anything else — a rejected key, a rate limit, a
// retired endpoint — was being returned as an empty list, indistinguishable
// from "no deposits arrived".
//
// `result` is the field that actually says WHY. message is always the useless
// "NOTOK"; result carries "Invalid API Key", "Max rate limit reached", or the
// deprecation notice. Logging only message told us something was wrong without
// telling us what, which cost a round trip.
function explorerMiss(coin, address, d) {
  const msg = String(d?.message || '');
  if (/no transactions found/i.test(msg)) return;   // genuinely empty, not a fault
  const why = typeof d?.result === 'string' ? d.result : JSON.stringify(d?.result ?? null);
  console.warn(`[monitor] ${coin} explorer refused: status=${d?.status} message="${msg}" ` +
    `result="${String(why).slice(0, 200)}" address=${address} — treating as no deposits, which may be wrong`);
}

// ETH and BNB share one client, because Etherscan V2 serves every chain from a
// single endpoint keyed by chainid — and one Etherscan API key covers them all.
//
// The V1 hosts these used (api.etherscan.io/api and api.bscscan.com/api) are
// retired. Every request to them comes back status=0 message="NOTOK", which the
// old code turned into an empty list — so ETH and BNB deposits were never
// detected and nothing said so.
//
// That also explains BSCSCAN_API_KEY being configured and referenced nowhere:
// under V2 there is no separate BscScan key to reference. It is still accepted
// as a fallback for BNB in case the two keys really are different here.
const EVM_CHAIN_IDS = { eth: 1, bnb: 56 };

async function fetchEvmTxs(coin, address) {
  const key = coin === 'bnb'
    ? (process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || '')
    : (process.env.ETHERSCAN_API_KEY || '');
  const chainId = EVM_CHAIN_IDS[coin];

  const r = await fetchWithTimeout(
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=account&action=txlist&address=${address}&sort=desc&apikey=${key}`
  );
  const d = await r.json();
  if (d.status !== '1') { explorerMiss(coin, address, d); return []; }
  if (!Array.isArray(d.result)) { explorerMiss(coin, address, d); return []; }

  return d.result
    .filter(tx => tx.to?.toLowerCase() === address.toLowerCase() && tx.isError === '0')
    .map(tx => ({
      txHash:    tx.hash,
      amount:    parseFloat(tx.value) / 1e18,
      confirmed: parseInt(tx.confirmations) >= 1,
    }))
    .filter(t => t.amount > 0);
}

const fetchEthTxs = (address) => fetchEvmTxs('eth', address);
const fetchBnbTxs = (address) => fetchEvmTxs('bnb', address);

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
  const sigRes = await fetchWithTimeout(rpc, {
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
      const txRes = await fetchWithTimeout(rpc, {
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
  const r   = await fetchWithTimeout(rpc, {
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
      const txR = await fetchWithTimeout(rpc, {
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
  const r = await fetchWithTimeout(
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
  const r = await fetchWithTimeout(
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
  const r = await fetchWithTimeout(`https://api.blockcypher.com/v1/${chain}/addrs/${address}/full?limit=5${token}`);
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

// Consecutive swap-creation failures per on-chain tx.
//
// A ChangeNow error is usually transient — rate limit, a blip — and retrying on
// the next poll is right. But it is ALSO what happens when the deposit is below
// the exchange's own minimum, and that never resolves: the swap is refused
// every 45 seconds forever while the coin sits in the deposit address.
//
// Releasing the claim each time deleted the row, so a permanently stranded
// deposit left no durable record at all — invisible to the admin queue, with
// nothing but a log line repeating twice a minute. After SWAP_FAIL_LIMIT tries
// the claim is KEPT and marked stuck, which both stops the loop and puts it in
// front of an operator with the exchange's own error attached.
const _swapFailures = new Map();
const SWAP_FAIL_LIMIT = 3;

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
  // Held back to pay the fee for forwarding the deposit out of its address.
  //
  // TRX was 5 (~$1.68), which is 17% of a $10 deposit. A TRON transfer uses
  // ~265 bandwidth and every account gets ~600 free bandwidth a day, so a
  // single forward per address is usually free and 0.267 TRX at worst. 2 is
  // still roughly 7x the worst case.
  //
  // BTC's 2000 sats is deliberately NOT reduced. It covers up to ~8.8 sat/vB
  // and the network sits at 1 today, but Bitcoin fees spike hard — cutting it
  // would turn a busy day into failed forwards, which is worse than
  // over-reserving on a quiet one.
  const gasReserveMap = { btc: 0.00002, eth: 0.0004, bnb: 0.0005, sol: 0.003, ltc: 0.001, trx: 2, doge: 1 };
  const gasRes    = (coin !== 'usdc') ? (gasReserveMap[coin] || 0) : 0;
  const netAmount = Math.max(0, amount - gasRes);
  if (coin !== 'usdc' && netAmount <= 0) { _seenTxs.add(txHash); return; } // dust — silent

  console.log(`[monitor] deposit detected userId=${userId} coin=${coin} amount=${amount} tx=${txHash}`);

  const priceUsd     = await getPriceUsd(coin);
  const estimatedUsd = amount * priceUsd;

  // A price of 0 means the LOOKUP FAILED, not that the coin is worthless.
  //
  // getPriceUsd returns 0 when CoinGecko errors or rate-limits. Everything
  // downstream then values the deposit at $0.00, decides it is below the $3
  // minimum, and adds it to _seenTxs — which is never cleared, so a real
  // deposit was discarded for the rest of the process's life by a transient
  // API blip. That is exactly what happened to a live BTC deposit:
  //
  //   [monitor] non-SOL $0.00 below $3 min — skipping c004a08a...
  //
  // Returning WITHOUT marking it seen leaves it for the next poll, where the
  // price will almost certainly be back.
  if (coin !== 'usdc' && !(priceUsd > 0)) {
    console.warn(`[monitor] no USD price for ${coin} — leaving ${txHash} for the next poll`);
    return;
  }

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

    // Consolidate into the payout wallet. USDC is the one coin that used to stop
    // here: it needs no swap, so the forward was never written, and deposits sat
    // in per-user addresses while withdrawals drained a wallet nothing refilled.
    //
    // Deliberately after the credit and deliberately non-fatal. The player is
    // already paid and the funds are in an address we derive from the master
    // secret, so a failed sweep costs nothing — and sweepUsdc moves the whole
    // balance, so the next deposit to this address collects what this run missed.
    try {
      const { privKey } = getAddress(userId, 'usdc');
      const swept = await sweepUsdc(privKey);
      if (swept) console.log(`[monitor] swept ${swept.amount} USDC to payout wallet tx=${swept.txHash}`);
    } catch (e) {
      console.error(`[monitor] USDC sweep failed for user ${userId} (funds are safe in the deposit address):`, e.message);
    }
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
    const fails = (_swapFailures.get(txHash) || 0) + 1;
    _swapFailures.set(txHash, fails);

    if (fails < SWAP_FAIL_LIMIT) {
      // Probably transient. Nothing has moved, so release the claim and let the
      // next poll start over.
      console.error(`[monitor] ChangeNow error for ${txHash} (${fails}/${SWAP_FAIL_LIMIT}), releasing claim:`, e.message);
      await supabase.from('transactions').delete()
        .eq('tx_hash', txHash).eq('type', 'deposit_raw').eq('status', 'forwarded');
      return;
    }

    // Persistent — almost always a deposit under the exchange's minimum. Keep
    // the claim so the row survives, mark it stuck so it reaches the admin
    // queue, and stop retrying. The coin is still in the player's deposit
    // address and is recoverable by hand.
    console.error(`[monitor] ChangeNow error for ${txHash} — giving up after ${fails}, marking stuck:`, e.message);
    await supabase.from('transactions')
      .update({ status: 'stuck', notes: `swap creation failed ${fails}x: ${String(e.message).slice(0, 200)}` })
      .eq('tx_hash', txHash).eq('type', 'deposit_raw')
      .then().catch(() => {});
    _seenTxs.add(txHash);
    _swapFailures.delete(txHash);
    return;
  }
  // Cleared it — do not let a past blip count toward a future give-up.
  _swapFailures.delete(txHash);

  // Record as 'converting' — swapPoller polls until done then credits (if creditUser)
  //
  // This is the single most load-bearing row in the deposit flow. It is the
  // only record that a swap is in flight, and the ONLY thing swapPoller's
  // restart-resume reads. Without it, a container restart — which Railway does
  // on every deploy — loses the watcher, and when ChangeNow finishes, the USDC
  // lands in our wallet and the player is never credited.
  //
  // Its failure used to be silent: no error check, no log, no retry. So the one
  // row that must exist could fail to be written and nothing would say so.
  const { error: convErr } = await supabase.from('transactions').insert({
    user_id: userId, type: 'deposit', amount_c: 0,
    crypto_amount: netAmount, crypto_symbol: coin.toUpperCase(),
    tx_hash: swap.exchangeId, status: 'converting',
    extra_id: creditUser ? 'credit' : 'no_credit',
  });
  if (convErr) {
    // Do NOT forward. This runs BEFORE sendCrypto, so the coins are still in
    // the player's deposit address and nothing has moved yet.
    //
    // Forwarding anyway would send real money to ChangeNow with no record that
    // it is owed back — recoverable only from a log line, and only until the
    // container restarts. Stopping here keeps the coins where they are, which
    // is the same claim-before-act discipline the rest of this path uses.
    //
    // The deposit_raw claim is handed back so a later poll retries the whole
    // thing from the top once the database is accepting the row again.
    console.error(
      `[monitor] could not record the converting row for ${txHash} ` +
      `(user ${userId}, ${netAmount} ${coin}) — NOT forwarding; coins stay in the deposit address:`,
      convErr.message);
    await supabase.from('transactions')
      .update({ status: 'pending_retry' }).eq('tx_hash', txHash).eq('type', 'deposit_raw')
      .then().catch(() => {});
    return;   // deliberately not _seenTxs — the next poll must try again
  }

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

// Per-address delay, chosen per provider rather than one number for everything.
// The old flat 500ms was set by the slowest provider and then applied to all of
// them, which is the expensive part: a BlockCypher limit has nothing to do with
// how fast Etherscan or Helius will answer.
//
// BlockCypher stays at 500ms — its free tier caps per hour as well as per
// second, so it is the one worth being careful with. Etherscan-family allows
// ~5/s, Helius considerably more.
const COIN_DELAY_MS = {
  btc: 500, ltc: 500, doge: 500,   // BlockCypher
  eth: 250, bnb: 250, trx: 250,    // Etherscan / BscScan / TronGrid
  sol: 120, usdc: 120,             // Helius
};
const DEFAULT_DELAY_MS = 500;

async function pollCoin(supabase, coin, list) {
  const delay = COIN_DELAY_MS[coin] ?? DEFAULT_DELAY_MS;
  for (let i = 0; i < list.length; i++) {
    const { user_id, address } = list[i];
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
    if (i < list.length - 1) await new Promise(r => setTimeout(r, delay));
  }
}

async function pollOnce(supabase) {
  const addresses = await loadAddresses();
  if (!addresses.length) return;

  // Coins run in parallel, addresses within a coin stay staggered.
  //
  // The whole list used to be walked as one sequence, so a BTC address waited
  // behind every SOL address and vice versa even though they hit unrelated APIs.
  // Every user has an address per coin, so that made a full pass cost
  // users x coins x 500ms — at a few hundred users a pass took longer than the
  // 45s interval, and detection latency grew with signups.
  //
  // Splitting by coin divides the pass by the number of coins at zero cost to
  // any provider's rate limit, since each group talks to a different one.
  const byCoin = new Map();
  for (const a of addresses) {
    if (!byCoin.has(a.coin)) byCoin.set(a.coin, []);
    byCoin.get(a.coin).push(a);
  }

  const startedAt = Date.now();
  await Promise.all(
    [...byCoin].map(([coin, list]) => pollCoin(supabase, coin, list))
  );

  // A pass that outruns the interval is the signal that this needs revisiting —
  // per-provider limits, not the loop shape, are the ceiling beyond this point.
  const took = Date.now() - startedAt;
  if (took > POLL_INTERVAL_MS) {
    console.warn(`[monitor] poll pass took ${(took / 1000).toFixed(1)}s across ${addresses.length} addresses — exceeds the ${POLL_INTERVAL_MS / 1000}s interval`);
  }
}

// ── Stranded USDC ─────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_MAX_PER_RUN = 25;

/**
 * Collects USDC left in deposit addresses by the period when the USDC branch had
 * no forwarding step.
 *
 * The per-deposit sweep only fires when an address receives something, so an
 * address that never sees another deposit would hold its balance forever. This
 * catches those. It is also the general safety net for a sweep that failed on
 * arrival — sweepUsdc moves the full balance and no-ops on an empty account, so
 * running over every address repeatedly is harmless.
 *
 * Capped per run because each address costs an RPC round trip or two and there
 * is no deadline here; anything missed is picked up an hour later.
 */
async function sweepStrandedUsdc(supabase) {
  const { data, error } = await supabase
    .from('deposit_addresses').select('user_id').eq('coin', 'usdc').limit(500);
  if (error) {
    console.error('[monitor] stranded-USDC query failed:', error.message);
    return;
  }

  let swept = 0, total = 0;
  for (const row of data || []) {
    if (swept >= SWEEP_MAX_PER_RUN) break;
    try {
      const { privKey } = getAddress(row.user_id, 'usdc');
      const res = await sweepUsdc(privKey);
      if (res) { swept++; total += res.amount; }
    } catch (e) {
      console.error(`[monitor] stranded sweep failed for user ${row.user_id}:`, e.message);
    }
  }
  if (swept) console.log(`[monitor] stranded sweep collected ${total} USDC from ${swept} address(es)`);
}

function init(supabase) {
  supabaseRef = supabase;
  console.log('[monitor] blockchain monitor started');

  const runSweep = () => sweepStrandedUsdc(supabase)
    .catch(e => console.error('[monitor] stranded sweep error:', e.message));
  setTimeout(runSweep, 30_000);          // after boot, once the RPC is warm
  setInterval(runSweep, SWEEP_INTERVAL_MS);

  async function loop() {
    await pollOnce(supabase).catch(e => console.error('[monitor] loop error:', e.message));
    setTimeout(loop, POLL_INTERVAL_MS);
  }

  // Start after 10s to let server fully boot
  setTimeout(loop, 10_000);
}

module.exports = { init, claimDeposit, sweepStrandedUsdc };
