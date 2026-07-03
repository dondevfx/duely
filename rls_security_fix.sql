-- ============================================================================
-- CRITICAL SECURITY FIX — run this in the Supabase SQL editor NOW.
-- ============================================================================
-- Problem: the "profiles_update" RLS policy let any logged-in user UPDATE their
-- own profile row. Postgres RLS is ROW-level, not COLUMN-level, and Supabase's
-- default grants give the `authenticated` role UPDATE on every column — so a
-- user could open the browser console and run:
--
--     supabase.from('profiles').update({ c_coins: 1000000 }).eq('id', <their id>)
--
-- ...setting their own balance to anything, then withdraw real crypto. This
-- bypasses ALL of the backend's wallet logic.
--
-- The frontend NEVER writes to profiles directly — every legitimate write goes
-- through the backend, which uses the service_role key (bypasses RLS + grants).
-- So the client needs zero write access. This migration removes it.
-- ============================================================================

-- ── Part 1: CRITICAL — remove all client write access to profiles ──────────
DROP POLICY IF EXISTS "profiles_update" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;

-- Belt-and-suspenders: revoke column write grants from the client roles, so
-- even if a permissive policy is ever re-added by mistake, writes still fail.
REVOKE INSERT, UPDATE, DELETE ON profiles FROM anon, authenticated;

-- (profiles_select stays — public read is used for leaderboard/profile data.
--  The backend serves that data via service_role; see Part 2 to also hide
--  financial columns from direct anon reads.)

-- ── Part 2: RECOMMENDED — stop anon/authenticated reading financial columns ─
-- profiles_select USING(true) currently lets anyone with the public anon key
-- read EVERY column of EVERY user, including balances and earnings. The
-- frontend doesn't read profiles directly, so revoking these is safe. Public,
-- non-sensitive columns (username, elo, stats, color) remain readable.
REVOKE SELECT (
  c_coins, diamonds, fee_balance,
  crypto_deposited, crypto_withdrawn, fiat_deposited, fiat_withdrawn,
  affiliate_earnings_c, affiliate_earnings_diamonds,
  applied_affiliate_code, applied_code_expires_at,
  wallet_address,
  rakeback_instant, rakeback_instant_at,
  rakeback_daily, rakeback_daily_at,
  rakeback_weekly, rakeback_weekly_at
) ON profiles FROM anon, authenticated;

-- ── Verify (optional) ───────────────────────────────────────────────────────
-- After running, this should show NO update/insert policy for profiles:
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'profiles';
