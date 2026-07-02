-- ELO / Win-Loss Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Safe to re-run — uses ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE

-- 1. Ensure elo, wins, losses columns exist on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS elo     integer DEFAULT 1000;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wins    integer DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS losses  integer DEFAULT 0;

-- 2. Backfill nulls for existing rows
UPDATE profiles SET elo     = 1000 WHERE elo     IS NULL;
UPDATE profiles SET wins    = 0    WHERE wins    IS NULL;
UPDATE profiles SET losses  = 0    WHERE losses  IS NULL;

-- 3. Create increment_win RPC (called by game engines to count wins)
CREATE OR REPLACE FUNCTION increment_win(uid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET wins = wins + 1 WHERE id = uid;
END;
$$;

-- 4. Create increment_loss RPC (called by game engines to count losses)
CREATE OR REPLACE FUNCTION increment_loss(uid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET losses = losses + 1 WHERE id = uid;
END;
$$;

-- 5. Index for leaderboard queries (skip if already exists)
CREATE INDEX IF NOT EXISTS idx_profiles_elo ON profiles(elo DESC);
