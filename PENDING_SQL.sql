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
RETURNS numeric AS $fn_wagered$
  UPDATE profiles
     SET qualifying_wagered_c = COALESCE(qualifying_wagered_c, 0) + amount
   WHERE id = user_id
  RETURNING qualifying_wagered_c;
$fn_wagered$ LANGUAGE sql;

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
RETURNS boolean AS $fn_paybank$
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
$fn_paybank$ LANGUAGE plpgsql;

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
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $fn_collect$
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
$fn_collect$;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY — run after section 4. Every row should say OK.
-- ───────────────────────────────────────────────────────────────────────────
SELECT 'profiles.referred_by' AS item,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='profiles' AND column_name='referred_by')
            THEN 'OK' ELSE 'MISSING' END AS status
UNION ALL SELECT 'profiles.qualifying_wagered_c',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='profiles' AND column_name='qualifying_wagered_c')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'referral_rewards table',
       CASE WHEN to_regclass('public.referral_rewards') IS NOT NULL
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'uniq_referral_reward_referred',
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
              WHERE indexname='uniq_referral_reward_referred')
            THEN 'OK' ELSE 'MISSING — rewards could pay more than once' END
UNION ALL SELECT 'increment_qualifying_wagered()',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='increment_qualifying_wagered')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'pay_referral_from_bank()',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='pay_referral_from_bank')
            THEN 'OK' ELSE 'MISSING — payouts will fail' END
UNION ALL SELECT 'collect_admin_fees() reserves rewards',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc
              WHERE proname='collect_admin_fees'
                AND pg_get_functiondef(oid) LIKE '%referral_rewards%')
            THEN 'OK' ELSE 'OLD VERSION — fee sweep would strand owed rewards' END;


-- ───────────────────────────────────────────────────────────────────────────
-- 5. RECOMMENDED — backfill referred_by for codes applied before it existed
--
-- referred_by is what the referral reward keys on, and it was only added with
-- the reward. Anyone who applied a code before that has applied_affiliate_code
-- set and referred_by null, so their referrer can never be credited no matter
-- how much they play.
--
-- Run the SELECT first to see how many rows it would touch.
-- ───────────────────────────────────────────────────────────────────────────

SELECT count(*) AS would_backfill
FROM profiles p
JOIN profiles owner ON owner.affiliate_code = p.applied_affiliate_code
WHERE p.referred_by IS NULL
  AND p.applied_affiliate_code IS NOT NULL
  AND owner.id <> p.id;

-- Then, to apply it. Only fills nulls, so it cannot overwrite an attribution
-- that already exists, and self-referrals are excluded.
UPDATE profiles p
   SET referred_by = owner.id
  FROM profiles owner
 WHERE p.referred_by IS NULL
   AND p.applied_affiliate_code IS NOT NULL
   AND owner.affiliate_code = p.applied_affiliate_code
   AND owner.id <> p.id;


-- ───────────────────────────────────────────────────────────────────────────
-- 6. REQUIRED — support tickets
--
-- A player raises a ticket, staff replies, the player can write back. Messages
-- are a separate table so a ticket is a thread rather than one field that gets
-- overwritten, and so "who said what, when" survives.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id),
  subject        text NOT NULL,
  -- open           = player is waiting on staff
  -- awaiting_user  = staff replied, ball is with the player
  -- closed         = done
  status         text NOT NULL DEFAULT 'open',
  -- Optional link to the transaction being disputed, so "where is my
  -- withdrawal" arrives already attached to the row instead of being matched
  -- up by hand.
  transaction_id uuid REFERENCES transactions(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES profiles(id),
  is_staff   boolean NOT NULL DEFAULT false,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sorted by activity in the admin inbox, and by thread order in a ticket.
CREATE INDEX IF NOT EXISTS idx_tickets_status_updated ON support_tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user           ON support_tickets (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_messages        ON support_messages (ticket_id, created_at);

ALTER TABLE support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- Players read their own tickets only. Staff go through the service key, which
-- bypasses RLS, so no policy is needed for them.
DROP POLICY IF EXISTS "tickets_own" ON support_tickets;
CREATE POLICY "tickets_own" ON support_tickets
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ticket_messages_own" ON support_messages;
CREATE POLICY "ticket_messages_own" ON support_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM support_tickets t
             WHERE t.id = support_messages.ticket_id AND t.user_id = auth.uid())
  );
