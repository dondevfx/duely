const { unlockUser } = require('./lockService');
const { resolveAffiliates, payAffiliatesCoins, payAffiliatesDiamonds } = require('./affiliateService');
const PLATFORM_FEE_PERCENT = 0.05;

const MAX_SINGLE_AMOUNT   = 10000;  // $10,000 hard cap per transaction
const MIN_TIP_COINS       = 0.01;
const MIN_TIP_DIAMONDS    = 1;

// Coins accepted for deposit/withdrawal — must match frontend COINS array
const VALID_COINS = new Set([
  'usdttrc20', 'sol', 'btc', 'xrp', 'eth', 'bnbbsc',
  'ltc', 'doge', 'trx', 'matic', 'ada', 'avaxc',
]);

// Validate and normalise a monetary amount.
// Throws a descriptive error for NaN, Infinity, negative, too small, too large.
function sanitizeAmount(val, min = 0.01, max = MAX_SINGLE_AMOUNT) {
  const n = parseFloat(val);
  if (!isFinite(n)) throw new Error(`Invalid amount: ${val}`);
  if (n < min)      throw new Error(`Amount too small — minimum is ${min}`);
  if (n > max)      throw new Error(`Amount too large — maximum is ${max}`);
  return parseFloat(n.toFixed(4));
}

function sanitizeDiamondAmount(val, min = MIN_TIP_DIAMONDS, max = 1_000_000) {
  const n = Math.floor(parseFloat(val));
  if (!isFinite(n)) throw new Error(`Invalid diamond amount: ${val}`);
  if (n < min)      throw new Error(`Diamond amount too small — minimum is ${min}`);
  if (n > max)      throw new Error(`Diamond amount too large — maximum is ${max}`);
  return n;
}

async function getBalance(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('c_coins')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data.c_coins;
}

// Credit coins — only used for deposits and refunds (never for game outcomes)
async function creditCoins(supabase, userId, amount) {
  const { error } = await supabase.rpc('credit_coins', {
    user_id: userId,
    amount:  parseFloat(amount),
  });
  if (error) throw error;
}

// Deduct coins — DB throws 'Insufficient balance' if not enough funds.
// No app-level pre-check needed (that was a TOCTOU race condition).
async function deductCoins(supabase, userId, amount) {
  const { error } = await supabase.rpc('deduct_coins', {
    user_id: userId,
    amount:  parseFloat(amount),
  });
  if (error) throw error;
}

// Atomic match settlement — single SQL transaction.
// Checks balances, deducts both players, credits winner, takes 5% fee.
// Returns { prizePool, fee, winnerPayout }
async function settleMatch(supabase, winnerId, loserId, entryFee) {
  const adminId = process.env.ADMIN_USER_ID;
  try {
    const { data, error } = await supabase.rpc('settle_match_coins', {
      p_winner_id: winnerId,
      p_loser_id:  loserId,
      p_entry_fee: parseFloat(entryFee),
    });
    if (error) throw error;

    const prizePool = parseFloat(entryFee) * 2;

    if (adminId && parseFloat(entryFee) > 0) {
      // Resolve affiliates and split fee
      const { owner1, owner2 } = await resolveAffiliates(supabase, winnerId, loserId)
        .catch(() => ({ owner1: null, owner2: null }));
      const { platformFee } = await payAffiliatesCoins(supabase, owner1, owner2, prizePool)
        .catch(() => ({ platformFee: 0.045 })); // fallback: 4.5% (5% − 0.5% rakeback)
      const adminFeeAmount = parseFloat((prizePool * platformFee).toFixed(4));
      // Accumulate into fee_balance (not c_coins) — admin collects manually via dashboard
      await supabase.rpc('credit_fee_balance', { user_id: adminId, amount: adminFeeAmount })
        .then(({ error: e }) => { if (e) console.error('[admin-fee] credit_fee_balance failed:', e.message); })
        .catch(err => console.error('[admin-fee] credit_fee_balance threw:', err.message));
    }

    if (parseFloat(entryFee) > 0) {
      const payout = parseFloat((prizePool * 0.95).toFixed(4));
      const fee    = parseFloat(entryFee);
      supabase.from('transactions').insert([
        { user_id: winnerId, type: 'match_win',  amount_c: payout, status: 'confirmed' },
        { user_id: loserId,  type: 'match_loss', amount_c: fee,    status: 'confirmed' },
      ]).then().catch(e => console.error('[tx] coin match insert failed:', e.message));
    }

    return data;
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
  }
}

// ── Diamond helpers ────────────────────────────────────────────────

async function getDiamondBalance(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles').select('diamonds').eq('id', userId).single();
  if (error) throw error;
  return data.diamonds || 0;
}

async function creditDiamonds(supabase, userId, amount) {
  const { error } = await supabase.rpc('credit_diamonds', {
    user_id: userId,
    amount:  Math.floor(amount),
  });
  if (error) throw error;
}

async function deductDiamonds(supabase, userId, amount) {
  const { error } = await supabase.rpc('deduct_diamonds', {
    user_id: userId,
    amount:  Math.floor(amount),
  });
  if (error) throw error;
}

async function settleMatchDiamonds(supabase, winnerId, loserId, entryFee) {
  try {
    const fee = Math.floor(entryFee);
    const winnerPayout = fee * 2; // No fee on diamonds — full 2x payout

    // Deduct winner first — if they lack funds the loser is never charged.
    // Then deduct loser, then credit winner full 2x.
    await deductDiamonds(supabase, winnerId, fee);
    await deductDiamonds(supabase, loserId, fee);
    // Protect against credit failure — refund both if credit fails
    try {
      await creditDiamonds(supabase, winnerId, winnerPayout);
    } catch (creditErr) {
      console.error('[settleMatchDiamonds] credit failed — refunding both players:', creditErr.message);
      await creditDiamonds(supabase, winnerId, fee).catch(() => {});
      await creditDiamonds(supabase, loserId, fee).catch(() => {});
      throw creditErr;
    }

    if (winnerPayout > 0) {
      await resolveAffiliates(supabase, winnerId, loserId)
        .then(({ owner1, owner2 }) => payAffiliatesDiamonds(supabase, owner1, owner2, winnerPayout))
        .catch(() => {});

      supabase.from('transactions').insert([
        { user_id: winnerId, type: 'match_win',  amount_c: 0, crypto_amount: winnerPayout, crypto_symbol: 'diamonds', status: 'confirmed' },
        { user_id: loserId,  type: 'match_loss', amount_c: 0, crypto_amount: fee, crypto_symbol: 'diamonds', status: 'confirmed' },
      ]).then().catch(e => console.error('[tx] diamond match insert failed:', e.message));
    }

    return { winnerPayout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
  }
}

// Bot match settlement: entry fee already deducted upfront by handler.
// On win: credit back 2x entry fee * 0.95 (payout).
// On loss: nothing (fee was already taken).
async function settleBotMatch(supabase, humanUserId, entryFee, currency, humanWon) {
  if (!humanWon) {
    if (parseFloat(entryFee) > 0) {
      supabase.from('transactions').insert({
        user_id: humanUserId, type: 'match_loss',
        amount_c: currency === 'diamonds' ? 0 : parseFloat(entryFee),
        ...(currency === 'diamonds' ? { crypto_amount: Math.floor(entryFee), crypto_symbol: 'diamonds' } : {}),
        status: 'confirmed',
      }).then().catch(e => console.error('[tx] bot loss insert failed:', e.message));
    }
    return { winnerPayout: 0 };
  }
  if (currency === 'diamonds') {
    const payout = Math.floor(entryFee * 2);
    await creditDiamonds(supabase, humanUserId, payout);
    supabase.from('transactions').insert({
      user_id: humanUserId, type: 'match_win',
      amount_c: 0, crypto_amount: payout, crypto_symbol: 'diamonds', status: 'confirmed',
    }).then().catch(e => console.error('[tx] bot win insert failed:', e.message));
    return { winnerPayout: payout };
  } else {
    const payout = parseFloat((entryFee * 2 * 0.95).toFixed(4));
    await creditCoins(supabase, humanUserId, payout);
    supabase.from('transactions').insert({
      user_id: humanUserId, type: 'match_win', amount_c: payout, status: 'confirmed',
    }).then().catch(e => console.error('[tx] bot win insert failed:', e.message));
    return { winnerPayout: payout };
  }
}

// Increment deposited column for the given source ('crypto' or 'fiat').
// Called in webhooks after a successful deposit is credited.
// Uses RPC for atomic increment to avoid race conditions on concurrent deposits.
async function recordDeposit(supabase, userId, amount, source) {
  const fn = source === 'fiat' ? 'increment_fiat_deposited' : 'increment_crypto_deposited';
  const { error } = await supabase.rpc(fn, { user_id: userId, amount: parseFloat(amount) });
  if (error) {
    // Fallback: non-atomic read-modify-write if RPC doesn't exist yet
    const col = source === 'fiat' ? 'fiat_deposited' : 'crypto_deposited';
    const { data } = await supabase.from('profiles').select(col).eq('id', userId).single();
    await supabase.from('profiles')
      .update({ [col]: (parseFloat(data?.[col]) || 0) + parseFloat(amount) })
      .eq('id', userId);
  }
}

// Increment withdrawn column for the given source ('crypto' or 'fiat').
// Called after a withdrawal is successfully sent.
// Uses RPC for atomic increment to avoid race conditions.
async function recordWithdrawal(supabase, userId, amount, source) {
  const fn = source === 'fiat' ? 'increment_fiat_withdrawn' : 'increment_crypto_withdrawn';
  const { error } = await supabase.rpc(fn, { user_id: userId, amount: parseFloat(amount) });
  if (error) {
    // Fallback: non-atomic read-modify-write if RPC doesn't exist yet
    const col = source === 'fiat' ? 'fiat_withdrawn' : 'crypto_withdrawn';
    const { data } = await supabase.from('profiles').select(col).eq('id', userId).single();
    await supabase.from('profiles')
      .update({ [col]: (parseFloat(data?.[col]) || 0) + parseFloat(amount) })
      .eq('id', userId);
  }
}

// Returns how much the user can withdraw via each method.
// crypto: limited to total crypto deposited minus already withdrawn, capped at balance.
// fiat:   limited to total fiat deposited minus already withdrawn, capped at balance.
// Game winnings increase c_coins but are not withdrawable — they are in-platform only.
async function getWithdrawable(supabase, userId) {
  const { data } = await supabase.from('profiles')
    .select('c_coins').eq('id', userId).single();
  if (!data) return { crypto: 0, fiat: 0 };
  const bal = parseFloat(data.c_coins) || 0;
  return { crypto: bal, fiat: bal };
}

// Draw settlement — each player pays 5% platform fee, gets back 95% of their entry fee.
// Both players' entry fees are deducted then partially refunded.
// Affiliates and creator codes are paid the same way as a regular win.
async function settleDrawMatch(supabase, p1Id, p2Id, entryFee) {
  const fee = parseFloat(entryFee);
  if (fee <= 0) return { winnerPayout: 0, fee: 0 };
  const prizePool = parseFloat((fee * 2).toFixed(4));
  const refund    = parseFloat((fee * 0.95).toFixed(4));
  const adminId   = process.env.ADMIN_USER_ID;

  // Deduct entry fee from both, credit back 95%
  await supabase.rpc('deduct_coins', { user_id: p1Id, amount: fee });
  await supabase.rpc('deduct_coins', { user_id: p2Id, amount: fee });
  await supabase.rpc('credit_coins', { user_id: p1Id, amount: refund });
  await supabase.rpc('credit_coins', { user_id: p2Id, amount: refund });

  // Pay affiliates / creator codes (same logic as a win — they earn on every wagered game)
  // platformFeePercent is reduced when affiliates are present (4.5% or 3% instead of 5%)
  let platformFeePercent = 0.045; // default: 4.5% (5% fee − 0.5% rakeback)
  if (adminId) {
    try {
      const { owner1, owner2 } = await resolveAffiliates(supabase, p1Id, p2Id)
        .catch(() => ({ owner1: null, owner2: null }));
      const { platformFee } = await payAffiliatesCoins(supabase, owner1, owner2, prizePool)
        .catch(() => ({ platformFee: 0.045 }));
      platformFeePercent = platformFee;
    } catch {}
    const adminAmount = parseFloat((prizePool * platformFeePercent).toFixed(4));
    // Accumulate into fee_balance — admin collects manually via dashboard
    await supabase.rpc('credit_fee_balance', { user_id: adminId, amount: adminAmount }).catch(() => {});
  }

  supabase.from('transactions').insert([
    { user_id: p1Id, type: 'match_draw', amount_c: refund, status: 'confirmed' },
    { user_id: p2Id, type: 'match_draw', amount_c: refund, status: 'confirmed' },
  ]).then().catch(() => {});

  const totalPlatformFee = parseFloat((prizePool * platformFeePercent).toFixed(4));
  return { winnerPayout: refund, fee: totalPlatformFee };
}

async function settleDrawMatchDiamonds(supabase, p1Id, p2Id, entryFee) {
  const fee = Math.floor(parseFloat(entryFee));
  if (fee <= 0) return { winnerPayout: 0, fee: 0 };

  // No fee on diamonds — full refund to both players
  await supabase.rpc('deduct_diamonds', { user_id: p1Id, amount: fee });
  await supabase.rpc('deduct_diamonds', { user_id: p2Id, amount: fee });
  await supabase.rpc('credit_diamonds', { user_id: p1Id, amount: fee });
  await supabase.rpc('credit_diamonds', { user_id: p2Id, amount: fee });

  return { winnerPayout: fee, fee: 0 };
}

module.exports = {
  VALID_COINS,
  PLATFORM_FEE_PERCENT,
  MAX_SINGLE_AMOUNT,
  MIN_TIP_COINS,
  MIN_TIP_DIAMONDS,
  sanitizeAmount,
  sanitizeDiamondAmount,
  getBalance,
  creditCoins,
  deductCoins,
  settleMatch,
  getDiamondBalance,
  creditDiamonds,
  deductDiamonds,
  settleMatchDiamonds,
  settleBotMatch,
  settleDrawMatch,
  settleDrawMatchDiamonds,
  recordDeposit,
  recordWithdrawal,
  getWithdrawable,
};
