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
const gameEvents = require('./gameEvents');

// ── How long to keep watching ────────────────────────────────────────────────
//
// This was one hour, which is shorter than a BTC deposit takes.
//
// A BTC swap waits on TWO Bitcoin confirmations in sequence: ours forwarding to
// ChangeNow, then ChangeNow's own requirement before they will swap. Each
// averages ~10 minutes with a long tail, so an hour is routinely not enough.
//
// Giving up did not just stop the clock — it stopped the polling. So when
// ChangeNow finished twenty minutes later and sent the USDC, our wallet
// received it and NOBODY CREDITED THE PLAYER. The money arrived and the
// deposit stayed unpaid until someone noticed by hand.
//
// 24 hours instead. Nothing is lost by waiting: a swap that genuinely fails
// reports 'failed', 'refunded' or 'expired' and ends the watch immediately, so
// the long ceiling only ever applies to one that is still legitimately running.
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

// Polling backs off with age rather than hammering every 30s for a day.
// Fast while an answer is plausibly imminent, slow once it is clearly a
// multi-confirmation wait.
const STARTUP_DELAY_MS = 5_000;    // wait 5s after server start before polling
function pollDelay(ageMs) {
  if (ageMs < 15 * 60_000)  return 30_000;    // first 15 min — SOL/fast chains
  if (ageMs < 60 * 60_000)  return 120_000;   // up to an hour — first confirmation
  return 300_000;                             // beyond that — BTC's second wait
}

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
        .select('tx_hash, user_id, created_at, extra_id')
        .in('status', ['converting', 'stuck'])
        .eq('type', 'deposit');

      if (pending?.length) {
        console.log(`[swapPoller] resuming ${pending.length} pending conversion(s)`);
        pending.forEach(row => {
          // extra_id='no_credit' means deposit was below user minimum — platform keeps USDC
          const creditUser = row.extra_id !== 'no_credit';
          watch(row.tx_hash, row.user_id, new Date(row.created_at).getTime(), creditUser);
        });
      }
    } catch (e) {
      console.error('[swapPoller] startup resume error:', e.message);
    }
  }, STARTUP_DELAY_MS);
}

// Start watching an exchange. Called immediately after creating the swap.
// creditUser: if false, platform keeps the USDC (deposit was below user-visible minimum)
function watch(exchangeId, userId, startedAt = Date.now(), creditUser = true) {
  if (activePolls.has(exchangeId)) return;
  activePolls.add(exchangeId);
  console.log(`[swapPoller] watching exchange ${exchangeId} for user ${userId} creditUser=${creditUser}`);
  scheduleNext(exchangeId, userId, startedAt, creditUser);
}

function scheduleNext(exchangeId, userId, startedAt, creditUser) {
  setTimeout(() => poll(exchangeId, userId, startedAt, creditUser), pollDelay(Date.now() - startedAt));
}

async function poll(exchangeId, userId, startedAt, creditUser) {
  if (!supabaseRef) return;

  try {
    const result = await getExchangeStatus(exchangeId);
    console.log(`[swapPoller] exchange ${exchangeId} status=${result.status} amountTo=${result.amountTo} creditUser=${creditUser}`);

    if (result.status === 'finished') {
      const OUR_FEE        = 0.001; // 0.1% platform fee
      const MIN_CREDIT_USD = 3.00;  // don't credit deposits that net under $3 in USDC
      const usdcRaw        = parseFloat(result.amountTo); // exact USDC that arrived at our address
      // Credit the exact received amount minus the 0.1% fee, but only if it clears
      // the $3 floor — no "platform keeps" band, players get their money above it.
      const usdcCredit = (creditUser && usdcRaw >= MIN_CREDIT_USD)
        ? Math.floor(usdcRaw * (1 - OUR_FEE) * 100) / 100
        : 0;

      if (creditUser && usdcCredit > 0) {
        // Atomically CLAIM the deposit first by flipping converting→confirmed.
        // Only the poll that actually flips the row (1 affected) proceeds to
        // credit — so a restart-resume or double-poll of an already-processed
        // exchange can never credit twice (which would mint money).
        const { data: claimed } = await supabaseRef
          .from('transactions')
          .update({ status: 'confirmed', amount_c: usdcCredit })
          .eq('tx_hash', exchangeId)
          // 'stuck' as well as 'converting': the old one-hour timeout marked
          // rows stuck and stopped polling, so any that ChangeNow finished
          // afterwards are sitting unpaid. Accepting both means those credit
          // automatically on resume instead of needing a manual payout.
          .in('status', ['converting', 'stuck'])
          .select('id');

        if (claimed && claimed.length > 0) {
          try {
            await creditCoins(supabaseRef, userId, usdcCredit);
          } catch (creditErr) {
            // Credit failed — roll the claim back to 'converting' so a later
            // poll retries. No money credited, no money lost.
            await supabaseRef.from('transactions')
              .update({ status: 'converting' })
              .eq('tx_hash', exchangeId).eq('status', 'confirmed')
              .then().catch(() => {});
            throw creditErr; // outer catch reschedules the poll
          }
          // Credit succeeded — the rest is best-effort bookkeeping.
          await recordDeposit(supabaseRef, userId, usdcCredit, 'crypto').catch(() => {});
          console.log(`[swapPoller] ✓ credited $${usdcCredit} to user ${userId} (received $${usdcRaw} USDC, 0.5% fee, exchange ${exchangeId})`);
          gameEvents.emit('deposit_credited', { userId, amount: usdcCredit, currency: 'coins' });
        } else {
          console.log(`[swapPoller] exchange ${exchangeId} already credited — skipping duplicate`);
        }
      } else {
        // $7–$9.99 buffer band — platform keeps USDC, no user credit
        await supabaseRef
          .from('transactions')
          .update({ status: 'below_min', amount_c: 0 })
          .eq('tx_hash', exchangeId)
          .eq('status', 'converting');
        console.log(`[swapPoller] exchange ${exchangeId} finished — $${usdcRaw} USDC received, no user credit (buffer band or zero)`);
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
      // A full day with no terminal status from ChangeNow. Genuinely wrong.
      //
      // Visibility does not depend on this: the admin queue already surfaces
      // any 'converting' row older than an hour, so a slow swap is on screen
      // long before it reaches this point. That is what makes it safe to keep
      // polling rather than giving up at the first sign of slowness.
      console.error(`[swapPoller] exchange ${exchangeId} still unresolved after 24h — manual review needed`);
      await supabaseRef
        .from('transactions')
        .update({ status: 'stuck' })
        .eq('tx_hash', exchangeId);
      activePolls.delete(exchangeId);

    } else {
      // Still in progress — poll again
      scheduleNext(exchangeId, userId, startedAt, creditUser);
    }

  } catch (e) {
    console.error(`[swapPoller] error polling ${exchangeId}:`, e.message);
    // Don't stop polling on transient errors — try again
    if (Date.now() - startedAt < MAX_WAIT_MS) {
      scheduleNext(exchangeId, userId, startedAt, creditUser);
    }
  }
}

module.exports = { init, watch };
