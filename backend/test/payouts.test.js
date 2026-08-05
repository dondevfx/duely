// Settlement maths. These numbers are the product's promises to its players,
// so they are pinned exactly rather than checked loosely.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLedger } = require('./helpers/stubs');

process.env.ADMIN_USER_ID = 'adminUser';
const w = require('../src/services/walletService');

const FEE = 10;
const POT = FEE * 2;
const near = (a, b) => Math.abs(a - b) < 0.0001;

test('a normal win pays the winner 95% of the pot', async () => {
  const { coins, supabase } = makeLedger();
  await w.settleMatch(supabase, 'winner', 'loser', FEE, { game: 'Block Burst' });
  assert.ok(near(coins.winner, POT * 0.95), `winner got ${coins.winner}, expected ${POT * 0.95}`);
  assert.ok(!coins.loser, `loser should get nothing, got ${coins.loser}`);
});

test('coin flip pays the winner 98% of the pot', async () => {
  const { coins, supabase } = makeLedger();
  await w.settleCoinFlip(supabase, 'winner', 'loser', FEE, { game: 'Coin Flip' });
  assert.ok(near(coins.winner, POT * 0.98), `winner got ${coins.winner}, expected ${POT * 0.98}`);
});

test('a forfeit pays the player who stayed, and nothing to the leaver', async () => {
  const { coins, supabase } = makeLedger();
  await w.forfeitSettleCoins(supabase, 'stayer', 'leaver', FEE, 'adminUser');
  assert.ok(near(coins.stayer, POT * 0.95), `stayer got ${coins.stayer}`);
  assert.ok(!coins.leaver, `leaver should get nothing, got ${coins.leaver}`);
});

test('a drawn match refunds both stakes in full and rakes nothing', async () => {
  const { coins, feeBalance, supabase } = makeLedger();
  const res = await w.settleDrawMatch(supabase, 'p1', 'p2', FEE);
  assert.ok(near(coins.p1, FEE), `p1 got ${coins.p1}, expected the full ${FEE} back`);
  assert.ok(near(coins.p2, FEE), `p2 got ${coins.p2}, expected the full ${FEE} back`);
  assert.equal(res.fee, 0, 'a draw must report no platform fee');
  assert.ok(!feeBalance.adminUser, 'a draw must not credit the admin fee balance');
});

test('a drawn match in diamonds also refunds in full', async () => {
  const { diamonds, supabase } = makeLedger();
  await w.settleDrawMatchDiamonds(supabase, 'p1', 'p2', FEE);
  assert.equal(diamonds.p1, FEE);
  assert.equal(diamonds.p2, FEE);
});

test('losing to a bot credits the player nothing', async () => {
  const { coins, supabase } = makeLedger();
  await w.settleBotMatch(supabase, 'human', FEE, 'coins', false, { game: 'Rush Hour' }, 0.95);
  assert.ok(!coins.human, `human lost but was credited ${coins.human}`);
});

test('beating a bot returns the stake plus winnings', async () => {
  const { coins, supabase } = makeLedger();
  await w.settleBotMatch(supabase, 'human', FEE, 'coins', true, { game: 'Rush Hour' }, 0.95);
  assert.ok(coins.human > FEE, `human won but only got ${coins.human}, which is not more than the stake`);
});

test('no settlement path pays out more than was staked', async () => {
  for (const [name, fn] of [
    ['settleMatch',     (s) => w.settleMatch(s, 'p1', 'p2', FEE, { game: 'X' })],
    ['settleCoinFlip',  (s) => w.settleCoinFlip(s, 'p1', 'p2', FEE, { game: 'X' })],
    ['settleDrawMatch', (s) => w.settleDrawMatch(s, 'p1', 'p2', FEE)],
  ]) {
    const { coins, supabase } = makeLedger();
    await fn(supabase);
    const paid = (coins.p1 || 0) + (coins.p2 || 0);
    assert.ok(paid <= POT + 0.0001, `${name} paid ${paid} out of a ${POT} pot`);
  }
});

test('a player who cannot cover the fee is refused, and the opponent is made whole', async () => {
  const { coins, supabase } = makeLedger();
  coins.poor = 5;
  coins.rich = 100;
  await assert.rejects(
    () => w.deductMatchFees(supabase, 'poor', 'rich', 10, 'coins'),
    'staking more than the balance must throw',
  );
  assert.equal(coins.rich, 100, 'the solvent player must be refunded when the match cannot start');
});

test('withdrawal amounts reject every hostile input', () => {
  const rejects = (v) => {
    try { w.sanitizeAmount(v, 5, 10000); return false; } catch { return true; }
  };
  for (const bad of [-100, 0, NaN, 'abc', Infinity, 1, 1e9, '1e9', null, undefined,
                     { valueOf: () => 1e9 }]) {
    assert.ok(rejects(bad), `${String(bad)} should have been rejected`);
  }
  assert.equal(w.sanitizeAmount(50, 5, 10000), 50, 'a legitimate amount must still pass');
});
