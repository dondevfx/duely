-- Run this in your Supabase SQL Editor to add the diamond currency system

alter table profiles
  add column if not exists diamonds bigint default 0 check (diamonds >= 0),
  add column if not exists last_diamond_bonus timestamptz;

-- ── New columns (safe to run multiple times) ──────────────────────────────────

-- Private account flag
alter table profiles add column if not exists is_private boolean default false;

-- Game type on matches
alter table matches add column if not exists game_type text;
alter table matches add column if not exists entry_fee_diamonds bigint default 0;
alter table matches add column if not exists prize_pool_diamonds bigint default 0;

-- Extra ID on transactions (for withdrawal destination tags)
alter table transactions add column if not exists extra_id text;

-- Expand transactions type constraint to include tips, bonuses, and match types
-- Drop old constraint and recreate with all valid types
alter table transactions drop constraint if exists transactions_type_check;
alter table transactions add constraint transactions_type_check
  check (type in (
    'deposit', 'withdrawal',
    'match_win', 'match_loss',
    'daily_bonus', 'diamond_bonus', 'bonus',
    'tip_sent', 'tip_received'
  ));

-- ── Affiliate system ──────────────────────────────────────────────────────────
alter table profiles add column if not exists affiliate_code text unique;
alter table profiles add column if not exists applied_affiliate_code text;
alter table profiles add column if not exists applied_code_expires_at timestamptz;
alter table profiles add column if not exists affiliate_earnings_c numeric default 0;
alter table profiles add column if not exists affiliate_earnings_diamonds bigint default 0;

create or replace function credit_affiliate_c(owner_id uuid, amount numeric)
returns void language sql security definer as $$
  update profiles
  set affiliate_earnings_c = coalesce(affiliate_earnings_c, 0) + amount
  where id = owner_id;
$$;

create or replace function credit_affiliate_d(owner_id uuid, amount bigint)
returns void language sql security definer as $$
  update profiles
  set affiliate_earnings_diamonds = coalesce(affiliate_earnings_diamonds, 0) + amount
  where id = owner_id;
$$;

create or replace function credit_diamonds(user_id uuid, amount bigint)
returns void language sql security definer as $$
  update profiles set diamonds = diamonds + amount where id = user_id;
$$;

create or replace function deduct_diamonds(user_id uuid, amount bigint)
returns void language sql security definer as $$
  update profiles set diamonds = diamonds - amount where id = user_id and diamonds >= amount;
$$;
