// Referral rewards.
//
// This pays real coins for activity, so the thing that matters is that it can
// never pay out more than the rake that activity generated — otherwise it is a
// money pump anyone can farm with throwaway accounts. These tests pin the
// economics as hard as the mechanics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ref = require('../src/services/referralService');

// Fee structure, from walletService/affiliateService: pool = 2 x stake, total
// rake 5% of pool, admin 4.0% when an affiliate code is applied (which a
// referred player always has). That is 8c per $1 the player stakes.
//
// The bar is set on HALF of that. The other half of every pool is the
// opponent's money, and the opponent would mostly have found a match anyway, so
// crediting the referred player with all of it overstates what they brought in.
// Testing against the conservative figure means the reward stays funded even
// when their matches displace ones that would have happened regardless.
const PLATFORM_PER_DOLLAR_WAGERED = 0.04;        // 4c per $1 staked, conservative
const COINFLIP_PER_DOLLAR         = 0.015;       // coin flip rakes 2% of pool

test('the reward is funded by the rake it requires', () => {
  const earned = ref.MIN_WAGERED_USD * PLATFORM_PER_DOLLAR_WAGERED;
  assert.ok(earned > ref.REWARD_COINS,
    `$${ref.MIN_WAGERED_USD} wagered earns $${earned.toFixed(2)} but pays $${ref.REWARD_COINS} — this loses money`);
  const margin = (earned - ref.REWARD_COINS) / earned;
  assert.ok(margin >= 0.4,
    `margin is ${(margin * 100).toFixed(0)}% — too thin to absorb players skewing to cheaper games`);
});

test('farming it costs more than it pays', () => {
  // A throwaway account must wager the bar to unlock the reward. Rake is 10c
  // per $1 staked, all of which the farmer loses.
  const rakeBurned = ref.MIN_WAGERED_USD * 0.10;   // full rake — the farmer pays it all
  assert.ok(rakeBurned > ref.REWARD_COINS,
    `farming burns $${rakeBurned.toFixed(2)} to collect $${ref.REWARD_COINS} — must be a loss`);
});

test('the bar would NOT be self-funding on coin flip volume', () => {
  // Documents why coin flip is excluded. If this ever stops being true the
  // exclusion could be revisited; while it holds, counting coin flip would let
  // the reward be unlocked for less rake than it costs.
  const earned = ref.MIN_WAGERED_USD * COINFLIP_PER_DOLLAR;
  assert.ok(earned < ref.REWARD_COINS,
    'coin flip is excluded precisely because it does not fund the reward');
});

test('coin flip is excluded structurally, not by a list of game names', () => {
  // A name list silently starts counting coin flip the day a string changes.
  // The real guarantee is that only settleMatch calls trackWager, and coin flip
  // settles through settleCoinFlip.
  const wallet = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'walletService.js'), 'utf8');

  const settleMatch = wallet.slice(wallet.indexOf('async function settleMatch'),
                                  wallet.indexOf('async function settleCoinFlip'));
  const settleCoinFlip = wallet.slice(wallet.indexOf('async function settleCoinFlip'),
                                      wallet.indexOf('async function settleMatchDiamonds'));

  assert.match(settleMatch, /trackWager/, 'settleMatch must feed referral progress');
  assert.ok(!/trackWager/.test(settleCoinFlip),
    'settleCoinFlip must NOT — its 2% rake cannot fund the reward');
});

test('both players count, since both paid an entry fee', () => {
  const wallet = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'walletService.js'), 'utf8');
  const block = wallet.slice(wallet.indexOf('// Referral progress'),
                             wallet.indexOf('// Referral progress') + 600);
  assert.match(block, /trackWager\(supabase, winnerId, fee\)/);
  assert.match(block, /trackWager\(supabase, loserId,  fee\)/);
});

test('demo accounts cannot generate referral rewards', () => {
  const wallet = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'walletService.js'), 'utf8');
  const block = wallet.slice(wallet.indexOf('// Referral progress'),
                             wallet.indexOf('// Referral progress') + 600);
  assert.match(block, /isDemo\(winnerId\)[\s\S]*isDemo\(loserId\)/,
    'demo play is free — it must not unlock a paid reward');
});

test('a reward can only ever be claimed once per referred account', async () => {
  // The unique index is what enforces this; the service must treat 23505 as
  // "already qualified" rather than an error, because it fires on every match
  // the player finishes after crossing the bar.
  const rows = [];
  const db = {
    from() {
      return {
        insert(row) {
          if (rows.some(r => r.referred_id === row.referred_id)) {
            return Promise.resolve({ error: { code: '23505' } });
          }
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  assert.equal(await ref.claimReferralReward(db, 'alice', 'bob'), true);
  assert.equal(await ref.claimReferralReward(db, 'alice', 'bob'), false, 'second claim must be refused');
  assert.equal(await ref.claimReferralReward(db, 'alice', 'bob'), false);
  assert.equal(rows.length, 1, `${rows.length} reward rows for one referral`);
});

test('you cannot refer yourself', async () => {
  const db = { from: () => ({ insert: () => { throw new Error('should not insert'); } }) };
  assert.equal(await ref.claimReferralReward(db, 'alice', 'alice'), false);
});

test('the reward is held, not paid on qualification', async () => {
  const rows = [];
  const db = { from: () => ({ insert(r) { rows.push(r); return Promise.resolve({ error: null }); } }) };
  await ref.claimReferralReward(db, 'alice', 'bob');
  assert.equal(rows[0].status, 'pending', 'must not be credited until the hold elapses');
  const heldDays = (new Date(rows[0].mature_at) - Date.now()) / 86400_000;
  assert.ok(Math.abs(heldDays - ref.HOLD_DAYS) < 0.01,
    `hold is ${heldDays.toFixed(2)} days, expected ${ref.HOLD_DAYS}`);
});

test('collecting claims a row before crediting it', () => {
  // Same ordering as the deposit claim: flip pending->paid first, credit only
  // the row you actually flipped, roll back if the credit fails.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'referralService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function collectReferralEarnings'));
  const claimIdx  = fn.indexOf("status: 'paid'");
  // The bank transfer IS the credit now — coins move out of fee_balance rather
  // than being minted, so this is what must not run before the claim.
  const creditIdx = fn.indexOf("rpc('pay_referral_from_bank'");
  assert.ok(claimIdx > 0 && creditIdx > claimIdx,
    'the row must be claimed BEFORE the coins are credited');
  assert.match(fn, /if \(!claimed\?\.length\) continue;/,
    'only the request that won the flip may credit');
  assert.match(fn, /status: 'pending', paid_at: null/,
    'a failed credit must roll the claim back so it retries');
});

test('the permanent referral link is never overwritten', () => {
  // applied_affiliate_code expires and can be swapped. If the referral credit
  // followed it, a player could be re-referred repeatedly and pay out again.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'affiliate.js'), 'utf8');
  assert.match(src, /if \(!existing\?\.referred_by\) patch\.referred_by = owner\.id;/,
    'referred_by must only be set when it is not already set');
});

test('the reward is paid from the bank, never minted', () => {
  // creditCoins() creates new coins. Using it here would put coins into
  // circulation with no deposit behind them, so withdrawable balances would
  // drift above the USDC actually held and the bonus would drain the bank.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'referralService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function collectReferralEarnings'),
                       src.indexOf('/** Cancel a pending reward'));
  // Comments explain why creditCoins is NOT used, so strip them before testing.
  const code = fn.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/creditCoins\(/.test(code),
    'must not mint — move coins out of the fee balance instead');
  assert.match(fn, /rpc\('pay_referral_from_bank'/,
    'payout must go through the bank transfer');
});

test('an underfunded bank defers the reward instead of overdrawing', async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'referralService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function collectReferralEarnings'),
                       src.indexOf('/** Cancel a pending reward'));
  assert.match(fn, /if \(ok === false\)/,
    'a false return means the bank is short and must be handled');
  const shortBranch = fn.slice(fn.indexOf('if (ok === false)'));
  assert.match(shortBranch.slice(0, 400), /rollback\(/,
    'the reward must go back to collectable, not be silently consumed');
});

test('with no ADMIN_USER_ID nothing is paid and nothing is lost', async () => {
  const keep = process.env.ADMIN_USER_ID;
  delete process.env.ADMIN_USER_ID;
  let touched = false;
  const db = { from: () => { touched = true; return { select: () => ({}) }; } };
  assert.equal(await ref.collectReferralEarnings(db, 'alice'), 0);
  assert.equal(touched, false, 'must bail before touching any reward rows');
  process.env.ADMIN_USER_ID = keep;
});

test('the bank transfer is a single atomic statement pair', () => {
  // Deduct-then-credit across two round trips could credit after a failed
  // deduct. The SQL function does both inside one transaction and refuses
  // rather than letting fee_balance go negative.
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'PENDING_SQL.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION pay_referral_from_bank'));
  assert.match(fn, /fee_balance = fee_balance - amount/);
  assert.match(fn, /COALESCE\(fee_balance, 0\) >= amount/,
    'the deduct must be conditional on sufficient funds');
  assert.match(fn, /IF moved = 0 THEN RETURN false/,
    'an underfunded bank must return false, not raise');
  assert.ok(fn.indexOf('c_coins = COALESCE(c_coins, 0) + amount') > fn.indexOf('IF moved = 0'),
    'the credit must come after the guarded deduct');
});
