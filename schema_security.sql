-- ============================================================
-- Security patch — run this in Supabase SQL Editor
-- Fixes: silent deduction failures, non-atomic settlement,
--        bonus double-claim race, missing overflow protection
-- ============================================================

-- ── 1. deduct_coins: throw on insufficient balance ─────────────────
-- REPLACES the original void version which silently did nothing
create or replace function deduct_coins(user_id uuid, amount numeric)
returns void language plpgsql security definer as $$
begin
  if amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  update profiles set c_coins = c_coins - amount
  where id = user_id and c_coins >= amount;
  if not found then
    raise exception 'Insufficient balance';
  end if;
end;
$$;

-- ── 2. deduct_diamonds: throw on insufficient diamonds ─────────────
create or replace function deduct_diamonds(user_id uuid, amount bigint)
returns void language plpgsql security definer as $$
begin
  if amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  update profiles set diamonds = diamonds - amount
  where id = user_id and diamonds >= amount;
  if not found then
    raise exception 'Insufficient diamonds';
  end if;
end;
$$;

-- ── 3. credit_coins: guard against negative credits ────────────────
create or replace function credit_coins(user_id uuid, amount numeric)
returns void language plpgsql security definer as $$
begin
  if amount <= 0 then
    raise exception 'Credit amount must be positive';
  end if;
  update profiles set c_coins = c_coins + amount where id = user_id;
end;
$$;

-- ── 4. settle_match_coins: fully atomic match settlement ───────────
-- Locks both rows, validates both balances, deducts both, credits winner,
-- takes 5% platform fee — all in one transaction; cannot partially succeed.
-- Locks rows in consistent UUID order to prevent deadlocks.
create or replace function settle_match_coins(
  p_winner_id uuid,
  p_loser_id  uuid,
  p_entry_fee numeric
) returns jsonb language plpgsql security definer as $$
declare
  v_prize_pool numeric := round(p_entry_fee * 2, 4);
  v_fee        numeric := round(v_prize_pool * 0.05, 4);
  v_payout     numeric := round(v_prize_pool - v_fee, 4);
  v_winner_bal numeric;
  v_loser_bal  numeric;
begin
  if p_entry_fee <= 0 then
    raise exception 'Entry fee must be positive';
  end if;

  -- Lock rows in consistent UUID order to prevent deadlocks under concurrency
  if p_winner_id < p_loser_id then
    select c_coins into v_winner_bal from profiles where id = p_winner_id for update;
    select c_coins into v_loser_bal  from profiles where id = p_loser_id  for update;
  else
    select c_coins into v_loser_bal  from profiles where id = p_loser_id  for update;
    select c_coins into v_winner_bal from profiles where id = p_winner_id for update;
  end if;

  if v_winner_bal is null or v_winner_bal < p_entry_fee then
    raise exception 'winner_insufficient_balance';
  end if;
  if v_loser_bal is null or v_loser_bal < p_entry_fee then
    raise exception 'loser_insufficient_balance';
  end if;

  update profiles set c_coins = c_coins - p_entry_fee where id = p_winner_id;
  update profiles set c_coins = c_coins - p_entry_fee where id = p_loser_id;
  update profiles set c_coins = c_coins + v_payout   where id = p_winner_id;

  return jsonb_build_object(
    'prizePool',     v_prize_pool,
    'fee',           v_fee,
    'winnerPayout',  v_payout
  );
end;
$$;

-- ── 5. settle_match_diamonds: same but for diamonds ────────────────
create or replace function settle_match_diamonds(
  p_winner_id uuid,
  p_loser_id  uuid,
  p_entry_fee bigint
) returns jsonb language plpgsql security definer as $$
declare
  v_prize_pool bigint := p_entry_fee * 2;
  v_fee        bigint := floor(v_prize_pool * 0.05);
  v_payout     bigint := v_prize_pool - v_fee;
  v_winner_bal bigint;
  v_loser_bal  bigint;
begin
  if p_entry_fee <= 0 then
    raise exception 'Entry fee must be positive';
  end if;

  if p_winner_id < p_loser_id then
    select diamonds into v_winner_bal from profiles where id = p_winner_id for update;
    select diamonds into v_loser_bal  from profiles where id = p_loser_id  for update;
  else
    select diamonds into v_loser_bal  from profiles where id = p_loser_id  for update;
    select diamonds into v_winner_bal from profiles where id = p_winner_id for update;
  end if;

  if v_winner_bal is null or v_winner_bal < p_entry_fee then
    raise exception 'winner_insufficient_diamonds';
  end if;
  if v_loser_bal is null or v_loser_bal < p_entry_fee then
    raise exception 'loser_insufficient_diamonds';
  end if;

  update profiles set diamonds = diamonds - p_entry_fee where id = p_winner_id;
  update profiles set diamonds = diamonds - p_entry_fee where id = p_loser_id;
  update profiles set diamonds = diamonds + v_payout   where id = p_winner_id;

  return jsonb_build_object(
    'prizePool',    v_prize_pool,
    'fee',          v_fee,
    'winnerPayout', v_payout
  );
end;
$$;

-- ── 6. claim_daily_bonus: atomic — no double-claim possible ────────
-- Single UPDATE that checks + credits in one SQL statement.
-- Concurrent requests serialize at the row lock; the second will find
-- the timestamp already updated and return 0 rows → raises exception.
create or replace function claim_daily_bonus(p_user_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  v_rows int;
begin
  update profiles
  set c_coins            = c_coins + 1,
      last_bonus_claimed = now()
  where id = p_user_id
    and (last_bonus_claimed is null
         or now() - last_bonus_claimed >= interval '24 hours');

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'already_claimed';
  end if;

  return jsonb_build_object('credited', 1);
end;
$$;

-- ── 7. claim_diamond_bonus: atomic 30-min diamond bonus ───────────
create or replace function claim_diamond_bonus(p_user_id uuid, p_amount bigint)
returns jsonb language plpgsql security definer as $$
declare
  v_rows int;
begin
  update profiles
  set diamonds          = diamonds + p_amount,
      last_diamond_bonus = now()
  where id = p_user_id
    and (last_diamond_bonus is null
         or now() - last_diamond_bonus >= interval '30 minutes');

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'already_claimed';
  end if;

  return jsonb_build_object('credited', p_amount);
end;
$$;

-- ── 8. Misc column additions ───────────────────────────────────────
alter table transactions add column if not exists extra_id text;
alter table transactions add column if not exists notes   text;

-- Tighten the transactions type allowlist to include 'tip_sent'/'tip_received'
alter table transactions drop constraint if exists transactions_type_check;
alter table transactions add  constraint transactions_type_check
  check (type in (
    'deposit', 'withdrawal',
    'match_win', 'match_loss',
    'daily_bonus', 'diamond_bonus',
    'tip_sent', 'tip_received'
  ));
