/**
 * swapPoller.js
 *
 * Background service that polls SimpleSwap for pending deposit conversions.
 * When a conversion finishes, credits the player with the exact USDC received.
 *
 * Flow:
 *   1. Plisio webhook fires (SOL arrived) → we forward SOL to SimpleSwap
 *   2. Transaction inserted with status='converting', tx_hash=exchangeId
 *   3. This poller picks it up and polls every 30s
 *   4. When SimpleSwap status='finished', credits player with exact amount_to (USDC)
 *   5. Transaction updated to status='confirmed' with final amount
 */

const { getExchangeStatus } = require('./simpleSwapService');
const { creditCoins, recordDeposit } = require('./walletService');

const POLL_INTERVAL_MS  = 30_000;   // check each exchange every 30s
const MAX_WAIT_MS       = 60 * 60 * 1000;  // give up after 1 hour
const STARTUP_DELAY_MS  = 5_000;    // wait 5s after server start before polling

// Track active polls in memory so we don't double-poll
const activePolls = new Set();

let supabaseRef = null;

// Called once on server start with the supabase client
function init(supabase) {
  supabaseRef = supabase;
  // Resume any conversions that were in progress before a restart
  setTimeout(async () => {
    try {
      const { data: pending } = await supabase
        .from('transactions')
        .select('tx_hash, user_id, created_at')
        .eq('status', 'converting')
        .eq('type', 'deposit');

      if (pending?.length) {
        console.log(`[swapPoller] resuming ${pending.length} pending conversion(s)`);
        pending.forEach(row => {
          watch(row.tx_hash, row.user_id, new Date(row.created_at).getTime());
        });
      }
    } catch (e) {
      console.error('[swapPoller] startup resume error:', e.message);
    }
  }, STARTUP_DELAY_MS);
}

// Start watching an exchange. Called immediately after creating the swap.
function watch(exchangeId, userId, startedAt = Date.now()) {
  if (activePolls.has(exchangeId)) return;
  activePolls.add(exchangeId);
  console.log(`[swapPoller] watching exchange ${exchangeId} for user ${userId}`);
  scheduleNext(exchangeId, userId, startedAt);
}

function scheduleNext(exchangeId, userId, startedAt) {
  setTimeout(() => poll(exchangeId, userId, startedAt), POLL_INTERVAL_MS);
}

async function poll(exchangeId, userId, startedAt) {
  if (!supabaseRef) return;

  try {
    const result = await getExchangeStatus(exchangeId);
    console.log(`[swapPoller] exchange ${exchangeId} status=${result.status} amountTo=${result.amountTo}`);

    if (result.status === 'finished') {
      // Take 0.5% platform fee from exact USDC received, credit the rest to player
      const OUR_FEE    = 0.005;
      const usdcRaw    = result.amountTo;
      const usdcCredit = Math.floor(usdcRaw * (1 - OUR_FEE) * 100) / 100;

      if (usdcCredit > 0) {
        await creditCoins(supabaseRef, userId, usdcCredit);
        await recordDeposit(supabaseRef, userId, usdcCredit, 'crypto');
        await supabaseRef
          .from('transactions')
          .update({ status: 'confirmed', amount_c: usdcCredit })
          .eq('tx_hash', exchangeId)
          .eq('status', 'converting');

        console.log(`[swapPoller] ✓ credited $${usdcCredit} to user ${userId} ($${usdcRaw} received, 0.5% fee taken, exchange ${exchangeId})`);
      }
      activePolls.delete(exchangeId);

    } else if (['failed', 'refunded', 'expired'].includes(result.status)) {
      // Conversion failed — mark in DB, no credit
      await supabaseRef
        .from('transactions')
        .update({ status: result.status })
        .eq('tx_hash', exchangeId);

      console.warn(`[swapPoller] exchange ${exchangeId} ended with status=${result.status} — no credit issued`);
      activePolls.delete(exchangeId);

    } else if (Date.now() - startedAt > MAX_WAIT_MS) {
      // Been waiting over 1 hour — give up polling but keep DB status as 'converting'
      // so a human can investigate
      console.error(`[swapPoller] exchange ${exchangeId} timed out after 1h — manual review needed`);
      await supabaseRef
        .from('transactions')
        .update({ status: 'stuck' })
        .eq('tx_hash', exchangeId);
      activePolls.delete(exchangeId);

    } else {
      // Still in progress — poll again
      scheduleNext(exchangeId, userId, startedAt);
    }

  } catch (e) {
    console.error(`[swapPoller] error polling ${exchangeId}:`, e.message);
    // Don't stop polling on transient errors — try again
    if (Date.now() - startedAt < MAX_WAIT_MS) {
      scheduleNext(exchangeId, userId, startedAt);
    }
  }
}

module.exports = { init, watch };
