const { unlockUser } = require('./lockService');
const { resolveAffiliates, payAffiliatesCoins, payCodesCoinFlip, payAffiliatesDiamonds } = require('./affiliateService');
const { creditRakeback } = require('./rakebackService');
const { isDemo } = require('./demoAccounts');
const gameEvents = require('./gameEvents');
const { openEscrow, closeEscrow } = require('./escrowService');
const PLATFORM_FEE_PERCENT = 0.05;

// Tell the client its balance moved so the UI updates live without a refresh.
// Bridged to the user's socket(s) in socket/handlers.js.
function notifyBalance(...userIds) {
  for (const userId of userIds) {
    if (userId) gameEvents.emit('balance_changed', { userId });
  }
}

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
  notifyBalance(userId);
}

// ── Transaction insert with a stake recorded ─────────────────────────────────
//
// amount_c on a match_win is the GROSS payout — it hands back the player's own
// stake as well as their winnings. Anything summing those rows therefore counts
// the stake as profit, which is why the profile P&L showed every account up:
// a 50/50 player banked +1.9x per win against -1x per loss.
//
// The stake is not otherwise recoverable: entry fees are taken with deduct_coins
// and write no row at all. So the credit-side rows carry it, and net profit is
// amount_c - stake_c.
//
// Retries without the column if the migration has not been run, because
// RECORDING MONEY must never depend on a migration. P&L is approximate until it
// is; the ledger is correct either way.
async function insertTx(supabase, rows) {
  const { error } = await supabase.from('transactions').insert(rows);
  if (!error) return;
  if (/stake_c/i.test(error.message || '')) {
    const stripped = (Array.isArray(rows) ? rows : [rows]).map(({ stake_c, ...r }) => r);
    const retry = await supabase.from('transactions').insert(stripped);
    if (retry.error) console.error('[tx] insert failed:', retry.error.message);
    else console.warn('[tx] transactions.stake_c missing — run PENDING_SQL; P&L stays approximate until then');
    return;
  }
  console.error('[tx] insert failed:', error.message);
}

// Deduct coins — DB throws 'Insufficient balance' if not enough funds.
// No app-level pre-check needed (that was a TOCTOU race condition).
async function deductCoins(supabase, userId, amount) {
  const { error } = await supabase.rpc('deduct_coins', {
    user_id: userId,
    amount:  parseFloat(amount),
  });
  if (error) throw error;
  notifyBalance(userId);
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
      // Tell p1's client the money came back. The clients deduct the entry fee
      // optimistically the moment a match is found, so without this push their
      // balance reads low for a fee that was never actually taken — until some
      // unrelated event happens to refresh it. The diamonds path above already
      // notifies because it goes through creditDiamonds; this one calls the RPC
      // directly and was silently skipping it.
      notifyBalance(p1Id);
      throw new Error(e2.message || 'Opponent has insufficient balance');
    }
  }
  notifyBalance(p1Id, p2Id);
  // Crash safety: record that both players have paid in. Cleared on settle;
  // refunded on boot if the process died mid-match. Never blocks the match.
  openEscrow(supabase, p1Id, p2Id, fee, currency).catch(() => {});
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

    // Referral progress. Deliberately hooked here and NOT in settleCoinFlip:
    // this is the 5%-rake path, and Coin Flip's 2% does not generate enough to
    // fund the reward. Both players' stakes count — each paid the entry fee.
    if (!isDemo(winnerId) && !isDemo(loserId)) {
      const { trackWager } = require('./referralService');
      trackWager(supabase, winnerId, fee).catch(() => {});
      trackWager(supabase, loserId,  fee).catch(() => {});
    }

    insertTx(supabase, [
      { user_id: winnerId, type: 'match_win',  amount_c: payout, stake_c: fee, status: 'confirmed', notes: matchNote(meta.game, meta.loserUsername) },
      { user_id: loserId,  type: 'match_loss', amount_c: fee,    status: 'confirmed', notes: matchNote(meta.game, meta.winnerUsername) },
    ])

    return { winnerPayout: payout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
    notifyBalance(winnerId, loserId);
    closeEscrow(supabase, winnerId, loserId).catch(() => {});
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

    insertTx(supabase, [
      { user_id: winnerId, type: 'match_win',  amount_c: payout, stake_c: fee, status: 'confirmed', notes: matchNote(meta.game, meta.loserUsername) },
      { user_id: loserId,  type: 'match_loss', amount_c: fee,    status: 'confirmed', notes: matchNote(meta.game, meta.winnerUsername) },
    ])

    return { winnerPayout: payout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
    notifyBalance(winnerId, loserId);
    closeEscrow(supabase, winnerId, loserId).catch(() => {});
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
  notifyBalance(userId);
}

async function deductDiamonds(supabase, userId, amount) {
  const { error } = await supabase.rpc('deduct_diamonds', {
    user_id: userId,
    amount:  Math.floor(amount),
  });
  if (error) throw error;
  notifyBalance(userId);
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
    notifyBalance(winnerId, loserId);
    closeEscrow(supabase, winnerId, loserId).catch(() => {});
  }
}

// Bot match settlement: entry fee already deducted upfront by handler.
// On win: credit back 2x entry fee * 0.95 (payout).
// On loss: nothing (fee was already taken).
// coinPayoutMult: 0.95 default (5% house edge). Coin flip passes 0.98 (2%) so a
// bot flip pays the same as a PvP flip for every account type.
async function settleBotMatch(supabase, humanUserId, entryFee, currency, humanWon, meta = {}, coinPayoutMult = 0.95) {
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
    const payout = parseFloat((entryFee * 2 * coinPayoutMult).toFixed(4));
    await creditCoins(supabase, humanUserId, payout);
    insertTx(supabase, {
      user_id: humanUserId, type: 'match_win', amount_c: payout, stake_c: parseFloat(entryFee), status: 'confirmed', notes: note,
    })
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

// Returns how much of the user's balance is actually safe to withdraw, and
// whether they are allowed to withdraw at all.
//
// The reasoning this replaces was correct on its own terms — "there is no
// free coin faucet, every coin traces back to a real deposit, real rake, or a
// zero-sum transfer" — but it assumed every credit to a balance came through
// code that enforced that. The RLS hole proved that assumption false: a
// direct-to-database write minted a balance with no deposit and no rake
// behind it at all, invisible to this reasoning because it never went through
// any of the paths the reasoning was about. That specific hole is closed
// (PENDING_SQL 15/16), but the same SHAPE of gap was still open through
// routes that are entirely legitimate — deposit with a stolen card and
// withdraw before the chargeback lands; tip a fresh account and cash it
// straight out. Neither of those needs a database exploit, and neither was
// checked before this.
//
// Two rules, because they catch different things:
//
// 1. hasPlayed — must have played at least one real match, ever, any
//    currency. Coins reach an account by depositing, winning a match, or
//    being tipped; a balance built ENTIRELY from tips with zero matches
//    played has never been risked on the platform at all, which is
//    indistinguishable from a laundering hop. An absolute gate: it blocks a
//    withdrawal outright, not a cap on how much.
//
// 2. withdrawable — the balance minus whatever portion of lifetime deposits
//    has never once been wagered. lifetimeDeposited minus lifetimeWagered is
//    exactly the money that arrived and could leave again with nothing
//    platform-side happening to it in between — the shape of a
//    deposit-then-withdraw pass. Match winnings never add to
//    lifetimeDeposited, so they are never touched by this and stay fully,
//    immediately withdrawable regardless of how little has been wagered —
//    the thing the ORIGINAL reasoning above got right and this preserves.
//
// Deliberately an aggregate across the account's whole history, not a
// per-deposit ledger tracking which specific deposit funds which later
// withdrawal: it cannot tell a small legitimate winning apart from an
// untouched deposit once both are sitting in the same balance, so a heavy
// depositor who has barely played can see a real winning blocked alongside
// money that should stay locked. A true per-deposit ledger would not have
// that false positive and is meaningfully more state to keep correct; for a
// fraud control rather than a payout feature, a blocked legitimate
// withdrawal (a support ticket) was judged the safer failure mode against an
// unblocked fraudulent one (money gone).
// Whether a deposit has to be played before it can be withdrawn.
//
// ON by default: a deposit must be wagered in full before it can be
// withdrawn. Deposit in, withdraw out, no play, is the textbook laundering
// pattern and the usual reason a payment processor drops a platform like this
// — and without it a deposit and a withdrawal are a free transfer between
// accounts.
//
// 100% of the deposit, not a fraction: wager what you put in and the whole
// balance unlocks. Winnings above the deposit were never locked.
//
// Set WITHDRAW_PLAYTHROUGH=false to turn it off. The arithmetic runs either
// way, so the admin panel and /wallet/withdrawable keep reporting how much of
// a balance is unplayed even when it is not blocking anything.
const REQUIRE_PLAYTHROUGH = process.env.WITHDRAW_PLAYTHROUGH !== 'false';

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/**
 * Why a withdrawal is being refused, in the player's own numbers.
 *
 * One builder for both rails, because the crypto and bank routes were
 * refusing the same person for the same reason in two different wordings —
 * and neither said how much was left to wager, which is the only thing the
 * player actually needs in order to act.
 */
function playthroughMessage(src) {
  if (!REQUIRE_PLAYTHROUGH) return null;
  if (!src.hasPlayed) {
    return 'Play at least one match before withdrawing.';
  }
  const left = Math.max(0, src.unplayedDeposits || 0);
  if (left <= 0) return null;
  const head =
    `Deposits have to be wagered before they can be withdrawn. ` +
    `You have deposited ${usd(src.lifetimeDeposited)} and wagered ${usd(src.lifetimeWagered)}, ` +
    `so ${usd(left)} still needs to be wagered.`;
  return src.withdrawable > 0
    ? `${head} You can withdraw ${usd(src.withdrawable)} right now.`
    : head;
}

async function getWithdrawable(supabase, userId) {
  const { data: profile } = await supabase
    .from('profiles').select('c_coins, wins, losses').eq('id', userId).single();
  if (!profile) return { withdrawable: 0, balance: 0, hasPlayed: false };

  const balance   = parseFloat(profile.c_coins) || 0;
  const hasPlayed = ((profile.wins ?? 0) + (profile.losses ?? 0)) > 0;

  const [{ data: deposits }, { data: matchesAsP1 }, { data: matchesAsP2 }] = await Promise.all([
    supabase.from('transactions').select('amount_c')
      .eq('user_id', userId).eq('type', 'deposit').eq('status', 'confirmed'),
    supabase.from('matches').select('entry_fee_c').eq('player1_id', userId).gt('entry_fee_c', 0),
    supabase.from('matches').select('entry_fee_c').eq('player2_id', userId).gt('entry_fee_c', 0),
  ]);

  const lifetimeDeposited = (deposits || []).reduce((s, r) => s + (parseFloat(r.amount_c) || 0), 0);
  const lifetimeWagered = [...(matchesAsP1 || []), ...(matchesAsP2 || [])]
    .reduce((s, r) => s + (parseFloat(r.entry_fee_c) || 0), 0);

  const unplayedDeposits = Math.max(0, lifetimeDeposited - lifetimeWagered);
  // With the requirement off, the whole balance is withdrawable — including a
  // deposit that landed a moment ago. unplayedDeposits is still returned, so
  // nothing that reports on it starts reading zero.
  const withdrawable = REQUIRE_PLAYTHROUGH
    ? Math.max(0, balance - unplayedDeposits)
    : balance;

  return {
    withdrawable, balance, hasPlayed, lifetimeDeposited, lifetimeWagered,
    unplayedDeposits,
    // So a caller does not have to read the env var to know which rules the
    // numbers above were produced under.
    playthroughRequired: REQUIRE_PLAYTHROUGH,
  };
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
    notifyBalance(winnerId, loserId);
    closeEscrow(supabase, winnerId, loserId).catch(() => {});
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

    insertTx(supabase, [
      { user_id: winnerId, type: 'match_win',  amount_c: winnerPayout, stake_c: fee, status: 'confirmed' },
      { user_id: loserId,  type: 'match_loss', amount_c: fee,          status: 'confirmed' },
    ])

    return { winnerPayout };
  } finally {
    unlockUser(winnerId);
    unlockUser(loserId);
    notifyBalance(winnerId, loserId);
    closeEscrow(supabase, winnerId, loserId).catch(() => {});
  }
}

// Draw settlement (coins) — fees already deducted at match start; credit back 95% to both.
// A drawn match is a no-op: both players get their whole stake back.
//
// Nothing is raked, so there is nothing to fund a payout from — the rakeback
// credit, the affiliate/creator code share and the admin fee are all deliberately
// absent. Paying any of them on a draw would mean crediting rewards out of money
// the house never took, and charging the players for a match nobody won.
// The diamonds path has always worked this way; this is the coins path matching
// it, having previously refunded only 95%.
async function settleDrawMatch(supabase, p1Id, p2Id, entryFee) {
  const fee = parseFloat(entryFee);
  if (fee <= 0) return { winnerPayout: 0, fee: 0 };
  const refund = parseFloat(fee.toFixed(4));

  // Fees were taken at match start — hand both stakes straight back.
  await supabase.rpc('credit_coins', { user_id: p1Id, amount: refund });
  await supabase.rpc('credit_coins', { user_id: p2Id, amount: refund });

  insertTx(supabase, [
    { user_id: p1Id, type: 'match_draw', amount_c: refund, stake_c: refund, status: 'confirmed' },
    { user_id: p2Id, type: 'match_draw', amount_c: refund, stake_c: refund, status: 'confirmed' },
  ])

  unlockUser(p1Id);
  unlockUser(p2Id);
  notifyBalance(p1Id, p2Id);
  closeEscrow(supabase, p1Id, p2Id).catch(() => {});
  return { winnerPayout: refund, fee: 0 };
}

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
  notifyBalance(p1Id, p2Id);
  closeEscrow(supabase, p1Id, p2Id).catch(() => {});
  return { winnerPayout: fee, fee: 0 };
}

module.exports = {
  playthroughMessage,
  VALID_COINS,
  notifyBalance,
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
