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
WHERE type IN ('deposit', 'deposit_raw') AND tx_hash IS NOT NULL
GROUP BY tx_hash
HAVING count(*) > 1
ORDER BY count(*) DESC;

-- STEP B — only when step A returns nothing. A partial unique index, so it
-- constrains deposits only: withdrawals and swap records may legitimately
-- share or omit a tx_hash and are left alone.
--
-- 'deposit_raw' is covered as well as 'deposit'. Non-SOL coins claim the
-- on-chain tx as a deposit_raw row before forwarding funds to ChangeNow, so
-- without it in the predicate that claim is unconstrained and two passes could
-- both forward the same deposit.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_deposit_tx_hash
  ON transactions (tx_hash)
  WHERE type IN ('deposit', 'deposit_raw') AND tx_hash IS NOT NULL;

-- If you already created uniq_deposit_tx_hash with the older, deposit-only
-- predicate, replace it:
--
--   DROP INDEX IF EXISTS uniq_deposit_tx_hash;
--   -- then run the CREATE above


-- ───────────────────────────────────────────────────────────────────────────
-- 3. DO NOT RUN — a unique index on transactions.extra_id
--
-- An earlier note in chat suggested one, to make the Cryptomus webhook's
-- claim-then-act pattern atomic. Do not add it. Two reasons:
--
--   a) The Cryptomus deposit path is dead code — nothing calls
--      cryptomusService.getDepositAddress, so no wallet exists that could
--      produce the order_id the webhook parses. It cannot fire.
--   b) blockchainMonitor stores the literal strings 'credit' / 'no_credit' in
--      extra_id on every ChangeNow deposit row (swapPoller reads them back), and
--      wallet.js stores withdrawal memos there. A unique index would reject the
--      second such deposit outright — breaking live deposits to protect a path
--      that cannot run.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- 4. REQUIRED — referral rewards
--
-- 2 coins to the referrer once a referred player deposits $10 and wagers $100
-- in 5%-rake matches. Self-funding on a conservative half-attribution basis:
-- $100 wagered earns ~$4 against a $2 reward, and farming costs $10 of rake.
-- ───────────────────────────────────────────────────────────────────────────

-- Permanent referral link. profiles.applied_affiliate_code EXPIRES, so it
-- cannot anchor a lifetime referral — this is set once at signup and kept.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES profiles(id);
CREATE INDEX IF NOT EXISTS idx_profiles_referred_by ON profiles(referred_by);

-- Running total of stakes that count toward the bar. Coin Flip never reaches
-- here: it settles through settleCoinFlip, and only settleMatch calls trackWager.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS qualifying_wagered_c numeric NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS referral_rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES profiles(id),
  referred_id uuid NOT NULL REFERENCES profiles(id),
  amount_c    numeric NOT NULL,
  status      text NOT NULL DEFAULT 'pending',  -- pending | paid | clawed_back
  mature_at   timestamptz NOT NULL,
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- THE load-bearing constraint. One reward per referred account, ever — without
-- it, every match a qualified player finishes would insert another reward row
-- and pay the referrer again.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_referral_reward_referred
  ON referral_rewards (referred_id);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_due
  ON referral_rewards (status, mature_at);

-- Atomic increment, so two matches settling at once cannot lose a stake to a
-- read-modify-write race. Returns the new total for the caller to test.
CREATE OR REPLACE FUNCTION increment_qualifying_wagered(user_id uuid, amount numeric)
RETURNS numeric AS $$
  UPDATE profiles
     SET qualifying_wagered_c = COALESCE(qualifying_wagered_c, 0) + amount
   WHERE id = user_id
  RETURNING qualifying_wagered_c;
$$ LANGUAGE sql;

ALTER TABLE referral_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "referral_rewards_select" ON referral_rewards;
CREATE POLICY "referral_rewards_select" ON referral_rewards
  FOR SELECT USING (auth.uid() = referrer_id);

-- Referral rewards are paid OUT OF the platform's fee balance, not minted.
--
-- creditCoins() creates new coins. Using it for the bonus would put coins into
-- circulation with no deposit backing them, so withdrawable balances would
-- exceed the USDC actually held — the bank quietly drains with every payout.
-- This moves the coins from the fee balance instead, leaving total supply
-- unchanged and every coin still traceable to a real deposit or real rake.
--
-- Returns false rather than raising when the bank is short, so a payout can be
-- deferred instead of failing loudly or, worse, overdrawing. profiles.fee_balance
-- also carries CHECK (fee_balance >= 0) as a second line of defence.
CREATE OR REPLACE FUNCTION pay_referral_from_bank(admin_id uuid, referrer_id uuid, amount numeric)
RETURNS boolean AS $$
DECLARE moved int;
BEGIN
  UPDATE profiles
     SET fee_balance = fee_balance - amount
   WHERE id = admin_id AND COALESCE(fee_balance, 0) >= amount;
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved = 0 THEN RETURN false; END IF;

  UPDATE profiles
     SET c_coins = COALESCE(c_coins, 0) + amount
   WHERE id = referrer_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Reserve outstanding referral rewards when collecting platform fees.
--
-- collect_admin_fees swept fee_balance to zero. Referral rewards are paid OUT
-- of that balance, so a sweep could leave earned rewards uncollectable — the
-- referrer would see "nothing to collect" while genuinely being owed coins.
--
-- Rewards that have qualified but not been collected are a liability against
-- the balance, so they are held back. Income still outpaces payouts roughly
-- 2:1 ($4 of rake per $2 reward), so this reduces what is collectable now
-- rather than blocking collection.
CREATE OR REPLACE FUNCTION collect_admin_fees(admin_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fee  numeric;
  v_owed numeric;
  v_take numeric;
BEGIN
  SELECT fee_balance INTO v_fee FROM profiles WHERE id = admin_id FOR UPDATE;
  IF v_fee IS NULL OR v_fee <= 0 THEN RETURN 0; END IF;

  -- Every pending reward, including those still inside the 7-day hold: they
  -- are already earned, so the money must stay put.
  SELECT COALESCE(SUM(amount_c), 0) INTO v_owed
    FROM referral_rewards WHERE status = 'pending';

  v_take := v_fee - v_owed;
  IF v_take <= 0 THEN RETURN 0; END IF;

  UPDATE profiles
     SET c_coins     = c_coins + v_take,
         fee_balance = fee_balance - v_take
   WHERE id = admin_id;
  RETURN v_take;
END;
$$;
