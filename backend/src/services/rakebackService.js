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
  // Split evenly across the three rakeback buckets
  const share = Math.round((perPlayer / 3) * 10000) / 10000;

  const ids = [player1Id, player2Id].filter(Boolean);
  for (const userId of ids) {
    try {
      await Promise.all([
        supabase.rpc('add_rakeback_instant', { p_user_id: userId, p_amount: share }),
        supabase.rpc('add_rakeback_daily',   { p_user_id: userId, p_amount: share }),
        supabase.rpc('add_rakeback_weekly',  { p_user_id: userId, p_amount: share }),
      ]);
    } catch (e) {
      console.error(`[rakeback] userId=${userId} failed:`, e.message);
    }
  }
}

module.exports = { creditRakeback };
