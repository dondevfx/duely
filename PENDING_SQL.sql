-- ═══════════════════════════════════════════════════════════════════════════
--  Pending database migrations — run in the Supabase SQL editor
--
--  Run section 1 now. Section 2 is a real-money safety fix; read the check
--  query first, because it can fail if the table already contains duplicates.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. REQUIRED — friend invites
--
-- The backend reads profiles.invites_enabled when someone sends a game invite
-- (socket/handlers.js) and writes it from the profile settings toggle
-- (routes/auth.js). Without this column those paths error, so the invite
-- feature is broken until it is added.
--
-- Safe to run more than once. No data is touched; existing users default to
-- accepting invites, which is the current behaviour.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS invites_enabled boolean NOT NULL DEFAULT true;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. RECOMMENDED — stop a deposit ever being credited twice
--
-- blockchainMonitor.js deliberately inserts the deposit row BEFORE crediting
-- coins, so that a crash between the two leaves a recorded-but-uncredited row
-- (safe and reconcilable) rather than credited-but-unrecorded (which would
-- re-credit on restart and mint money).
--
-- That protection assumes the insert FAILS when the tx_hash already exists.
-- Right now transactions.tx_hash only has a plain index (idx_tx_hash), not a
-- unique one, so the insert succeeds regardless. Two monitor instances, or one
-- restarting mid-poll, can both insert and both credit the same deposit.
--
-- STEP A — check for existing duplicates first. If this returns any rows, do
-- NOT run step B yet; the index creation will fail. Reconcile those deposits
-- manually first, and note that each duplicate row may represent coins that
-- were already credited twice.

SELECT tx_hash, count(*) AS rows, sum(amount_c) AS total_credited
FROM transactions
WHERE type = 'deposit' AND tx_hash IS NOT NULL
GROUP BY tx_hash
HAVING count(*) > 1
ORDER BY count(*) DESC;

-- STEP B — only when step A returns nothing. A partial unique index, so it
-- constrains deposits only: withdrawals and swap records may legitimately
-- share or omit a tx_hash and are left alone.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_deposit_tx_hash
  ON transactions (tx_hash)
  WHERE type = 'deposit' AND tx_hash IS NOT NULL;
