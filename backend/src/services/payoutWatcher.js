/**
 * Watches fiat payouts until they land, or until a person needs to look.
 *
 * Same machine as the ChangeNow withdrawal watcher, different status map. The
 * lesson it was built from applies identically: handing money to a provider is
 * not delivery, and a transfer nobody watches is a transfer that fails quietly.
 *
 * ── It does not refund ──
 *
 * Deliberately, and for the reason you already decided on the crypto side: the
 * provider's terminal states do not all mean the same thing to us. A returned
 * ACH means the money is coming back and the player is owed. An unclaimed
 * PayPal payout means it is still sitting there and may yet be collected.
 * Crediting on both would sometimes pay a player who is about to be paid
 * anyway, and a wrong refund is real money gone with nothing to reverse it.
 *
 * So a terminal failure lands on `withdraw_failed`, which is already second in
 * the admin queue, already alerts on the first occurrence, and already has
 * Refund / Money arrived / Decline behind it. No admin work needed.
 *
 * ── Status lifecycle ──
 *
 *   sending          in flight. Distinct from 'converting' because a swap is
 *                    stale after an hour and an ACH is not.
 *   confirmed        delivered.
 *   withdraw_failed  terminal, needs a decision. Coins stay deducted.
 *   payout_uncertain we could not find out. Also needs a decision, and is
 *                    already on the critical alert list.
 */

const { providerFor, overdueMsFor, pollDelay } = require('./fiatPayouts');

const STARTUP_DELAY_MS = 5_000;

// In-memory, so a restart drops it — which is why init() resumes from the table.
const active = new Set();
let supabaseRef = null;

function init(supabase) {
  supabaseRef = supabase;
  setTimeout(async () => {
    try {
      // Resume anything still in flight. Railway restarts on every deploy, and
      // an unwatched payout that fails leaves coins deducted and nothing
      // delivered — the exact bug this pattern exists to prevent.
      const { data: pending } = await supabase
        .from('transactions')
        .select('tx_hash, user_id, created_at, crypto_symbol')
        .eq('type', 'withdrawal')
        .eq('status', 'sending');

      if (pending?.length) {
        console.log(`[payoutWatcher] resuming ${pending.length} fiat payout(s)`);
        for (const row of pending) {
          watch(row.tx_hash, row.user_id, methodOf(row), new Date(row.created_at).getTime());
        }
      }
    } catch (e) {
      console.error('[payoutWatcher] startup resume error:', e.message);
    }
  }, STARTUP_DELAY_MS);
}

// The method rides in crypto_symbol on fiat rows — 'BANK', 'PAYPAL', 'VENMO'.
// Reusing the column keeps the admin queue and transaction history rendering
// these without a schema change or a special case.
const methodOf = (row) => String(row?.crypto_symbol || '').toLowerCase();

function watch(payoutId, userId, method, startedAt = Date.now()) {
  if (!payoutId || active.has(payoutId)) return;
  active.add(payoutId);
  console.log(`[payoutWatcher] watching ${method} payout ${payoutId} for user ${userId}`);
  schedule(payoutId, userId, method, startedAt);
}

function schedule(payoutId, userId, method, startedAt) {
  setTimeout(() => poll(payoutId, userId, method, startedAt),
             pollDelay(Date.now() - startedAt));
}

// Claim the row before acting on it, so two polls — or a poll racing the
// restart resume — cannot both settle the same payout.
async function claim(payoutId, nextStatus, notes) {
  const { data } = await supabaseRef
    .from('transactions')
    .update({ status: nextStatus, ...(notes ? { notes } : {}) })
    .eq('tx_hash', payoutId)
    .eq('type', 'withdrawal')
    .eq('status', 'sending')
    .select('id, amount_c, user_id');
  return data?.[0] || null;
}

async function poll(payoutId, userId, method, startedAt) {
  if (!supabaseRef) return;
  const age = Date.now() - startedAt;

  let state;
  try {
    const provider = providerFor(method);
    const raw = await provider.status(payoutId);
    state = provider.map(raw);
    console.log(`[payoutWatcher] ${method} payout ${payoutId} state=${state} (${JSON.stringify(raw)})`);
  } catch (e) {
    // A provider we cannot reach is not a failed payout. Keep trying until the
    // window closes, then hand it to a person rather than guessing.
    console.error(`[payoutWatcher] could not read ${method} payout ${payoutId}:`, e.message);
    if (age < overdueMsFor(method)) return schedule(payoutId, userId, method, startedAt);

    await claim(payoutId, 'payout_uncertain',
      `Could not determine the outcome of this ${method.toUpperCase()} payout: ${String(e.message).slice(0, 200)}`);
    console.error(`CRITICAL: ${method} payout ${payoutId} outcome unknown for user ${userId} — coins deducted, NOT refunded`);
    active.delete(payoutId);
    return;
  }

  if (state === 'settled') {
    await claim(payoutId, 'confirmed');
    console.log(`[payoutWatcher] ✓ ${method} payout ${payoutId} delivered`);
    active.delete(payoutId);
    // NOTE: for ACH this is final-ish. A return can still arrive up to 60 days
    // later and must reopen the row — that comes in by webhook, not from here.
    return;
  }

  if (state === 'returned') {
    const row = await claim(payoutId, 'withdraw_failed',
      `${method.toUpperCase()} payout was returned — coins NOT auto-refunded, needs a decision. payout=${payoutId}`);
    if (row) {
      console.error(
        `[payoutWatcher] ${method} payout ${payoutId} returned — ${row.amount_c} coins ` +
        `deducted from ${row.user_id} and NOT refunded. Awaiting a decision in the admin queue.`);
    }
    active.delete(payoutId);
    return;
  }

  if (state === 'unclaimed') {
    // Neither delivered nor failed. The recipient has no account yet and has
    // roughly 30 days to open one; the money is still with the provider.
    //
    // Flagging it as failed now would be wrong — it may well be collected —
    // and so would confirming it. So it keeps being watched until either it
    // resolves or the window closes, and the note says what is happening in
    // case a player asks in the meantime.
    if (age < overdueMsFor(method)) {
      await supabaseRef.from('transactions')
        .update({ notes: `${method.toUpperCase()} payout is unclaimed — the recipient has not collected it yet.` })
        .eq('tx_hash', payoutId).eq('status', 'sending')
        .then().catch(() => {});
      return schedule(payoutId, userId, method, startedAt);
    }
    await claim(payoutId, 'withdraw_failed',
      `${method.toUpperCase()} payout went unclaimed and has expired — coins NOT auto-refunded, needs a decision. payout=${payoutId}`);
    console.error(`[payoutWatcher] ${method} payout ${payoutId} expired unclaimed for user ${userId}`);
    active.delete(payoutId);
    return;
  }

  // pending, or a state the map did not recognise.
  if (age < overdueMsFor(method)) return schedule(payoutId, userId, method, startedAt);

  // Past the window with no terminal answer. Not called a failure — a payout
  // still moving that gets refunded pays the player twice.
  await claim(payoutId, 'payout_uncertain',
    `${method.toUpperCase()} payout has not resolved within the expected window. payout=${payoutId}`);
  console.error(`CRITICAL: ${method} payout ${payoutId} unresolved for user ${userId} — coins deducted, NOT refunded`);
  active.delete(payoutId);
}

module.exports = { init, watch, methodOf };
