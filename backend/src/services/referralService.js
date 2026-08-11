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
  const { notifyBalance } = require('./walletService');
  const adminId = process.env.ADMIN_USER_ID;
  // Without an admin id there is no bank to pay from. Refusing here keeps the
  // rewards collectable rather than failing per-row and churning their status.
  if (!adminId) {
    console.error('[referral] ADMIN_USER_ID not set — cannot pay from the fee balance');
    return 0;
  }

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

    // Paid OUT OF the fee balance, never minted. creditCoins() would create new
    // coins with no deposit backing them, so withdrawable balances would grow
    // past the USDC actually held — the bonus would slowly drain the bank. This
    // moves coins that rake already collected, leaving total supply unchanged.
    const rollback = async (why) => {
      await supabase.from('referral_rewards')
        .update({ status: 'pending', paid_at: null })
        .eq('id', row.id).eq('status', 'paid')
        .then().catch(() => {});
      console.error(`[referral] collect rolled back (${why})`);
    };

    try {
      const { data: ok, error } = await supabase.rpc('pay_referral_from_bank', {
        admin_id: adminId, referrer_id: referrerId, amount: row.amount_c,
      });
      if (error) { await rollback(error.message); continue; }
      if (ok === false) {
        // Bank is short. Leave the reward collectable rather than overdrawing —
        // it is owed either way, and paying from an empty bank is what the
        // whole arrangement exists to prevent.
        await rollback('platform fee balance too low');
        continue;
      }
      total += parseFloat(row.amount_c) || 0;
    } catch (e) {
      await rollback(e.message);
    }
  }

  if (total > 0) {
    notifyBalance(referrerId);
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
/**
 * The referrer's own code, issuing one if they have never set it.
 *
 * affiliate_code is nullable and was only ever set by choosing one manually, so
 * most accounts have none — and an invite link without a code refers nobody.
 * The whole feature silently did nothing for those users, which is the worst
 * kind of broken: no error, just no attribution.
 *
 * Codes are [A-Z0-9]{4,12} and UNIQUE, so a collision is possible; retry a few
 * times and give up rather than looping. Returns null on failure, and the card
 * falls back to a plain link.
 */
async function ensureReferralCode(supabase, userId) {
  const { data: profile } = await supabase
    .from('profiles').select('affiliate_code').eq('id', userId).single();
  if (profile?.affiliate_code) return profile.affiliate_code;

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 — these get read aloud
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const { error } = await supabase
      .from('profiles').update({ affiliate_code: code }).eq('id', userId);
    if (!error) return code;
    if (error.code !== '23505') break;   // not a collision — stop retrying
  }
  console.error(`[referral] could not issue a code for ${userId}`);
  return null;
}

async function getReferralStats(supabase, userId) {
  const code = await ensureReferralCode(supabase, userId).catch(() => null);
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
    code,
    qualified:   rows.filter(r => r.status !== 'clawed_back').length,
    collectable: sum(collectable),
    holding:     sum(holding),
    collected:   sum(rows.filter(r => r.status === 'paid')),
    rewardCoins: REWARD_COINS,
    holdDays:    HOLD_DAYS,
  };
}

module.exports = {
  trackWager, claimReferralReward, collectReferralEarnings, clawback,
  getReferralStats, ensureReferralCode,
  MIN_DEPOSIT_USD, MIN_WAGERED_USD, REWARD_COINS, HOLD_DAYS,
};
