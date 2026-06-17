-- ================================================================
-- DUELY — COMPLETE DATABASE SCHEMA
-- Last updated: 2026-06-17
-- ================================================================
-- Paste into Supabase SQL editor and run.
-- Safe to re-run: uses IF NOT EXISTS and CREATE OR REPLACE.
-- ================================================================


-- ────────────────────────────────────────────────────────────────
-- 1. TABLES
-- ────────────────────────────────────────────────────────────────

-- One row per registered user
CREATE TABLE IF NOT EXISTS profiles (
  id                          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username                    text UNIQUE NOT NULL,
  wallet_address              text,
  profile_color               text DEFAULT '#1E90FF',
  is_private                  boolean DEFAULT false,

  -- Game stats
  elo                         integer DEFAULT 1000,
  wins                        integer DEFAULT 0,
  losses                      integer DEFAULT 0,
  streak                      integer DEFAULT 0,
  current_streak              integer DEFAULT 0,
  best_streak                 integer DEFAULT 0,

  -- Balances
  c_coins                     numeric DEFAULT 0 CHECK (c_coins >= 0),
  diamonds                    bigint  DEFAULT 0 CHECK (diamonds >= 0),

  -- Admin fee collection
  fee_balance                 numeric DEFAULT 0 CHECK (fee_balance >= 0),

  -- Deposit/withdrawal tracking
  crypto_deposited            numeric DEFAULT 0,
  crypto_withdrawn            numeric DEFAULT 0,
  fiat_deposited              numeric DEFAULT 0,
  fiat_withdrawn              numeric DEFAULT 0,

  -- Affiliate system
  affiliate_code              text UNIQUE,
  applied_affiliate_code      text,
  applied_code_expires_at     timestamptz,
  affiliate_earnings_c        numeric DEFAULT 0,
  affiliate_earnings_diamonds bigint  DEFAULT 0,
  is_creator_code             boolean DEFAULT false,

  -- Bonus cooldowns
  last_bonus_claimed          timestamptz,
  last_diamond_bonus          timestamptz,
  last_spin_claimed           timestamptz,
  last_spin_at                timestamptz,

  -- Per-tier spin cooldowns
  last_spin_bronze            timestamptz,
  last_spin_silver            timestamptz,
  last_spin_gold              timestamptz,
  last_spin_diamond           timestamptz,
  last_spin_champion          timestamptz,

  -- Rakeback buckets
  rakeback_instant            numeric DEFAULT 0,
  rakeback_instant_at         timestamptz,
  rakeback_daily              numeric DEFAULT 0,
  rakeback_daily_at           timestamptz,
  rakeback_weekly             numeric DEFAULT 0,
  rakeback_weekly_at          timestamptz,

  created_at                  timestamptz DEFAULT now()
);

-- Safe column additions for existing deployments
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS current_streak              integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS best_streak                 integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS fee_balance                 numeric DEFAULT 0 CHECK (fee_balance >= 0);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_at                timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_bronze            timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_silver            timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_gold              timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_diamond           timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_champion          timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rakeback_instant            numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rakeback_instant_at         timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rakeback_daily              numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rakeback_daily_at           timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rakeback_weekly             numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rakeback_weekly_at          timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_creator_code             boolean DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS diamonds                    bigint DEFAULT 0 CHECK (diamonds >= 0);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_diamond_bonus          timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_private                  boolean DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS affiliate_code              text UNIQUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS applied_affiliate_code      text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS applied_code_expires_at     timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS affiliate_earnings_c        numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS affiliate_earnings_diamonds bigint  DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS crypto_deposited            numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS crypto_withdrawn            numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS fiat_deposited              numeric DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS fiat_withdrawn              numeric DEFAULT 0;


-- One row per completed match (PvP and bot)
CREATE TABLE IF NOT EXISTS matches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  player2_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  winner_id           uuid REFERENCES profiles(id) ON DELETE SET NULL,
  game_type           text,

  -- Coin match fields
  entry_fee_c         numeric DEFAULT 0,
  prize_pool_c        numeric DEFAULT 0,
  platform_fee_c      numeric DEFAULT 0,

  -- Diamond match fields
  entry_fee_diamonds  bigint DEFAULT 0,
  prize_pool_diamonds bigint DEFAULT 0,

  -- Game-specific metadata
  reaction_time_ms    integer,
  early_click         boolean,

  played_at           timestamptz DEFAULT now()
);

ALTER TABLE matches ADD COLUMN IF NOT EXISTS game_type           text;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS entry_fee_diamonds  bigint DEFAULT 0;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS prize_pool_diamonds bigint DEFAULT 0;


-- Full audit log of every coin/diamond movement
CREATE TABLE IF NOT EXISTS transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES profiles(id) ON DELETE CASCADE,
  type           text NOT NULL,
  amount_c       numeric DEFAULT 0,
  crypto_amount  numeric,
  crypto_symbol  text,
  tx_hash        text,
  extra_id       text,
  notes          text,
  status         text DEFAULT 'pending',
  created_at     timestamptz DEFAULT now()
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS extra_id text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS notes    text;

-- Drop old restrictive type constraint and replace with full allowlist
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'deposit', 'withdrawal',
    'match_win', 'match_loss', 'match_draw',
    'tip_sent', 'tip_received',
    'daily_bonus', 'diamond_bonus', 'bonus', 'rewards_spin',
    'affiliate_payment', 'rakeback', 'fee_collection'
  ));


-- Personal best score per player per game
CREATE TABLE IF NOT EXISTS game_highscores (
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  game_type  text NOT NULL,
  score      numeric NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, game_type)
);


-- Per-user deposit addresses (one address per coin per user)
CREATE TABLE IF NOT EXISTS deposit_addresses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES profiles(id) ON DELETE CASCADE,
  coin       text NOT NULL,
  address    text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, coin)
);


-- Friends / social
CREATE TABLE IF NOT EXISTS friends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  addressee_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz DEFAULT now(),
  UNIQUE (requester_id, addressee_id)
);


-- ────────────────────────────────────────────────────────────────
-- 2. INDEXES
-- ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_profiles_elo             ON profiles(elo DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_current_streak  ON profiles(current_streak DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_best_streak     ON profiles(best_streak DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_diamonds        ON profiles(diamonds DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_c_coins         ON profiles(c_coins DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_affiliate_code  ON profiles(affiliate_code);

CREATE INDEX IF NOT EXISTS idx_matches_player1          ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_player2          ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_game_type        ON matches(game_type);
CREATE INDEX IF NOT EXISTS idx_matches_played_at        ON matches(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_entry_fee_c      ON matches(entry_fee_c)       WHERE entry_fee_c > 0;
CREATE INDEX IF NOT EXISTS idx_matches_entry_fee_dia    ON matches(entry_fee_diamonds) WHERE entry_fee_diamonds > 0;

CREATE INDEX IF NOT EXISTS idx_tx_user_id               ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_type                  ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_created_at            ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_hash                  ON transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_tx_pending               ON transactions(status)        WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_highscores_game          ON game_highscores(game_type, score DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_addresses_addr   ON deposit_addresses(address);


-- ────────────────────────────────────────────────────────────────
-- 3. RPC FUNCTIONS
-- ────────────────────────────────────────────────────────────────

-- ── Coin operations ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION credit_coins(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF amount <= 0 THEN RAISE EXCEPTION 'Credit amount must be positive'; END IF;
  UPDATE profiles SET c_coins = c_coins + amount WHERE id = user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION deduct_coins(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  UPDATE profiles SET c_coins = c_coins - amount
  WHERE id = user_id AND c_coins >= amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
END;
$$;

-- Fully atomic coin match settlement.
-- Locks both rows (UUID order to prevent deadlocks), validates balances,
-- deducts both entry fees, credits winner 95% of pot.
CREATE OR REPLACE FUNCTION settle_match_coins(
  p_winner_id uuid,
  p_loser_id  uuid,
  p_entry_fee numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_prize_pool  numeric := ROUND(p_entry_fee * 2, 4);
  v_fee         numeric := ROUND(v_prize_pool * 0.05, 4);
  v_payout      numeric := ROUND(v_prize_pool - v_fee, 4);
  v_winner_bal  numeric;
  v_loser_bal   numeric;
BEGIN
  IF p_entry_fee <= 0 THEN RAISE EXCEPTION 'Entry fee must be positive'; END IF;

  IF p_winner_id < p_loser_id THEN
    SELECT c_coins INTO v_winner_bal FROM profiles WHERE id = p_winner_id FOR UPDATE;
    SELECT c_coins INTO v_loser_bal  FROM profiles WHERE id = p_loser_id  FOR UPDATE;
  ELSE
    SELECT c_coins INTO v_loser_bal  FROM profiles WHERE id = p_loser_id  FOR UPDATE;
    SELECT c_coins INTO v_winner_bal FROM profiles WHERE id = p_winner_id FOR UPDATE;
  END IF;

  IF v_winner_bal IS NULL OR v_winner_bal < p_entry_fee THEN
    RAISE EXCEPTION 'winner_insufficient_balance';
  END IF;
  IF v_loser_bal IS NULL OR v_loser_bal < p_entry_fee THEN
    RAISE EXCEPTION 'loser_insufficient_balance';
  END IF;

  UPDATE profiles SET c_coins = c_coins - p_entry_fee WHERE id = p_winner_id;
  UPDATE profiles SET c_coins = c_coins - p_entry_fee WHERE id = p_loser_id;
  UPDATE profiles SET c_coins = c_coins + v_payout    WHERE id = p_winner_id;

  RETURN jsonb_build_object('winnerPayout', v_payout, 'prizePool', v_prize_pool, 'fee', v_fee);
END;
$$;


-- ── Diamond operations ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION credit_diamonds(user_id uuid, amount bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF amount <= 0 THEN RAISE EXCEPTION 'Credit amount must be positive'; END IF;
  UPDATE profiles SET diamonds = diamonds + amount WHERE id = user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION deduct_diamonds(user_id uuid, amount bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  UPDATE profiles SET diamonds = diamonds - amount
  WHERE id = user_id AND diamonds >= amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
END;
$$;

-- Diamond match settlement — no platform fee, winner gets full 2x.
CREATE OR REPLACE FUNCTION settle_match_diamonds(
  p_winner_id uuid,
  p_loser_id  uuid,
  p_entry_fee bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_payout     bigint := p_entry_fee * 2;
  v_winner_bal bigint;
  v_loser_bal  bigint;
BEGIN
  IF p_entry_fee <= 0 THEN RAISE EXCEPTION 'Entry fee must be positive'; END IF;

  IF p_winner_id < p_loser_id THEN
    SELECT diamonds INTO v_winner_bal FROM profiles WHERE id = p_winner_id FOR UPDATE;
    SELECT diamonds INTO v_loser_bal  FROM profiles WHERE id = p_loser_id  FOR UPDATE;
  ELSE
    SELECT diamonds INTO v_loser_bal  FROM profiles WHERE id = p_loser_id  FOR UPDATE;
    SELECT diamonds INTO v_winner_bal FROM profiles WHERE id = p_winner_id FOR UPDATE;
  END IF;

  IF v_winner_bal IS NULL OR v_winner_bal < p_entry_fee THEN
    RAISE EXCEPTION 'winner_insufficient_diamonds';
  END IF;
  IF v_loser_bal IS NULL OR v_loser_bal < p_entry_fee THEN
    RAISE EXCEPTION 'loser_insufficient_diamonds';
  END IF;

  UPDATE profiles SET diamonds = diamonds - p_entry_fee WHERE id = p_winner_id;
  UPDATE profiles SET diamonds = diamonds - p_entry_fee WHERE id = p_loser_id;
  UPDATE profiles SET diamonds = diamonds + v_payout    WHERE id = p_winner_id;

  RETURN jsonb_build_object('winnerPayout', v_payout, 'prizePool', p_entry_fee * 2);
END;
$$;


-- ── Win / loss counters ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_win(uid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET wins = wins + 1 WHERE id = uid;
END;
$$;

CREATE OR REPLACE FUNCTION increment_loss(uid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET losses = losses + 1 WHERE id = uid;
END;
$$;


-- ── Deposit/withdrawal tracking ──────────────────────────────────

CREATE OR REPLACE FUNCTION increment_crypto_deposited(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET crypto_deposited = COALESCE(crypto_deposited, 0) + amount WHERE id = user_id;
END;
$$;

CREATE OR REPLACE FUNCTION increment_crypto_withdrawn(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET crypto_withdrawn = COALESCE(crypto_withdrawn, 0) + amount WHERE id = user_id;
END;
$$;

CREATE OR REPLACE FUNCTION increment_fiat_deposited(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET fiat_deposited = COALESCE(fiat_deposited, 0) + amount WHERE id = user_id;
END;
$$;

CREATE OR REPLACE FUNCTION increment_fiat_withdrawn(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET fiat_withdrawn = COALESCE(fiat_withdrawn, 0) + amount WHERE id = user_id;
END;
$$;


-- ── Admin fee balance ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION credit_fee_balance(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET fee_balance = COALESCE(fee_balance, 0) + amount WHERE id = user_id;
END;
$$;

-- Moves entire fee_balance into c_coins atomically. Returns amount collected.
CREATE OR REPLACE FUNCTION collect_admin_fees(admin_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fee numeric;
BEGIN
  SELECT fee_balance INTO v_fee FROM profiles WHERE id = admin_id FOR UPDATE;
  IF v_fee IS NULL OR v_fee <= 0 THEN RETURN 0; END IF;
  UPDATE profiles
  SET c_coins     = c_coins + v_fee,
      fee_balance = 0
  WHERE id = admin_id;
  RETURN v_fee;
END;
$$;


-- ── Affiliate system ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION credit_affiliate_c(owner_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles
  SET affiliate_earnings_c = COALESCE(affiliate_earnings_c, 0) + amount
  WHERE id = owner_id;
END;
$$;

CREATE OR REPLACE FUNCTION credit_affiliate_d(owner_id uuid, amount bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles
  SET affiliate_earnings_diamonds = COALESCE(affiliate_earnings_diamonds, 0) + amount
  WHERE id = owner_id;
END;
$$;


-- ── Bonus claims ─────────────────────────────────────────────────

DROP FUNCTION IF EXISTS claim_daily_bonus(uuid);
DROP FUNCTION IF EXISTS claim_diamond_bonus(uuid, bigint);

-- Daily coin bonus — 24h cooldown, awards 1 coin
CREATE OR REPLACE FUNCTION claim_daily_bonus(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE profiles
  SET c_coins            = c_coins + 1,
      last_bonus_claimed = now()
  WHERE id = p_user_id
    AND (last_bonus_claimed IS NULL
         OR now() - last_bonus_claimed >= INTERVAL '24 hours');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'already_claimed'; END IF;
  RETURN jsonb_build_object('credited', 1);
END;
$$;

-- Diamond bonus — 30min cooldown, awards p_amount diamonds
CREATE OR REPLACE FUNCTION claim_diamond_bonus(p_user_id uuid, p_amount bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE profiles
  SET diamonds           = diamonds + p_amount,
      last_diamond_bonus = now()
  WHERE id = p_user_id
    AND (last_diamond_bonus IS NULL
         OR now() - last_diamond_bonus >= INTERVAL '30 minutes');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'already_claimed'; END IF;
  RETURN jsonb_build_object('credited', p_amount);
END;
$$;


-- ── Win-streak ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_win_streak(p_winner_id uuid, p_loser_id uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_streak int;
BEGIN
  UPDATE profiles
  SET current_streak = COALESCE(current_streak, 0) + 1,
      best_streak    = GREATEST(COALESCE(best_streak, 0), COALESCE(current_streak, 0) + 1)
  WHERE id = p_winner_id
  RETURNING current_streak INTO v_new_streak;

  IF p_loser_id IS NOT NULL THEN
    UPDATE profiles SET current_streak = 0 WHERE id = p_loser_id;
  END IF;

  RETURN COALESCE(v_new_streak, 0);
END;
$$;


-- ── Rakeback ─────────────────────────────────────────────────────
-- 0.5% of prize pool per match, split evenly across 3 buckets.
-- Each player gets 0.25% of prize pool (0.5% total across both players).

-- Convenience: adds p_amount / 3 to each bucket atomically.
CREATE OR REPLACE FUNCTION add_rakeback(p_user_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_share numeric := ROUND(p_amount / 3, 4);
BEGIN
  UPDATE profiles SET
    rakeback_instant = COALESCE(rakeback_instant, 0) + v_share,
    rakeback_daily   = COALESCE(rakeback_daily,   0) + v_share,
    rakeback_weekly  = COALESCE(rakeback_weekly,  0) + v_share
  WHERE id = p_user_id;
END;
$$;

-- Individual bucket increments
CREATE OR REPLACE FUNCTION add_rakeback_instant(p_user_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET rakeback_instant = COALESCE(rakeback_instant, 0) + p_amount WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_rakeback_daily(p_user_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET rakeback_daily = COALESCE(rakeback_daily, 0) + p_amount WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION add_rakeback_weekly(p_user_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET rakeback_weekly = COALESCE(rakeback_weekly, 0) + p_amount WHERE id = p_user_id;
END;
$$;

DROP FUNCTION IF EXISTS claim_rakeback_instant(uuid);
DROP FUNCTION IF EXISTS claim_rakeback_daily(uuid);
DROP FUNCTION IF EXISTS claim_rakeback_weekly(uuid);

-- Instant claim — 5 minute cooldown, claims FLOOR(balance) whole coins only.
-- Fractional remainder stays in bucket and keeps accumulating.
CREATE OR REPLACE FUNCTION claim_rakeback_instant(p_user_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance numeric;
  v_claim   int;
  v_last    timestamptz;
BEGIN
  SELECT rakeback_instant, rakeback_instant_at INTO v_balance, v_last
  FROM profiles WHERE id = p_user_id FOR UPDATE;
  v_claim := FLOOR(COALESCE(v_balance, 0));
  IF v_claim < 1 THEN RAISE EXCEPTION 'nothing_to_claim'; END IF;
  IF v_last IS NOT NULL AND now() - v_last < INTERVAL '5 minutes' THEN RAISE EXCEPTION 'cooldown_active'; END IF;
  UPDATE profiles
  SET rakeback_instant    = rakeback_instant - v_claim,
      c_coins             = COALESCE(c_coins, 0) + v_claim,
      rakeback_instant_at = now()
  WHERE id = p_user_id;
  RETURN v_claim;
END;
$$;

-- Daily claim — 24h cooldown, claims FLOOR(balance) whole coins only.
CREATE OR REPLACE FUNCTION claim_rakeback_daily(p_user_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance numeric;
  v_claim   int;
  v_last    timestamptz;
BEGIN
  SELECT rakeback_daily, rakeback_daily_at INTO v_balance, v_last
  FROM profiles WHERE id = p_user_id FOR UPDATE;
  v_claim := FLOOR(COALESCE(v_balance, 0));
  IF v_claim < 1 THEN RAISE EXCEPTION 'nothing_to_claim'; END IF;
  IF v_last IS NOT NULL AND now() - v_last < INTERVAL '24 hours' THEN RAISE EXCEPTION 'cooldown_active'; END IF;
  UPDATE profiles
  SET rakeback_daily    = rakeback_daily - v_claim,
      c_coins           = COALESCE(c_coins, 0) + v_claim,
      rakeback_daily_at = now()
  WHERE id = p_user_id;
  RETURN v_claim;
END;
$$;

-- Weekly claim — resets each Monday midnight UTC, claims FLOOR(balance) whole coins only.
CREATE OR REPLACE FUNCTION claim_rakeback_weekly(p_user_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance numeric;
  v_claim   int;
  v_last    timestamptz;
  v_monday  timestamptz;
BEGIN
  SELECT rakeback_weekly, rakeback_weekly_at INTO v_balance, v_last
  FROM profiles WHERE id = p_user_id FOR UPDATE;
  v_claim := FLOOR(COALESCE(v_balance, 0));
  IF v_claim < 1 THEN RAISE EXCEPTION 'nothing_to_claim'; END IF;
  v_monday := date_trunc('week', now());
  IF v_last IS NOT NULL AND v_last >= v_monday THEN RAISE EXCEPTION 'cooldown_active'; END IF;
  UPDATE profiles
  SET rakeback_weekly    = rakeback_weekly - v_claim,
      c_coins            = COALESCE(c_coins, 0) + v_claim,
      rakeback_weekly_at = now()
  WHERE id = p_user_id;
  RETURN v_claim;
END;
$$;


-- ────────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────────
-- Backend uses the service role key (bypasses RLS).
-- These policies control the frontend anon/auth client.

ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_highscores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends           ENABLE ROW LEVEL SECURITY;

-- profiles: public read, owner-only write
DROP POLICY IF EXISTS "profiles_select" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- matches: public read
DROP POLICY IF EXISTS "matches_select" ON matches;
CREATE POLICY "matches_select" ON matches FOR SELECT USING (true);

-- transactions: owner-only read
DROP POLICY IF EXISTS "transactions_select" ON transactions;
CREATE POLICY "transactions_select" ON transactions FOR SELECT USING (auth.uid() = user_id);

-- game_highscores: public read
DROP POLICY IF EXISTS "highscores_select" ON game_highscores;
CREATE POLICY "highscores_select" ON game_highscores FOR SELECT USING (true);

-- deposit_addresses: owner-only read
DROP POLICY IF EXISTS "deposit_addresses_select" ON deposit_addresses;
CREATE POLICY "deposit_addresses_select" ON deposit_addresses FOR SELECT USING (auth.uid() = user_id);

-- friends: users can read rows where they are requester or addressee
DROP POLICY IF EXISTS "friends_select" ON friends;
CREATE POLICY "friends_select" ON friends FOR SELECT USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
