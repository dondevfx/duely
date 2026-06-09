-- ── Fee Balance Migration ──────────────────────────────────────────────────
-- Run this in Supabase SQL Editor once.

-- 1. Add fee_balance column to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS fee_balance numeric DEFAULT 0 CHECK (fee_balance >= 0);

-- 2. RPC: atomically increment fee_balance for admin
CREATE OR REPLACE FUNCTION credit_fee_balance(user_id uuid, amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles
  SET fee_balance = COALESCE(fee_balance, 0) + amount
  WHERE id = user_id;
END;
$$;

-- 3. RPC: atomically move fee_balance → c_coins (the "collect" action)
CREATE OR REPLACE FUNCTION collect_admin_fees(admin_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fee numeric;
BEGIN
  SELECT fee_balance INTO v_fee FROM profiles WHERE id = admin_id FOR UPDATE;
  IF v_fee IS NULL OR v_fee <= 0 THEN
    RETURN 0;
  END IF;
  UPDATE profiles
  SET c_coins     = c_coins + v_fee,
      fee_balance = 0
  WHERE id = admin_id;
  RETURN v_fee;
END;
$$;
