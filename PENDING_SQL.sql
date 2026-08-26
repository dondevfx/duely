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

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Coin P&L: record the stake alongside a payout
-- ─────────────────────────────────────────────────────────────────────────────
--
-- amount_c on a match_win is the GROSS payout — it returns the player's own
-- stake as well as their winnings. The entry fee itself writes no transaction
-- row at all (it is taken with deduct_coins), so nothing in the ledger said what
-- a win had cost. Summing the rows therefore counted the stake as profit and
-- every account read as up: a break-even player banks +1.9x per win against
-- -1x per loss.
--
-- stake_c carries it, so net profit on a win is amount_c - stake_c.
--
-- Safe to run more than once. The backend works without this — it infers the
-- stake from the payout instead — so nothing breaks if it is delayed; the P&L is
-- simply approximate until it runs.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS stake_c numeric;

-- Backfill historical wins from the matches table, which does record the entry
-- fee. Matched on player and time because transactions carry no match id.
-- Note the column names differ across the two tables: matches.played_at against
-- transactions.created_at.
-- Only fills rows that are still empty, so re-running cannot corrupt live data.
UPDATE transactions t
SET    stake_c = m.entry_fee_c
FROM   matches m
WHERE  t.stake_c IS NULL
  AND  t.type = 'match_win'
  AND  t.amount_c > 0
  AND  m.entry_fee_c > 0
  AND  m.winner_id = t.user_id
  AND  m.played_at BETWEEN t.created_at - interval '30 seconds'
                       AND t.created_at + interval '30 seconds';

-- A draw refunds exactly the stake, so its net effect is zero by definition.
UPDATE transactions
SET    stake_c = amount_c
WHERE  stake_c IS NULL AND type = 'match_draw' AND amount_c > 0;

-- Anything still empty is a bot match or a row with no matching record; the
-- backend infers those from the payout. Check how many are left:
--   SELECT count(*) FROM transactions WHERE type = 'match_win' AND stake_c IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. REQUIRED — pin an applied affiliate code to its OWNER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- profiles.applied_affiliate_code stores the code STRING, and the payout
-- resolved that string to an owner at settlement time. Codes are re-nameable,
-- so the owner it resolved to was whoever held the string at that moment —
-- not whoever the player actually signed up under.
--
-- That is a theft: Alice renames her code, Bob claims the freed string, and
-- every player who ever applied Alice's code starts paying Bob.
--
-- Pinning the owner id at apply time fixes it at the root. The string stays for
-- display; the money follows the id.
--
-- Safe to run more than once. The backend works without this — it falls back to
-- resolving by string — so nothing breaks if it is delayed.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS applied_code_owner_id uuid REFERENCES profiles(id);

-- Backfill from the codes as they stand TODAY. This is the one moment the
-- string mapping is authoritative: whoever holds a code now is the owner the
-- current payouts are already crediting, so this changes nobody's earnings, it
-- just freezes the mapping before it can drift again.
UPDATE profiles p
SET    applied_code_owner_id = owner.id
FROM   profiles owner
WHERE  p.applied_code_owner_id IS NULL
  AND  p.applied_affiliate_code IS NOT NULL
  AND  owner.affiliate_code = p.applied_affiliate_code
  AND  owner.id <> p.id;

-- Anyone whose applied code no longer resolves to a real owner has already been
-- earning nobody anything, so they are left null and the fallback ignores them.
--
-- Speeds up the per-settlement lookup:
CREATE INDEX IF NOT EXISTS idx_profiles_applied_code_owner ON profiles(applied_code_owner_id);

-- Check the backfill:
--   SELECT count(*) FROM profiles
--   WHERE applied_affiliate_code IS NOT NULL AND applied_code_owner_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. URGENT — allow 'deposit_raw', or BTC/ETH/LTC/DOGE/BNB/TRX deposits fail
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Symptom in the logs, repeating every 45 seconds forever:
--
--   [monitor] deposit detected ... coin=btc amount=0.00016388 tx=c004a08a...
--   [monitor] claim failed for c004a08a... — not crediting:
--     new row for relation "transactions" violates check constraint
--     "transactions_type_check"
--
-- Every coin except SOL and USDC is forwarded to ChangeNow to be swapped, and
-- the on-chain transaction is claimed first as a 'deposit_raw' row so two
-- polls cannot both forward the same coins. transactions_type_check does not
-- list 'deposit_raw', so that insert is rejected and the deposit never moves.
--
-- NOTHING WAS LOST. The claim is taken BEFORE the funds are forwarded, so a
-- failed claim means nothing was forwarded and nothing was credited — the coins
-- are still sitting in the player's deposit address. The monitor retries every
-- poll, so the moment this runs, every stuck deposit is picked up and credited
-- on the next pass. No manual recovery needed.
--
-- The list below is every type the backend writes today. Adding them all at
-- once means the next new type is the only thing that can break this again.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit',          -- credited deposit
  'deposit_raw',      -- on-chain receipt, claimed before forwarding to ChangeNow
  'withdrawal',
  'match_win',
  'match_loss',
  'match_draw',
  'match_refund',
  'tip_sent',
  'tip_received',
  'daily_bonus',
  'diamond_bonus',
  'rewards_spin',
  'referral_bonus',
  'fee_collection'
));

-- Confirm it took, and see what is waiting to be picked up:
--   SELECT type, status, count(*) FROM transactions GROUP BY type, status ORDER BY 1,2;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. URGENT — drop the unique indexes on extra_id
-- ─────────────────────────────────────────────────────────────────────────────
--
-- These two exist and must not:
--
--   uniq_tx_extra_id            UNIQUE (extra_id) WHERE extra_id IS NOT NULL
--   uniq_transactions_extra_id  UNIQUE (extra_id) WHERE extra_id IS NOT NULL
--                                                   AND type = 'deposit'
--
-- extra_id is NOT an identifier. blockchainMonitor writes the literal string
-- 'credit' or 'no_credit' into it on EVERY ChangeNow deposit row, and
-- swapPoller reads it back to decide whether the player gets credited. wallet.js
-- also stores withdrawal memos there, and the withdrawal failure path stores the
-- destination address.
--
-- So a unique index allows exactly ONE deposit ever to carry extra_id='credit'.
-- The first one succeeded; every deposit since has been rejected by the index,
-- and the insert had no error check, so it failed in total silence.
--
-- The visible effect: BTC (and ETH/LTC/DOGE/BNB/TRX) was forwarded to ChangeNow,
-- the swap completed, the USDC arrived in the bank — and no row existed to tell
-- swapPoller to credit anybody. Money in, player unpaid, no trace.
--
-- Section 3 of this file has said not to create these since it was written.
-- Dropping them loses nothing: uniq_deposit_tx_hash already provides the real
-- protection, and it is on tx_hash, which IS an identifier.

DROP INDEX IF EXISTS uniq_tx_extra_id;
DROP INDEX IF EXISTS uniq_transactions_extra_id;

-- Confirm only the tx_hash uniqueness remains:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'transactions' AND indexdef ILIKE '%UNIQUE%';

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. ONE-OFF — pay the BTC deposit that section 10 caused to be lost
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Exchange ccc4c25b8fde82. The player's BTC was forwarded, ChangeNow completed
-- the swap, and 8.49 USDC arrived in the bank — but the unique index on
-- extra_id rejected the row that would have told swapPoller to credit them, so
-- nobody was paid.
--
-- 8.49 USDC minus the standard 0.1% platform fee = 8.48 coins, which is exactly
-- what swapPoller would have credited: floor(8.49 * 0.999 * 100) / 100.
--
-- RUN SECTION 10 FIRST. This inserts a row, and the index would reject it too.
--
-- Guarded so it cannot pay twice: the INSERT is conditional on no row already
-- existing for this exchange, and the credit only runs if the insert landed.

DO $recover$
DECLARE
  v_user   uuid    := '423d2b0c-1dae-4947-8340-b07575954383';
  v_amount numeric := 8.48;
  v_rows   int;
BEGIN
  INSERT INTO transactions (user_id, type, amount_c, crypto_amount, crypto_symbol, tx_hash, status, notes)
  SELECT v_user, 'deposit', v_amount, 8.49, 'USDC', 'ccc4c25b8fde82', 'confirmed',
         'manual recovery: swap finished but the converting row was rejected by uniq_tx_extra_id'
  WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE tx_hash = 'ccc4c25b8fde82');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE NOTICE 'Already recorded — nothing credited.';
    RETURN;
  END IF;

  PERFORM credit_coins(user_id => v_user, amount => v_amount);
  PERFORM increment_crypto_deposited(user_id => v_user, amount => v_amount);
  RAISE NOTICE 'Credited % coins to %', v_amount, v_user;
END
$recover$;

-- Check it landed:
--   SELECT username, c_coins FROM profiles WHERE id = '423d2b0c-1dae-4947-8340-b07575954383';


-- ============================================================================
-- 12. Record forfeits instead of guessing at them
-- ============================================================================
-- The profile's match list showed "Opponent disconnected" under ordinary
-- matches, including matches against bots — which cannot disconnect.
--
-- Nothing on the row said whether a match ended in a forfeit, so the frontend
-- inferred it:
--
--   early_click === false && reaction_time_ms === null && prize_pool > 0
--
-- Those two columns belong to the reaction game. Every OTHER game type leaves
-- them false and null, so every staked match on every other game matched the
-- pattern and got the label.
--
-- This adds the fact as a column. Existing rows default to false: a forfeit
-- that already happened cannot be recovered from the data, and showing nothing
-- is right where showing "disconnected" was wrong.
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS ended_by_forfeit boolean NOT NULL DEFAULT false;

-- Check:
--   SELECT ended_by_forfeit, count(*) FROM matches GROUP BY 1;


-- ============================================================================
-- 13. KYC — identity verification
-- ============================================================================
-- kycApproved() in routes/wallet.js has always read profiles.kyc_status, and
-- the column has never existed — so it returned false for everyone and failed
-- closed. That was correct behaviour, and it is why no fiat withdrawal has
-- ever been possible. This creates what it was reading.
--
-- Meanwhile the "Verification" panel in Settings wrote the player's name,
-- address and date of birth to localStorage and nothing else. It showed a
-- "Saved" tick for data that never left the browser.

-- The gate itself lives on profiles: it is read on every withdrawal, so it
-- wants to be one cheap lookup with no join.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS kyc_status           text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS kyc_reviewed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_rejection_reason text;

DO $kyc$
BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_kyc_status_check
    CHECK (kyc_status IN ('unverified', 'pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'profiles_kyc_status_check already exists';
END
$kyc$;

-- The identity data itself lives in its own table, NOT on profiles. Profiles
-- is read constantly and widely; this holds real personal data and should be
-- reachable from as few places as possible. Keeping submissions as rows also
-- leaves an audit trail across a rejection and resubmission, which a set of
-- columns on profiles would overwrite.
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  legal_name       text NOT NULL,
  date_of_birth    date NOT NULL,
  address_line1    text NOT NULL,
  address_line2    text,
  city             text NOT NULL,
  region           text NOT NULL,
  postal_code      text NOT NULL,
  country          text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  rejection_reason text,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid,
  CONSTRAINT kyc_submissions_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_kyc_submissions_status
  ON kyc_submissions (status, submitted_at);

-- One review in the queue per person. A partial unique index is what broke the
-- USDC deposits (uniq_tx_extra_id matched on a literal string, so only one row
-- could ever exist), so this one is deliberately narrow: it only constrains
-- rows that are actually pending, and the submit route UPDATES an existing
-- pending row rather than inserting a second one, so it should never be hit.
-- It is a backstop against a bug, not part of the normal path.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kyc_pending_per_user
  ON kyc_submissions (user_id) WHERE status = 'pending';

-- Nothing but the backend's service role may read this. Service role bypasses
-- RLS, so enabling it with no policies means the anon and authenticated keys
-- cannot reach the table at all.
ALTER TABLE kyc_submissions ENABLE ROW LEVEL SECURITY;

-- Check:
--   SELECT kyc_status, count(*) FROM profiles GROUP BY 1;
--   SELECT status, count(*) FROM kyc_submissions GROUP BY 1;

-- ── Optional: existing players ──────────────────────────────────────────────
-- Every withdrawal is now gated on KYC, so on deploy EVERY existing player is
-- 'unverified' and withdrawals stop for all of them until they submit and are
-- approved. That is the intended behaviour.
--
-- If you would rather not strand people who have already withdrawn
-- successfully, this grandfathers them. Left commented out deliberately: it
-- marks people approved whose identity was never actually checked, which is
-- exactly what a provider's audit would ask about. Run it only as a knowing
-- decision.
--
-- UPDATE profiles SET kyc_status = 'approved', kyc_reviewed_at = now()
--  WHERE id IN (SELECT DISTINCT user_id FROM transactions
--                WHERE type = 'withdrawal' AND status = 'confirmed');


-- ============================================================================
-- 14. KYC via Didit — replacing the manual form
-- ============================================================================
-- Section 13 built a manual review queue: the player typed a name, address and
-- date of birth and an admin approved it. That verified nothing — anyone could
-- type a plausible name. Didit now does the real check (genuine document, face
-- matches the document, live person) and reports the decision by webhook.
--
-- The identity fields become nullable because we no longer collect them; Didit
-- holds the document and we keep only its verdict. Existing rows are untouched.
ALTER TABLE kyc_submissions
  ADD COLUMN IF NOT EXISTS didit_session_id text,
  ADD COLUMN IF NOT EXISTS didit_url        text,
  ADD COLUMN IF NOT EXISTS didit_status     text,
  ADD COLUMN IF NOT EXISTS didit_updated_at bigint,
  ADD COLUMN IF NOT EXISTS decision         jsonb;

ALTER TABLE kyc_submissions
  ALTER COLUMN legal_name    DROP NOT NULL,
  ALTER COLUMN date_of_birth DROP NOT NULL,
  ALTER COLUMN address_line1 DROP NOT NULL,
  ALTER COLUMN city          DROP NOT NULL,
  ALTER COLUMN region        DROP NOT NULL,
  ALTER COLUMN postal_code   DROP NOT NULL,
  ALTER COLUMN country       DROP NOT NULL;

-- One row per Didit session. The webhook looks a session up by this id, and a
-- duplicate would mean a decision applied to the wrong row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kyc_didit_session
  ON kyc_submissions (didit_session_id) WHERE didit_session_id IS NOT NULL;

-- Section 13 allowed only one pending row per user, which was right when a
-- person submitted a form once. With Didit a player can abandon a session and
-- start another, so that constraint would block them from ever retrying.
DROP INDEX IF EXISTS uniq_kyc_pending_per_user;

-- Check:
--   SELECT status, didit_status, count(*) FROM kyc_submissions GROUP BY 1,2;


-- ============================================================================
-- 15. Closed: direct-write access via the anon/authenticated keys
-- ============================================================================
-- A real incident, not a hardening exercise. A registered player (no deposit,
-- no match ever played) had profiles.c_coins = 1,000.00 and tried seven
-- withdrawals across four coins in twenty minutes. All seven failed only
-- because the payout wallet held $4.44 — had it been funded, $755 would have
-- gone out.
--
-- The frontend makes NO direct Supabase table calls; it uses Supabase only for
-- auth, and talks to every table through this backend's service role. But the
-- anon key is (correctly, by design) embedded in the shipped JS bundle, and
-- Postgres' default GRANTs on a fresh Supabase project hand the anon and
-- authenticated roles INSERT/UPDATE/DELETE on every table, independent of RLS
-- policies. RLS was enabled on profiles, but permissive UPDATE policies plus
-- those default grants meant a browser could PATCH its own c_coins directly
-- against Supabase's REST API — never touching this backend, never creating a
-- transaction row, which is exactly why it showed no deposit.
--
-- Fixed by revoking write access outright: nothing in this app needs it.
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Verified by attempting the exact exploit from a real logged-in session
-- (PATCH .../rest/v1/profiles with the anon key) — it now returns
-- 403 { "code": "42501", "message": "permission denied for table profiles" }.
--
-- Re-check after adding any new table — this does not apply automatically to
-- ones created later:
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
--     AND privilege_type IN ('INSERT','UPDATE','DELETE');
-- Expected: zero rows.


-- ============================================================================
-- 16. Close the gap in section 15: make it apply to future tables too
-- ============================================================================
-- Section 15 was a one-time sweep — it revoked write access from every table
-- that existed at the moment it ran, and nothing made that automatic for
-- tables created afterward. Its own comment already said "re-check after
-- adding any new table," which just means the fix depended on remembering to
-- redo it — the same shape of gap that let the original exploit through,
-- just waiting on the next migration instead of already open.
--
-- ALTER DEFAULT PRIVILEGES changes what NEW objects are granted at creation
-- time, for objects created by the role running this statement. It does not
-- touch existing tables — section 15 already covers those — and it does not
-- retroactively change ownership. Run once; every table this project creates
-- from now on starts with anon/authenticated write access already revoked,
-- with no step to remember.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated;

-- Check: create a throwaway table and confirm the grant never appears.
--   CREATE TABLE _dp_check (id int);
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = '_dp_check' AND grantee IN ('anon','authenticated');
--   -- Expected: zero rows.
--   DROP TABLE _dp_check;


-- ============================================================================
-- 17. Admin tools: real account bans, and a transaction type for manual
--     balance corrections
-- ============================================================================
-- Bans only ever existed as an in-memory, chat-only Set (chatBanned in
-- socket/handlers.js) — it stops someone posting in chat and nothing else.
-- There was no way to actually stop a player using the platform at all.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS banned      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ban_reason  text,
  ADD COLUMN IF NOT EXISTS banned_at   timestamptz;

-- 'admin_adjustment' — a manual credit or debit an admin makes from the new
-- player detail panel, for refunds/compensation/corrections. Every one of
-- these MUST leave a transaction row — the whole reason transactions_type_check
-- exists is that a code path writing an unlisted type gets silently rejected
-- by Postgres, and this is real money moving with no other record of why.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit',
  'deposit_raw',
  'withdrawal',
  'match_win',
  'match_loss',
  'match_draw',
  'match_refund',
  'tip_sent',
  'tip_received',
  'daily_bonus',
  'diamond_bonus',
  'rewards_spin',
  'referral_bonus',
  'fee_collection',
  'admin_adjustment'
));

-- Check:
--   SELECT username, banned, ban_reason FROM profiles WHERE banned = true;
--   SELECT type, count(*) FROM transactions WHERE type = 'admin_adjustment' GROUP BY 1;


-- ============================================================================
-- 18. Profile pictures and player reports
-- ============================================================================
-- Avatars are the platform's first user-generated content, which is why the
-- moderation columns land in the same migration rather than being bolted on
-- afterwards.
--
-- avatar_url    the uploaded image (Supabase Storage public URL), or NULL for
--               the existing coloured-initial avatar. NULL is the default and
--               stays a first-class state, not an error case.
-- avatar_banned an admin removed a picture and revoked the right to upload
--               another. Without this, "remove picture" is an invitation to
--               immediately re-upload the same thing. Enforced server-side at
--               upload time, never only in the UI.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS avatar_url    text,
  ADD COLUMN IF NOT EXISTS avatar_banned boolean NOT NULL DEFAULT false;

-- One row per report. Kept even after the reported player is dealt with —
-- a dismissed report is evidence too, and a repeat reporter is a pattern
-- worth being able to see.
CREATE TABLE IF NOT EXISTS player_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reported_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason       text NOT NULL,
  details      text,
  status       text NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid,
  CONSTRAINT player_reports_reason_check CHECK (reason IN ('pfp', 'cheating', 'other')),
  CONSTRAINT player_reports_status_check CHECK (status IN ('open', 'actioned', 'dismissed')),
  -- Reporting yourself is always a mistake or an abuse of the feature.
  CONSTRAINT player_reports_not_self CHECK (reporter_id <> reported_id)
);

CREATE INDEX IF NOT EXISTS idx_player_reports_reported
  ON player_reports (reported_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_reports_open
  ON player_reports (status, created_at DESC);

-- One OPEN report per person, per target, per reason. A player spamming the
-- button cannot inflate a count and make someone look worse than they are;
-- once a report is actioned or dismissed they can raise a fresh one if the
-- behaviour continues.
--
-- Partial, like uniq_kyc_pending_per_user and for the same reason: the
-- uniq_tx_extra_id incident was an unconditional unique index on a column
-- holding a literal, which allowed exactly one row to exist platform-wide.
-- This one only constrains rows that are actually open.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_report_per_reporter
  ON player_reports (reporter_id, reported_id, reason) WHERE status = 'open';

-- Backend-only, same as kyc_submissions: service role bypasses RLS, and
-- enabling it with no policies means the anon and authenticated keys cannot
-- read or write reports directly.
ALTER TABLE player_reports ENABLE ROW LEVEL SECURITY;

-- Check:
--   SELECT reason, status, count(*) FROM player_reports GROUP BY 1,2;
--   SELECT count(*) FROM profiles WHERE avatar_url IS NOT NULL;
