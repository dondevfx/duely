/**
 * Rakeback Service
 *
 * Credits 0.125% of prizePool to each player as instant, daily, and weekly rakeback.
 * prizePool = entryFee * 2 (gross, before platform fee).
 *
 * Required SQL to run in Supabase (profiles table):
 *
 *   ALTER TABLE profiles
 *     ADD COLUMN IF NOT EXISTS rakeback_instant  numeric      DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS rakeback_daily    numeric      DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS rakeback_daily_at timestamptz  DEFAULT NULL,
 *     ADD COLUMN IF NOT EXISTS rakeback_weekly   numeric      DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS rakeback_weekly_at timestamptz DEFAULT NULL;
 */

async function creditRakeback(supabase, player1Id, player2Id, prizePool, currency = 'coins') {
  // Rakeback only applies to coin games — diamonds are engagement currency only
  if (currency !== 'coins') return;
  // 0.25% per player of prize pool (0.5% total across both players)
  const perPlayer = Math.round(prizePool * 0.0025 * 10000) / 10000; // 4 decimal places
  if (perPlayer <= 0) return;

  const ids = [player1Id, player2Id].filter(Boolean);
  for (const userId of ids) {
    try {
      // Atomic increment via Postgres RPC — no read-then-write race condition
      await supabase.rpc('add_rakeback', { p_user_id: userId, p_amount: perPlayer });
    } catch (e) {
      // Silently fail — don't break game results
    }
  }
}

module.exports = { creditRakeback };
