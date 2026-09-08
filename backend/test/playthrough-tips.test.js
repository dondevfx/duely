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
function db({ balance, deposits = [], tips = [], spins = [], rakeback = null,
              stakes = [], wins = 1, losses = 1 }) {
  return {
    from(table) {
      const q = { table, filters: {} };
      const api = {
        select: () => api,
        eq: (col, val) => { q.filters[col] = val; return api; },
        gt: () => api,
        single: async () => ({ data: { c_coins: balance, wins, losses } }),
        // rakeback lives in a profiles column, read on its own query. null
        // means the migration has not run, which must error rather than
        // return 0 — that is the case the code has to survive.
        maybeSingle: async () => {
          // Answers for THIS user only. Ignoring the id would make a query
          // against the wrong account look identical to a correct one.
          if (q.filters.id !== 'u') return { data: null, error: null };
          return rakeback === null
            ? { data: null, error: { message: 'column profiles.rakeback_claimed_total does not exist' } }
            : { data: { rakeback_claimed_total: rakeback }, error: null };
        },
        then: (resolve) => resolve({
          // Answers by the type actually asked for. Returning `tips` for any
          // non-deposit type would make reading tip_SENT look identical to
          // reading tip_received — and that mix-up would lock the sender's
          // balance and leave the recipient's free, which is the exploit with
          // an extra step.
          data: q.table === 'transactions'
            ? ({ deposit: deposits, tip_received: tips, rewards_spin: spins }[q.filters.type] || [])
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
  assert.match(msg, /wagered \$0\.00/);
  // Sources the player has none of are left out — "$0.00 in deposits" beside
  // "$20.00 in tips" is a number to read that says nothing.
  assert.doesNotMatch(msg, /in deposits/);
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
        maybeSingle: async () => ({ data: { rakeback_claimed_total: 0 }, error: null }),
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

// ── Wheel prizes and rakeback ──────────────────────────────────────────────

test('wheel coins cannot be withdrawn until they are wagered', async () => {
  // Free coins that arrived without being risked, which is the whole thing the
  // requirement is about.
  const r = await check({ balance: 50, spins: [50] });
  assert.equal(r.lifetimeSpun, 50);
  assert.equal(r.withdrawable, 0);
});

test('a wagered wheel prize is released', async () => {
  const r = await check({ balance: 50, spins: [50], stakes: [50] });
  assert.equal(r.withdrawable, 50);
});

test('diamond spins carry nothing', async () => {
  // A diamond spin records amount_c 0 — the prize rides on crypto_amount — so
  // summing amount_c counts coin prizes and nothing else.
  const r = await check({ balance: 20, spins: [0, 0], stakes: [5] });
  assert.equal(r.lifetimeSpun, 0);
  assert.equal(r.withdrawable, 20);
});

test('claimed rakeback counts toward the requirement', async () => {
  // $100 deposited and wagered, $4 rakeback claimed: the rakeback is the part
  // that has not been through a match.
  const r = await check({ balance: 104, deposits: [100], rakeback: 4, stakes: [100] });
  assert.equal(r.lifetimeRakeback, 4);
  assert.equal(r.withdrawable, 100);
});

test('a missing rakeback column does not break withdrawals', async () => {
  // The migration is section 21 of PENDING_SQL and may not have been run. The
  // column is read on its own query for exactly this reason: folded into the
  // main profile select, a missing column makes PostgREST reject the WHOLE
  // query and every withdrawal on the site stops until the migration lands.
  const r = await check({ balance: 104, deposits: [100], rakeback: null, stakes: [100] });
  assert.equal(r.lifetimeRakeback, 0, 'a missing column must degrade to zero');
  assert.equal(r.withdrawable, 104, 'withdrawals must keep working');
});

test('the refusal lists only the sources the player actually has', async () => {
  // "deposits $0.00, tips $0.00, rakeback $4.00" is three numbers to read, two
  // of which are noise.
  const m = load();
  const r = await m.getWithdrawable(db({ balance: 50, spins: [50] }), 'u');
  const msg = m.playthroughMessage(r);
  assert.match(msg, /\$50\.00 from spins/);
  assert.doesNotMatch(msg, /in tips/, 'listed a source the player has none of');
  assert.doesNotMatch(msg, /in rakeback/, 'listed a source the player has none of');
});

test('the missing column is warned about, once', async () => {
  // Silence would mean rakeback quietly carrying no playthrough for as long as
  // the migration went unrun — the shape of every bug in this codebase that
  // took months to find.
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const m = load();
    const state = { balance: 104, deposits: [100], rakeback: null, stakes: [100] };
    await m.getWithdrawable(db(state), 'u');
    await m.getWithdrawable(db(state), 'u');
    await m.getWithdrawable(db(state), 'u');
    const hits = warned.filter(w => w.includes('rakeback_claimed_total'));
    assert.equal(hits.length, 1, `warned ${hits.length} times — once per process, not per check`);
    assert.match(hits[0], /PENDING_SQL section 21/, 'a warning without the fix is half a warning');
  } finally { console.warn = realWarn; }
});

test('rakeback is read for the player being checked', async () => {
  // Reading another account's total would lock or free the wrong balance.
  const m = load();
  const r = await m.getWithdrawable(db({ balance: 104, deposits: [100], rakeback: 4, stakes: [100] }), 'u');
  assert.equal(r.lifetimeRakeback, 4);
});
