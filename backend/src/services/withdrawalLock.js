/**
 * One withdrawal in flight per account — enforced by the DATABASE.
 *
 * The routes also keep an in-memory Set, which only works while the backend is
 * one process. On two or more instances each has its own Set, so two
 * withdrawals for the same account could run at once on different servers.
 * The balance itself could not go below zero (deduct_coins is atomic), but the
 * playthrough check is read-then-act: both requests could pass "amount <=
 * withdrawable" before either deducted, and together take out coins that had
 * not been played through.
 *
 * withdrawal_locks has the user id as its PRIMARY KEY, so an INSERT is the
 * lock: exactly one server's insert succeeds, every other gets 23505. It is
 * released in the route's finally. A crash between the two leaves a row
 * behind, so a lock older than STALE_MS is treated as abandoned and taken over.
 *
 * Before PENDING_SQL section 25 is run the table does not exist; the lock then
 * reports db:false and the in-memory lock is what remains, logged loudly.
 */
const STALE_MS = 15 * 60 * 1000;

const isMissingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205'
  || /withdrawal_locks|does not exist|schema cache/i.test(e.message || ''));

async function acquireWithdrawalLock(supabase, userId, { now = Date.now(), log = console, retried = false } = {}) {
  const { error } = await supabase.from('withdrawal_locks').insert({ user_id: userId });
  if (!error) return { ok: true, db: true };

  if (error.code === '23505') {
    if (retried) return { ok: false, reason: 'in_progress' };
    // Taken — unless it was left by a crash. Deleting only a row older than the
    // cutoff is itself atomic, so two servers cannot both take over one lock.
    const cutoff = new Date(now - STALE_MS).toISOString();
    const { data: cleared } = await supabase.from('withdrawal_locks')
      .delete().eq('user_id', userId).lt('created_at', cutoff).select('user_id');
    if (cleared?.length) {
      log.error?.(`[withdraw-lock] cleared an abandoned lock for ${userId} (older than ${STALE_MS / 60000} min)`);
      return acquireWithdrawalLock(supabase, userId, { now, log, retried: true });
    }
    return { ok: false, reason: 'in_progress' };
  }

  if (isMissingTable(error)) {
    log.warn?.('[withdraw-lock] withdrawal_locks is missing — run PENDING_SQL section 25. ' +
      'Only the in-memory lock protects concurrent withdrawals, which is NOT safe on more than one server.');
    return { ok: true, db: false };
  }

  // Any other failure: refuse. A withdrawal that cannot confirm it holds the
  // lock must not proceed.
  log.error?.(`[withdraw-lock] could not take the lock for ${userId}: ${error.message}`);
  return { ok: false, reason: 'lock_error' };
}

// Never throws: it runs in the routes' finally, and an exception there would
// replace the withdrawal's real outcome with a 500. A lock that fails to
// release clears itself after STALE_MS.
async function releaseWithdrawalLock(supabase, userId, lock) {
  if (!lock?.db) return;
  try {
    const { error } = await supabase.from('withdrawal_locks').delete().eq('user_id', userId);
    if (error) throw error;
  } catch (e) {
    console.error(`[withdraw-lock] release failed for ${userId}: ${e.message} (clears itself after ${STALE_MS / 60000} min)`);
  }
}

module.exports = { acquireWithdrawalLock, releaseWithdrawalLock, STALE_MS };
