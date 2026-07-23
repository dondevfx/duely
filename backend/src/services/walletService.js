const { unlockUser } = require('./lockService');
const { resolveAffiliates, payAffiliatesCoins, payCodesCoinFlip, payAffiliatesDiamonds } = require('./affiliateService');
const { creditRakeback } = require('./rakebackService');
const { isDemo } = require('./demoAccounts');
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

// Deduct match entry fee from both players at match start, BEFORE notifying clients.
// Fees are taken atomically: if p2 deduction fails, p1 is refunded and an error is thrown.
// Callers must handle the error: delete room, unlock both, emit match_cancelled.
async function deductMatchFees(supabase, p1Id, p2Id, entryFee, currency) {
  const isDiamonds = currency === 'diamonds';
  const fee = isDiamonds ? Math.floor(entryFee) : parseFloat(entryFee);
  if (!fee || fee <= 0) return;
  if (isDiamonds) {
    await deductDiamonds(supabase, p1Id, fee);
    try {
      await deductDiamonds(supabase, p2Id, fee);
    } catch (e) {
      await creditDiamonds(supabase, p1Id, fee).catch(() => {});
      throw e;
    }
  } else {
    const { error: e1 } = await supabase.rpc('deduct_coins', { user_id: p1Id, amount: fee });
    if (e1) throw new Error(e1.message || 'Insufficient balance');
    const { error: e2 } = await supabase.rpc('deduct_coins', { user_id: p2Id, amount: fee });
    if (e2) {
      await supabase.rpc('credit_coins', { user_id: p1Id, amount: fee }).then().catch(() => {});
      throw new Error(e2.message || 'Opponent has insufficient balance');
    }
  }
}

// Builds the "notes" shown on a match transaction, e.g. "Coin Flip vs Alice".
// meta = { game, winnerUsername, loserUsername }. Returns null when no game given
// (older callers) so the column simply stays empty.
function matchNote(game, opponent) {
  if (!game) return null;
  return opponent ? `${game} vs ${opponent}` : game;
}

// Coin match settlement — fees already deducted at match start, just credit winner 95% of pot.
// Returns { winnerPayout }
async function settleMatch(supabase, winnerId, loserId, entryFee, meta = {}) {
  const adminId = process.env.ADMIN_USER_ID;
  try {
    const fee = parseFloat(entryFee);
    if (fee <= 0) return { winnerPayout: 0 };
    const prizePool = parseFloat((fee * 2).toFixed(4));
    const payout    = parseFloat((prizePool * 0.95).toFixed(4));

    // Fees already deducted at match start — just credit winner
    const { error: creditErr } = await supabase.rpc('credit_coins', { user_id: winnerId, amount: payout });
    if (creditErr) throw creditErr;

    if (adminId && !isDemo(winnerId) && !isDemo(loserId)) {
      const { owner1, owner2 } = await resolveAffiliates(supabase, winnerId, loserId)
        .catch(() => ({ owner1: null, owner2: null }));
      const { platformFee } = await payAffiliatesCoins(supabase, owner1, owner2, prizePool)
        .catch(() => ({ platformFee: 0.045 }));
      const adminFeeAmount = parseFloat((prizePool * platformFee).toFixed(4));
      await supabase.rpc('credit_fee_balance', { user_id: adminId, amount: adminFeeAmount })
        .then(({ error: e }) => { if (e) console.error('[admin-fee] credit_fee_balance failed:', e.message); })
        .catch(err => console.error('[admin-fee] credit_fee_balance threw:', err.message));
    }

    await creditRakeback(supabase, winnerId, loserId, prizePool, 'coins').catch(() => {});

    supabase.from('transactions').insert([
      { user_id: winnerId, type: 'match_win',  amount_c: payout, status: 'confirmed', notes: matchNote(meta.game, meta.loserUsername) },
      { user_id: loserId,  type: 'match_loss', amount_c: fee,    status: 'confirmed', notes: matchNote(meta.game, meta.winnerUsername) },
    ]).then().catch(e => console.error('[tx] coin match insert failed:', e.message));

    return { winnerPayout: payout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
  }
}

// Coin Flip settlement — 2% total rake (winner gets 98% of the pot), split:
// rakeback 0.4% + code 0.1% (capped, any code type) + admin 1.5% (1.6% when no
// code). Winner payout is a flat 98% regardless of referrals. Used for both a
// normal resolve and a forfeit (both are winner-takes-pot).
async function settleCoinFlip(supabase, winnerId, loserId, entryFee, meta = {}) {
  const adminId = process.env.ADMIN_USER_ID;
  try {
    const fee = parseFloat(entryFee);
    if (fee <= 0) return { winnerPayout: 0 };
    const prizePool = parseFloat((fee * 2).toFixed(4));
    const payout    = parseFloat((prizePool * 0.98).toFixed(4)); // 2% rake

    const { error: creditErr } = await supabase.rpc('credit_coins', { user_id: winnerId, amount: payout });
    if (creditErr) throw creditErr;

    if (adminId && !isDemo(winnerId) && !isDemo(loserId)) {
      const { owner1, owner2 } = await resolveAffiliates(supabase, winnerId, loserId)
        .catch(() => ({ owner1: null, owner2: null }));
      const { platformFee } = await payCodesCoinFlip(supabase, owner1, owner2, prizePool)
        .catch(() => ({ platformFee: 0.016 }));
      const adminFeeAmount = parseFloat((prizePool * platformFee).toFixed(4));
      await supabase.rpc('credit_fee_balance', { user_id: adminId, amount: adminFeeAmount })
        .then(({ error: e }) => { if (e) console.error('[admin-fee] CF credit_fee_balance failed:', e.message); })
        .catch(err => console.error('[admin-fee] CF credit_fee_balance threw:', err.message));
    }

    // Rakeback — 0.4% of pool (0.2% per player)
    await creditRakeback(supabase, winnerId, loserId, prizePool, 'coins', 0.002).catch(() => {});

    supabase.from('transactions').insert([
      { user_id: winnerId, type: 'match_win',  amount_c: payout, status: 'confirmed', notes: matchNote(meta.game, meta.loserUsername) },
      { user_id: loserId,  type: 'match_loss', amount_c: fee,    status: 'confirmed', notes: matchNote(meta.game, meta.winnerUsername) },
    ]).then().catch(e => console.error('[tx] coin flip match insert failed:', e.message));

    return { winnerPayout: payout };
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

// Diamond match settlement — fees already deducted at match start, just credit winner 2x.
async function settleMatchDiamonds(supabase, winnerId, loserId, entryFee, meta = {}) {
  try {
    const fee = Math.floor(entryFee);
    if (fee <= 0) return { winnerPayout: 0 };
    const winnerPayout = fee * 2;

    // Fees already deducted at match start — just credit winner
    await creditDiamonds(supabase, winnerId, winnerPayout);

    if (!isDemo(winnerId) && !isDemo(loserId)) {
      await resolveAffiliates(supabase, winnerId, loserId)
        .then(({ owner1, owner2 }) => payAffiliatesDiamonds(supabase, owner1, owner2, winnerPayout))
        .catch(() => {});
    }

    supabase.from('transactions').insert([
      { user_id: winnerId, type: 'match_win',  amount_c: 0, crypto_amount: winnerPayout, crypto_symbol: 'diamonds', status: 'confirmed', notes: matchNote(meta.game, meta.loserUsername) },
      { user_id: loserId,  type: 'match_loss', amount_c: 0, crypto_amount: fee, crypto_symbol: 'diamonds', status: 'confirmed', notes: matchNote(meta.game, meta.winnerUsername) },
    ]).then().catch(e => console.error('[tx] diamond match insert failed:', e.message));

    return { winnerPayout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
  }
}

// Bot match settlement: entry fee already deducted upfront by handler.
// On win: credit back 2x entry fee * 0.95 (payout).
// On loss: nothing (fee was already taken).
async function settleBotMatch(supabase, humanUserId, entryFee, currency, humanWon, meta = {}) {
  const note = matchNote(meta.game, 'Bot');
  if (!humanWon) {
    if (parseFloat(entryFee) > 0) {
      supabase.from('transactions').insert({
        user_id: humanUserId, type: 'match_loss',
        amount_c: currency === 'diamonds' ? 0 : parseFloat(entryFee),
        ...(currency === 'diamonds' ? { crypto_amount: Math.floor(entryFee), crypto_symbol: 'diamonds' } : {}),
        status: 'confirmed', notes: note,
      }).then().catch(e => console.error('[tx] bot loss insert failed:', e.message));
    }
    return { winnerPayout: 0 };
  }
  if (currency === 'diamonds') {
    const payout = Math.floor(entryFee * 2);
    await creditDiamonds(supabase, humanUserId, payout);
    supabase.from('transactions').insert({
      user_id: humanUserId, type: 'match_win',
      amount_c: 0, crypto_amount: payout, crypto_symbol: 'diamonds', status: 'confirmed', notes: note,
    }).then().catch(e => console.error('[tx] bot win insert failed:', e.message));
    return { winnerPayout: payout };
  } else {
    const payout = parseFloat((entryFee * 2 * 0.95).toFixed(4));
    await creditCoins(supabase, humanUserId, payout);
    supabase.from('transactions').insert({
      user_id: humanUserId, type: 'match_win', amount_c: payout, status: 'confirmed', notes: note,
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

// Returns how much the user can withdraw.
//
// The entire c_coins balance is withdrawable — including game winnings and
// affiliate earnings — because there is no free coin faucet (new accounts start
// at 0, PvP is zero-sum minus rake, bot coin games are free-entry only, and the
// only bonus that mints coins is the 1/day daily bonus). Every coin therefore
// traces back to a real deposit, real rake, or a zero-sum transfer, so gating by
// funding source would only serve to trap users' legitimate winnings.
//
// NOTE: profiles.crypto_deposited / crypto_withdrawn (and fiat_*) are still
// tracked (see recordDeposit/recordWithdrawal) and remain available if strict
// source-of-funds / AML gating is ever required — wire them in here to cap each
// method to (deposited − withdrawn). Not enforced today by design.
async function getWithdrawable(supabase, userId) {
  const { data } = await supabase.from('profiles')
    .select('c_coins').eq('id', userId).single();
  if (!data) return { crypto: 0, fiat: 0 };
  const bal = parseFloat(data.c_coins) || 0;
  return { crypto: bal, fiat: bal };
}

// Forfeit settlement for diamonds — fees already deducted at match start, just credit winner 2x.
async function forfeitSettleDiamonds(supabase, winnerId, loserId, entryFee) {
  try {
    const fee = Math.floor(entryFee);
    if (fee <= 0) return { winnerPayout: 0 };
    const winnerPayout = fee * 2;

    // Fees already deducted at match start — just credit winner
    const { error: creditErr } = await supabase.rpc('credit_diamonds', { user_id: winnerId, amount: winnerPayout });
    if (creditErr) throw creditErr;

    supabase.from('transactions').insert([
      { user_id: winnerId, type: 'match_win',  amount_c: 0, crypto_amount: winnerPayout, crypto_symbol: 'diamonds', status: 'confirmed' },
      { user_id: loserId,  type: 'match_loss', amount_c: 0, crypto_amount: fee,          crypto_symbol: 'diamonds', status: 'confirmed' },
    ]).then().catch(e => console.error('[tx] forfeit diamond insert failed:', e.message));

    return { winnerPayout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
  }
}

// Forfeit settlement for coins — fees already deducted at match start, just credit winner 95% of pot.
async function forfeitSettleCoins(supabase, winnerId, loserId, entryFee, adminId) {
  try {
    const fee = parseFloat(entryFee);
    if (fee <= 0) return { winnerPayout: 0 };
    const prizePool    = parseFloat((fee * 2).toFixed(4));
    const winnerPayout = parseFloat((prizePool * 0.95).toFixed(4));

    // Fees already deducted at match start — just credit winner
    const { error: creditErr } = await supabase.rpc('credit_coins', { user_id: winnerId, amount: winnerPayout });
    if (creditErr) throw creditErr;

    if (adminId && !isDemo(winnerId) && !isDemo(loserId)) {
      const { owner1, owner2 } = await resolveAffiliates(supabase, winnerId, loserId)
        .catch(() => ({ owner1: null, owner2: null }));
      const { platformFee } = await payAffiliatesCoins(supabase, owner1, owner2, prizePool)
        .catch(() => ({ platformFee: 0.045 }));
      const adminFeeAmount = parseFloat((prizePool * platformFee).toFixed(4));
      await supabase.rpc('credit_fee_balance', { user_id: adminId, amount: adminFeeAmount })
        .catch(err => console.error('[forfeit-fee] credit_fee_balance failed:', err.message));
    }

    supabase.from('transactions').insert([
      { user_id: winnerId, type: 'match_win',  amount_c: winnerPayout, status: 'confirmed' },
      { user_id: loserId,  type: 'match_loss', amount_c: fee,          status: 'confirmed' },
    ]).then().catch(e => console.error('[tx] forfeit coins insert failed:', e.message));

    return { winnerPayout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
  }
}

// Draw settlement (coins) — fees already deducted at match start; credit back 95% to both.
async function settleDrawMatch(supabase, p1Id, p2Id, entryFee) {
  const fee = parseFloat(entryFee);
  if (fee <= 0) return { winnerPayout: 0, fee: 0 };
  const prizePool = parseFloat((fee * 2).toFixed(4));
  const refund    = parseFloat((fee * 0.95).toFixed(4));
  const adminId   = process.env.ADMIN_USER_ID;

  // Fees already deducted at match start — credit back 95% to both
  await supabase.rpc('credit_coins', { user_id: p1Id, amount: refund });
  await supabase.rpc('credit_coins', { user_id: p2Id, amount: refund });

  // Rakeback — 0.5% of prize pool split across instant/daily/weekly buckets
  await creditRakeback(supabase, p1Id, p2Id, prizePool, 'coins').catch(() => {});

  // Pay affiliates / creator codes + admin fee (same as a normal match)
  let platformFeePercent = 0.045; // default: 4.5% (5% − 0.5% rakeback)
  if (adminId && !isDemo(p1Id) && !isDemo(p2Id)) {
    try {
      const { owner1, owner2 } = await resolveAffiliates(supabase, p1Id, p2Id)
        .catch(() => ({ owner1: null, owner2: null }));
      const { platformFee } = await payAffiliatesCoins(supabase, owner1, owner2, prizePool)
        .catch(() => ({ platformFee: 0.045 }));
      platformFeePercent = platformFee;
    } catch {}
    const adminAmount = parseFloat((prizePool * platformFeePercent).toFixed(4));
    await supabase.rpc('credit_fee_balance', { user_id: adminId, amount: adminAmount }).then().catch(() => {});
  }

  supabase.from('transactions').insert([
    { user_id: p1Id, type: 'match_draw', amount_c: refund, status: 'confirmed' },
    { user_id: p2Id, type: 'match_draw', amount_c: refund, status: 'confirmed' },
  ]).then().catch(() => {});

  const totalPlatformFee = parseFloat((prizePool * platformFeePercent).toFixed(4));
  unlockUser(p1Id);
  unlockUser(p2Id);
  return { winnerPayout: refund, fee: totalPlatformFee };
}

// Draw settlement (diamonds) — fees already deducted at match start; full refund to both.
async function settleDrawMatchDiamonds(supabase, p1Id, p2Id, entryFee) {
  const fee = Math.floor(parseFloat(entryFee));
  if (fee <= 0) return { winnerPayout: 0, fee: 0 };

  // Fees already deducted at match start — credit back full fee to both
  await supabase.rpc('credit_diamonds', { user_id: p1Id, amount: fee });
  await supabase.rpc('credit_diamonds', { user_id: p2Id, amount: fee });

  supabase.from('transactions').insert([
    { user_id: p1Id, type: 'match_draw', amount_c: 0, crypto_amount: fee, crypto_symbol: 'diamonds', status: 'confirmed' },
    { user_id: p2Id, type: 'match_draw', amount_c: 0, crypto_amount: fee, crypto_symbol: 'diamonds', status: 'confirmed' },
  ]).then().catch(() => {});

  unlockUser(p1Id);
  unlockUser(p2Id);
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
  deductMatchFees,
  settleMatch,
  settleCoinFlip,
  getDiamondBalance,
  creditDiamonds,
  deductDiamonds,
  settleMatchDiamonds,
  forfeitSettleDiamonds,
  forfeitSettleCoins,
  settleBotMatch,
  settleDrawMatch,
  settleDrawMatchDiamonds,
  recordDeposit,
  recordWithdrawal,
  getWithdrawable,
};
