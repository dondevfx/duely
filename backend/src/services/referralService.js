/**
 * Referral rewards.
 *
 * A referred player who deposits at least $10 and wagers at least $100 earns
 * their referrer 2 coins, collectable after a 7-day hold.
 *
 * WHY THOSE NUMBERS — this has to be self-funding or it is a money pump.
 *
 * Rake is 5% of the PRIZE POOL, and the pool is both players' entry fees. So a
 * player staking $1 sits in a $2 pool that yields 10c of rake, 8c of which the
 * platform keeps after rakeback and the referrer's own affiliate cut.
 *
 * Half of that pool is the OPPONENT's money though, and the opponent would
 * mostly have found a match anyway — so crediting the referred player with all
 * of it overstates what they actually brought in. The bar is therefore set on
 * the conservative half: 4c per $1 they stake. $100 wagered earns $4 against a
 * $2 reward, a 50% margin that holds even when their matches displace ones that
 * would have happened regardless.
 *
 * It is also what makes farming pointless: a fake account must burn $10 of rake
 * to unlock $2, losing $8 a time. No fraud detection can be as reliable as
 * making the attack unprofitable arithmetic.
 *
 * COIN FLIP DOES NOT COUNT. It rakes 2% of pool rather than 5%, so on the same
 * conservative basis $100 wagered there yields about $1.50 — less than the reward. Counting it
 * would reopen exactly the hole the volume bar closes.
 *
 * That exclusion is structural, not a list of game names. Coin Flip settles
 * through settleCoinFlip and every 5%-rake game settles through settleMatch, so
 * hooking trackWager into settleMatch alone excludes it by construction. A name
 * list would silently start counting Coin Flip the day a string changed.
 */

const MIN_DEPOSIT_USD  = 10;
const MIN_WAGERED_USD  = 100;
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
 * Nothing is credited here — the row is created 'pending' and only becomes
 * collectable after the hold, so a chargeback or a ban inside that window can
 * still cancel it.
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
 * Collect everything this referrer has matured but not yet taken.
 *
 * Claims each row by flipping pending->paid FIRST and credits only the rows it
 * actually flipped, so two taps of the button — or a retry on a dropped
 * response — cannot pay the same reward twice. Same ordering as the deposit
 * claim, for the same reason.
 *
 * Returns the number of coins credited.
 */
async function collectReferralEarnings(supabase, referrerId) {
  const { creditCoins } = require('./walletService');
  const { data: due } = await supabase
    .from('referral_rewards')
    .select('id, amount_c')
    .eq('referrer_id', referrerId)
    .eq('status', 'pending')
    .lte('mature_at', new Date().toISOString())
    .limit(200);
  if (!due?.length) return 0;

  let total = 0;
  for (const row of due) {
    const { data: claimed } = await supabase
      .from('referral_rewards')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id');
    if (!claimed?.length) continue;   // a concurrent request took it

    try {
      await creditCoins(supabase, referrerId, row.amount_c);
      total += parseFloat(row.amount_c) || 0;
    } catch (e) {
      // Roll the claim back so it stays collectable. Nothing credited, nothing lost.
      await supabase.from('referral_rewards')
        .update({ status: 'pending', paid_at: null })
        .eq('id', row.id).eq('status', 'paid')
        .then().catch(() => {});
      console.error('[referral] collect credit failed, rolled back:', e.message);
    }
  }

  if (total > 0) {
    await supabase.from('transactions').insert({
      user_id: referrerId, type: 'referral_bonus',
      amount_c: total, status: 'confirmed',
    }).then().catch(() => {});
  }
  return total;
}

/** Cancel a pending reward — used when a referred account is banned or refunded. */
async function clawback(supabase, referredId, reason = 'clawed_back') {
  await supabase.from('referral_rewards')
    .update({ status: reason })
    .eq('referred_id', referredId)
    .eq('status', 'pending')
    .then().catch(() => {});
}

/**
 * Rewards-page summary. Counts only — a referral appears here once it has
 * QUALIFIED, so there is nothing partial to show and no need to expose the
 * thresholds to the referrer.
 */
async function getReferralStats(supabase, userId) {
  const { data: rewards } = await supabase
    .from('referral_rewards')
    .select('status, amount_c, mature_at')
    .eq('referrer_id', userId);

  const rows = rewards || [];
  const now = Date.now();
  const sum = (list) => list.reduce((s, r) => s + (parseFloat(r.amount_c) || 0), 0);

  const pending    = rows.filter(r => r.status === 'pending');
  const collectable = pending.filter(r => new Date(r.mature_at).getTime() <= now);
  const holding     = pending.filter(r => new Date(r.mature_at).getTime() > now);

  return {
    qualified:   rows.filter(r => r.status !== 'clawed_back').length,
    collectable: sum(collectable),
    holding:     sum(holding),
    collected:   sum(rows.filter(r => r.status === 'paid')),
    rewardCoins: REWARD_COINS,
    holdDays:    HOLD_DAYS,
  };
}

module.exports = {
  trackWager, claimReferralReward, collectReferralEarnings, clawback, getReferralStats,
  MIN_DEPOSIT_USD, MIN_WAGERED_USD, REWARD_COINS, HOLD_DAYS,
};
