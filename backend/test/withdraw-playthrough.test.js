// Whether a deposit has to be played before it can be withdrawn.
//
// Turned off at the owner's instruction: money just deposited can be taken
// straight back out. What the rule was for is worth stating rather than
// forgetting — deposit in, withdraw out, no play, is the textbook laundering
// pattern, and it also makes deposits and withdrawals a free transfer between
// accounts. It is a switch, not a deletion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = path.join(__dirname, '..', 'src', 'services', 'walletService.js');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');

// A profile with a deposit and no matches: the exact case that was blocked.
function db({ coins, wins = 0, losses = 0, deposited, wagered = 0 }) {
  return {
    from: (table) => ({
      select: () => ({
        eq: (col, val) => {
          const rows = table === 'profiles'
            ? { data: { c_coins: coins, wins, losses } }
            : { data: deposited != null && table === 'transactions'
                ? [{ amount_c: deposited }] : [] };
          const chain = {
            eq: () => chain,
            gt: () => Promise.resolve({ data: wagered > 0 && col === 'player1_id' ? [{ entry_fee_c: wagered }] : [] }),
            single: async () => rows,
            then: (r) => Promise.resolve(rows).then(r),
          };
          return chain;
        },
      }),
    }),
  };
}

function load() {
  delete require.cache[require.resolve(SERVICE)];
  return require(SERVICE);
}

test('a deposit that has not been played is withdrawable', async () => {
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { getWithdrawable } = load();
  const w = await getWithdrawable(db({ coins: 50, deposited: 50 }), 'u1');
  assert.equal(w.withdrawable, 50, 'the whole balance, including the fresh deposit');
  assert.equal(w.playthroughRequired, false);
});

test('the unplayed figure is still reported when it no longer blocks', async () => {
  // The admin panel and /wallet/withdrawable keep showing how much of a
  // balance is unplayed — turning the rule off must not make the number
  // disappear, only stop it being a gate.
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { getWithdrawable } = load();
  const w = await getWithdrawable(db({ coins: 50, deposited: 50 }), 'u1');
  assert.equal(w.unplayedDeposits, 50);
  assert.equal(w.lifetimeDeposited, 50);
});

test('setting the switch restores the old behaviour exactly', async () => {
  process.env.WITHDRAW_PLAYTHROUGH = 'true';
  try {
    const { getWithdrawable } = load();
    const w = await getWithdrawable(db({ coins: 50, deposited: 50 }), 'u1');
    assert.equal(w.withdrawable, 0, 'an unplayed deposit is locked again');
    assert.equal(w.playthroughRequired, true);
  } finally {
    delete process.env.WITHDRAW_PLAYTHROUGH;
  }
});

test('winnings were always withdrawable and still are', async () => {
  // 50 deposited, 50 wagered, 80 in the balance: the 30 above the deposit is
  // winnings, and was withdrawable under the old rule too.
  for (const on of ['true', undefined]) {
    if (on) process.env.WITHDRAW_PLAYTHROUGH = on; else delete process.env.WITHDRAW_PLAYTHROUGH;
    const { getWithdrawable } = load();
    const w = await getWithdrawable(db({ coins: 80, wins: 1, deposited: 50, wagered: 50 }), 'u1');
    assert.equal(w.withdrawable, 80, `switch=${on}: a played-through balance is fully withdrawable`);
  }
  delete process.env.WITHDRAW_PLAYTHROUGH;
});

test('the "play a match first" refusal is on the same switch', () => {
  // Two guards, one rule. Leaving this one unconditional would refuse the
  // request while the balance check said the money was free to go — the same
  // withdrawal blocked for a reason that no longer applies.
  const guards = ROUTE.match(/if \(src\.playthroughRequired && !src\.hasPlayed\)/g) || [];
  assert.equal(guards.length, 2, 'crypto and bank withdrawals both need it');
  assert.ok(!/if \(!src\.hasPlayed\)/.test(ROUTE), 'an unconditional guard is left');
});
