// A tip carries the same obligation as a deposit.
//
// The playthrough rule locked deposits until they had been wagered, and read
// the lock from `type: 'deposit'` rows alone. A tip is not a deposit, so
// tipped coins were withdrawable the instant they landed — which made the rule
// pointless, because the bypass cost nothing:
//
//   deposit $20 -> tip it to a second account -> withdraw $20 from there,
//   having wagered nothing.
//
// The deposit leaves the platform without a single match being played, which
// is the exact pattern the requirement exists to stop.
const test = require('node:test');
const assert = require('node:assert/strict');

// getWithdrawable reads: the profile, deposit rows, tip_received rows, and the
// entry fees of matches on both sides. Nothing else.
function db({ balance, deposits = [], tips = [], stakes = [], wins = 1, losses = 1 }) {
  return {
    from(table) {
      const q = { table, filters: {} };
      const api = {
        select: () => api,
        eq: (col, val) => { q.filters[col] = val; return api; },
        gt: () => api,
        single: async () => ({ data: { c_coins: balance, wins, losses } }),
        then: (resolve) => resolve({
          // Answers by the type actually asked for. Returning `tips` for any
          // non-deposit type would make reading tip_SENT look identical to
          // reading tip_received — and that mix-up would lock the sender's
          // balance and leave the recipient's free, which is the exploit with
          // an extra step.
          data: q.table === 'transactions'
            ? ({ deposit: deposits, tip_received: tips }[q.filters.type] || [])
                .map(a => ({ amount_c: a }))
            : (q.filters.player1_id ? stakes.map(a => ({ entry_fee_c: a })) : []),
        }),
      };
      return api;
    },
  };
}

// The env var is read at module load, so the module is loaded per setting.
function load(on = true) {
  const real = process.env.WITHDRAW_PLAYTHROUGH;
  process.env.WITHDRAW_PLAYTHROUGH = on ? '1' : 'false';
  delete require.cache[require.resolve('../src/services/walletService')];
  const m = require('../src/services/walletService');
  process.env.WITHDRAW_PLAYTHROUGH = real;
  delete require.cache[require.resolve('../src/services/walletService')];
  return m;
}

const check = async (state) => (await load().getWithdrawable(db(state), 'u'));

// ── The exploit ────────────────────────────────────────────────────────────

test('tipped coins cannot be withdrawn until they are wagered', async () => {
  const r = await check({ balance: 20, tips: [20] });
  assert.equal(r.withdrawable, 0,
    'a tipped balance was withdrawable without a single match — deposit, tip to ' +
    'a second account, withdraw, and the playthrough rule is bypassed entirely');
  assert.equal(r.unplayedDeposits, 20);
});

test('every tip counts, even from someone who had already wagered it', async () => {
  // Deliberate. Tracking whether a particular coin had already been wagered
  // needs a per-coin ledger, and the moment tips of "clean" money are exempt
  // the exploit returns through any account that has played one match.
  const r = await check({ balance: 20, tips: [20], stakes: [] });
  assert.equal(r.withdrawable, 0);
});

test('a tip stops being locked once it has been wagered', async () => {
  const r = await check({ balance: 20, tips: [20], stakes: [20] });
  assert.equal(r.withdrawable, 20, 'wagering the tip must release it');
});

test('deposits and tips both count toward the same requirement', async () => {
  // $20 deposited plus $20 tipped is $40 owed; $20 wagered leaves $20 locked.
  const r = await check({ balance: 40, deposits: [20], tips: [20], stakes: [20] });
  assert.equal(r.playthroughOwed, 40);
  assert.equal(r.withdrawable, 20);
});

// ── The rules that already worked, which must keep working ─────────────────

test('a fully wagered deposit unlocks the whole balance, winnings included', async () => {
  const r = await check({ balance: 200, deposits: [20], stakes: [20] });
  assert.equal(r.withdrawable, 200,
    'winnings above the deposit were never locked and must not become so');
});

test('a partly wagered deposit holds back only the unwagered part', async () => {
  // $20 in, $10 wagered across two $5 games, balance $29 after winning both.
  const r = await check({ balance: 29, deposits: [20], stakes: [5, 5] });
  assert.equal(r.unplayedDeposits, 10);
  assert.equal(r.withdrawable, 19, 'the wagered amount plus winnings comes out; $10 stays');
});

test('a balance built purely from winnings is never locked', async () => {
  const r = await check({ balance: 50, stakes: [10] });
  assert.equal(r.withdrawable, 50);
});

test('diamond tips carry no obligation', async () => {
  // Diamonds are not withdrawable, so they cannot be laundered out. They are
  // recorded with amount_c 0 (the amount rides on crypto_amount), so summing
  // amount_c counts coin tips and nothing else — but if that ever changes,
  // this fails rather than locking coins against a diamond gift.
  const r = await check({ balance: 20, tips: [0, 0, 0] });
  assert.equal(r.unplayedDeposits, 0);
  assert.equal(r.withdrawable, 20);
});

// ── What the player is told ────────────────────────────────────────────────

test('the refusal names tips when tips are the reason', async () => {
  // "You have deposited $0.00" and still owe $20 reads as a bug, and a player
  // cannot act on a number that does not add up.
  const m = load();
  const r = await m.getWithdrawable(db({ balance: 20, tips: [20] }), 'u');
  const msg = m.playthroughMessage(r);
  // The AMOUNT, not the word: the fixed header says "Deposits and tips" no
  // matter what, so matching /tips/ passes even when the numbers are missing.
  assert.match(msg, /\$20\.00 in tips/,
    'the message never says how much of the lock is tips');
  assert.match(msg, /\$0\.00 in deposits/, 'and how much is deposits');
  assert.match(msg, /wagered \$0\.00/);
  assert.doesNotMatch(msg, /^Deposits have to be wagered/,
    'the wording still claims deposits are the only thing locked');
});

test('the refusal says how much can be withdrawn right now', async () => {
  const m = load();
  const r = await m.getWithdrawable(db({ balance: 29, deposits: [20], stakes: [5, 5] }), 'u');
  assert.match(m.playthroughMessage(r), /withdraw \$19\.00 right now/);
});

test('nothing is locked when the requirement is switched off', async () => {
  const m = load(false);
  const r = await m.getWithdrawable(db({ balance: 20, tips: [20] }), 'u');
  assert.equal(r.withdrawable, 20);
  assert.equal(r.playthroughRequired, false);
  // The arithmetic still runs, so the admin panel keeps reporting it.
  assert.equal(r.unplayedDeposits, 20);
  assert.equal(m.playthroughMessage(r), null);
});

test('sending a tip does not lock the sender', async () => {
  // tip_received, not tip_sent. Reading the wrong row would lock the balance of
  // the person who gave the money away and leave the recipient's free — the
  // exploit intact, plus a penalty on the wrong player.
  const m = load();
  const sender = {
    from(table) {
      const q = { filters: {} };
      const api = {
        select: () => api,
        eq: (c, v) => { q.filters[c] = v; return api; },
        gt: () => api,
        single: async () => ({ data: { c_coins: 50, wins: 1, losses: 1 } }),
        then: (res) => res({
          data: table === 'transactions'
            // This account SENT $20 and received nothing.
            ? (q.filters.type === 'tip_sent' ? [{ amount_c: 20 }] : [])
            : [],
        }),
      };
      return api;
    },
  };
  const r = await m.getWithdrawable(sender, 'u');
  assert.equal(r.lifetimeTipped, 0, 'a tip SENT was counted as one received');
  assert.equal(r.withdrawable, 50);
});
