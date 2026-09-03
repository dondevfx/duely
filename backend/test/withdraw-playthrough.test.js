// Whether a deposit has to be played before it can be withdrawn.
//
// ON by default: 100% of a deposit must be wagered before it can be withdrawn.
// Deposit in, withdraw out, no play, is the textbook laundering pattern and the
// usual reason a payment processor drops a platform like this; it also makes a
// deposit and a withdrawal a free transfer between accounts. Winnings above the
// deposit were never locked.
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

test('an unwagered deposit cannot be withdrawn', async () => {
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { getWithdrawable } = load();
  const w = await getWithdrawable(db({ coins: 50, deposited: 50 }), 'u1');
  assert.equal(w.withdrawable, 0, 'the whole deposit is locked until it is wagered');
  assert.equal(w.playthroughRequired, true, 'on by default');
});

test('wagering the deposit unlocks the whole balance, winnings included', async () => {
  // 50 in, 50 wagered, 80 on the books: the 30 above the deposit is winnings,
  // and 100% playthrough means everything is free once the deposit is played.
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { getWithdrawable } = load();
  const w = await getWithdrawable(db({ coins: 80, wins: 1, deposited: 50, wagered: 50 }), 'u1');
  assert.equal(w.withdrawable, 80);
  assert.equal(w.unplayedDeposits, 0);
});

test('the switch still turns it off', async () => {
  process.env.WITHDRAW_PLAYTHROUGH = 'false';
  try {
    const { getWithdrawable } = load();
    const w = await getWithdrawable(db({ coins: 50, deposited: 50 }), 'u1');
    assert.equal(w.withdrawable, 50);
    assert.equal(w.playthroughRequired, false);
  } finally { delete process.env.WITHDRAW_PLAYTHROUGH; }
});

test('the refusal says how much is left to wager', async () => {
  // The old wording said a deposit "has not been played yet" and stopped
  // there — true, and useless: it never said how much wagering would clear
  // it, which is the only thing the player can act on.
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { playthroughMessage } = load();
  const m = playthroughMessage({
    hasPlayed: true, lifetimeDeposited: 50, lifetimeWagered: 20,
    unplayedDeposits: 30, withdrawable: 15,
  });
  assert.match(m, /deposited \$50\.00/);
  assert.match(m, /wagered \$20\.00/);
  assert.match(m, /\$30\.00 still needs to be wagered/);
  assert.match(m, /withdraw \$15\.00 right now/);
});

test('with nothing withdrawable it does not offer to withdraw nothing', async () => {
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { playthroughMessage } = load();
  const m = playthroughMessage({
    hasPlayed: true, lifetimeDeposited: 50, lifetimeWagered: 0,
    unplayedDeposits: 50, withdrawable: 0,
  });
  assert.match(m, /\$50\.00 still needs to be wagered/);
  assert.ok(!/right now/.test(m), '"you can withdraw $0.00 right now" is noise');
});

test('a cleared balance produces no message at all', async () => {
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { playthroughMessage } = load();
  assert.equal(playthroughMessage({
    hasPlayed: true, lifetimeDeposited: 50, lifetimeWagered: 50,
    unplayedDeposits: 0, withdrawable: 80,
  }), null);
});

test('never having played is its own message', async () => {
  // Distinct from the wager rule: someone whose balance came from a tip has
  // no unwagered deposit, so only this catches them.
  delete process.env.WITHDRAW_PLAYTHROUGH;
  const { playthroughMessage } = load();
  assert.equal(playthroughMessage({
    hasPlayed: false, lifetimeDeposited: 50, lifetimeWagered: 0,
    unplayedDeposits: 50, withdrawable: 0,
  }), 'Play at least one match before withdrawing.');
});

test('with the rule off there is no message on either half', async () => {
  process.env.WITHDRAW_PLAYTHROUGH = 'false';
  try {
    const { playthroughMessage } = load();
    assert.equal(playthroughMessage({ hasPlayed: false, unplayedDeposits: 50, withdrawable: 0 }), null);
  } finally { delete process.env.WITHDRAW_PLAYTHROUGH; }
});

test('both rails refuse with the same builder, and send the numbers', () => {
  // Two routes were refusing the same person for the same reason in two
  // different wordings. The figures ride along so the page can show progress
  // without parsing the sentence.
  const uses = ROUTE.match(/const blocked = playthroughMessage\(src\);/g) || [];
  assert.equal(uses.length, 2, 'crypto and bank withdrawals both need it');
  assert.equal((ROUTE.match(/remainingToWager: src\.unplayedDeposits/g) || []).length, 2);
  assert.ok(!/has not been played yet/.test(ROUTE), 'the old wording is gone');
});
