/**
 * Referral rewards.
 *
 * A referred player who deposits at least $10 and wagers at least $50 earns
 * their referrer 2 coins, credited after a 7-day hold.
 *
 * WHY THOSE NUMBERS — this has to be self-funding or it is a money pump.
 * Rake is 5% of the prize pool and the pool is twice the entry fee, so the
 * house takes 10c per $1 wagered; after rakeback (0.5%) and the referrer's own
 * affiliate cut (0.5%), the platform keeps 8c. $50 wagered therefore earns $4
 * against a $2 reward — a 50% margin.
 *
 * It is also what makes farming pointless: a fake account must burn $5 of rake
 * to unlock $2, losing $3 a time. No fraud detection can be as reliable as
 * making the attack unprofitable arithmetic.
 *
 * COIN FLIP DOES NOT COUNT. It rakes 2% of pool rather than 5%, so $50 wagered
 * there yields about $1.55 to the platform — less than the reward. Counting it
 * would reopen exactly the hole the volume bar closes.
 *
 * That exclusion is structural, not a list of game names. Coin Flip settles
 * through settleCoinFlip and every 5%-rake game settles through settleMatch, so
 * hooking trackWager into settleMatch alone excludes it by construction. A name
 * list would silently start counting Coin Flip the day a string changed.
 */

const MIN_DEPOSIT_USD  = 10;
const MIN_WAGERED_USD  = 50;
const REWARD_COINS     = 2;
const HOLD_DAYS        = 7;

/**
 * Add a settled match's stake to a player's qualifying volume, then check
 * whether that tips them over the bar.
 *
 * Called once per player per settled 5%-rake coin match. Safe to call for
 * players with no referrer — it returns immediately.
 */
async function trackWager(supabase, userId, entryFee) {
  if (!supabase || !userId) return;
  const fee = parseFloat(entryFee) || 0;
  if (fee <= 0) return;

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('referred_by, qualifying_wagered_c, crypto_deposited, fiat_deposited')
      .eq('id', userId)
      .single();

    // No referrer means nothing to track. Checked before the increment so the
    // column stays meaningful — it is a referral counter, not a global one.
    if (!profile?.referred_by) return;

    const { data: updated } = await supabase
      .rpc('increment_qualifying_wagered', { user_id: userId, amount: fee })
      .catch(() => ({ data: null }));

    const wagered = updated != null
      ? parseFloat(updated)
      : (parseFloat(profile.qualifying_wagered_c) || 0) + fee;

    const deposited = (parseFloat(profile.crypto_deposited) || 0)
                    + (parseFloat(profile.fiat_deposited) || 0);

    if (deposited >= MIN_DEPOSIT_USD && wagered >= MIN_WAGERED_USD) {
      await claimReferralReward(supabase, profile.referred_by, userId);
    }
  } catch (e) {
    // Never let a reward bookkeeping error break a settlement — the money that
    // matters has already moved by this point.
    console.error('[referral] trackWager:', e.message);
  }
}

/**
 * Record that a referral has qualified. Idempotent: the unique index on
 * referred_id means exactly one row can ever exist per referred account, so a
 * player who keeps playing past the bar cannot earn the reward twice.
 *
 * Nothing is credited here — the row is created 'pending' and paid out later by
 * payMaturedRewards, so a chargeback or a ban inside the hold window can still
 * cancel it.
 */
async function claimReferralReward(supabase, referrerId, referredId) {
  if (!referrerId || referrerId === referredId) return false;

  const matureAt = new Date(Date.now() + HOLD_DAYS * 86400_000).toISOString();
  const { error } = await supabase.from('referral_rewards').insert({
    referrer_id: referrerId,
    referred_id: referredId,
    amount_c:    REWARD_COINS,
    status:      'pending',
    mature_at:   matureAt,
  });

  if (error) {
    // 23505 = already qualified. Expected on every subsequent match they play.
    if (error.code === '23505') return false;
    console.error('[referral] claim failed:', error.message);
    return false;
  }
  console.log(`[referral] ${referredId} qualified — ${REWARD_COINS} coins pending for ${referrerId}`);
  return true;
}

/**
 * Credit rewards whose hold has elapsed. Claims each row by flipping
 * pending→paid FIRST and only credits the row it actually flipped, so a
 * concurrent run or a restart mid-loop cannot pay the same reward twice. Same
 * pattern as the deposit claim, for the same reason.
 */
async function payMaturedRewards(supabase) {
  const { creditCoins } = require('./walletService');
  try {
    const { data: due } = await supabase
      .from('referral_rewards')
      .select('id, referrer_id, amount_c')
      .eq('status', 'pending')
      .lte('mature_at', new Date().toISOString())
      .limit(100);
    if (!due?.length) return;

    for (const row of due) {
      const { data: claimed } = await supabase
        .from('referral_rewards')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id');
      if (!claimed?.length) continue;   // another run took it

      try {
        await creditCoins(supabase, row.referrer_id, row.amount_c);
        await supabase.from('transactions').insert({
          user_id: row.referrer_id, type: 'referral_bonus',
          amount_c: row.amount_c, status: 'confirmed',
        });
      } catch (e) {
        // Roll the claim back so a later run retries. No coins credited, none lost.
        await supabase.from('referral_rewards')
          .update({ status: 'pending', paid_at: null })
          .eq('id', row.id).eq('status', 'paid');
        console.error('[referral] credit failed, rolled back:', e.message);
      }
    }
  } catch (e) {
    console.error('[referral] payMaturedRewards:', e.message);
  }
}

/** Cancel a pending reward — used when a referred account is banned or refunded. */
async function clawback(supabase, referredId, reason = 'clawed_back') {
  await supabase.from('referral_rewards')
    .update({ status: reason })
    .eq('referred_id', referredId)
    .eq('status', 'pending')
    .then().catch(() => {});
}

/** Progress for the rewards page. */
async function getReferralStats(supabase, userId) {
  const [{ data: referred }, { data: rewards }] = await Promise.all([
    supabase.from('profiles')
      .select('id, username, qualifying_wagered_c, crypto_deposited, fiat_deposited')
      .eq('referred_by', userId),
    supabase.from('referral_rewards')
      .select('referred_id, status, amount_c')
      .eq('referrer_id', userId),
  ]);

  const byId = Object.fromEntries((rewards || []).map(r => [r.referred_id, r]));
  const people = (referred || []).map(p => {
    const deposited = (parseFloat(p.crypto_deposited) || 0) + (parseFloat(p.fiat_deposited) || 0);
    const wagered   = parseFloat(p.qualifying_wagered_c) || 0;
    const reward    = byId[p.id];
    return {
      username: p.username,
      deposited: Math.min(deposited, MIN_DEPOSIT_USD),
      wagered:   Math.min(wagered, MIN_WAGERED_USD),
      status:    reward?.status || 'in_progress',
    };
  });

  const earned  = (rewards || []).filter(r => r.status === 'paid')
    .reduce((s, r) => s + (parseFloat(r.amount_c) || 0), 0);
  const pending = (rewards || []).filter(r => r.status === 'pending')
    .reduce((s, r) => s + (parseFloat(r.amount_c) || 0), 0);

  return {
    people, earned, pending,
    rewardCoins: REWARD_COINS,
    minDeposit:  MIN_DEPOSIT_USD,
    minWagered:  MIN_WAGERED_USD,
    holdDays:    HOLD_DAYS,
  };
}

module.exports = {
  trackWager, claimReferralReward, payMaturedRewards, clawback, getReferralStats,
  MIN_DEPOSIT_USD, MIN_WAGERED_USD, REWARD_COINS, HOLD_DAYS,
};
