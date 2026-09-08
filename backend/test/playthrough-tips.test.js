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
              affiliate = 0, matchWins = [], matchLosses = [], withdrawals = [],
              stakes = [], wins = 1, losses = 1 }) {
  // One ledger, the way the code now reads it: every confirmed coin row in a
  // single query, classified by type. The previous fake answered a separate
  // query per type, which meant it could not represent winnings at all — and
  // winnings are exactly what tells an earned balance from an invented one.
  const rows = [
    ...deposits.map(a => ({ type: 'deposit', amount_c: a })),
    ...tips.map(a => ({ type: 'tip_received', amount_c: a })),
    ...spins.map(a => ({ type: 'rewards_spin', amount_c: a })),
    ...matchWins.map(a => ({ type: 'match_win', amount_c: a })),
    ...matchLosses.map(a => ({ type: 'match_loss', amount_c: a })),
    ...withdrawals.map(a => ({ type: 'withdrawal', amount_c: a })),
  ];
  return {
    from(table) {
      const q = { table, filters: {} };
      const api = {
        select: (cols) => { q.cols = cols || ''; return api; },
        eq: (col, val) => { q.filters[col] = val; return api; },
        gt: () => api,
        single: async () => ({ data: { c_coins: balance, wins, losses } }),
        // The rakeback/affiliate columns are read on their own query. null
        // rakeback means the migration has not run, which must error rather
        // than return 0 — that is the case the code has to survive.
        maybeSingle: async () => {
          // Answers for THIS user only. Ignoring the id would make a query
          // against the wrong account look identical to a correct one.
          if (q.filters.id !== 'u') return { data: null, error: null };
          return rakeback === null
            ? { data: null, error: { message: 'column profiles.rakeback_claimed_total does not exist' } }
            : { data: { rakeback_claimed_total: rakeback, affiliate_earnings_c: affiliate }, error: null };
        },
        then: (resolve) => resolve({
          data: q.table === 'transactions'
            ? rows
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
  const r = await check({ balance: 200, deposits: [20], stakes: [20],
    // 20 in, 20 staked, 200 on the books: the 200 is winnings, and the
    // ledger has to say so or it is a balance from nowhere.
    matchWins: [200] });
  assert.equal(r.withdrawable, 200,
    'winnings above the deposit were never locked and must not become so');
});

test('a partly wagered deposit holds back only the unwagered part', async () => {
  // $20 in, $10 wagered across two $5 games, balance $29 after winning both.
  const r = await check({ balance: 29, deposits: [20], stakes: [5, 5],
    matchWins: [9.5, 9.5] });
  assert.equal(r.unplayedDeposits, 10);
  assert.equal(r.withdrawable, 19, 'the wagered amount plus winnings comes out; $10 stays');
});

test('a balance built purely from winnings is never locked', async () => {
  const r = await check({ balance: 50, stakes: [10], matchWins: [50] });
  assert.equal(r.withdrawable, 50);
});

test('diamond tips carry no obligation', async () => {
  // Diamonds are not withdrawable, so they cannot be laundered out. They are
  // recorded with amount_c 0 (the amount rides on crypto_amount), so summing
  // amount_c counts coin tips and nothing else — but if that ever changes,
  // this fails rather than locking coins against a diamond gift.
  const r = await check({ balance: 20, tips: [0, 0, 0], matchWins: [20] });
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
  const r = await m.getWithdrawable(db({ balance: 29, deposits: [20], stakes: [5, 5],
    matchWins: [9.5, 9.5] }), 'u');
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
            // Won 70, gave 20 away: a balance of 50 with a history behind it.
            // The tip they SENT is the row under test.
            ? [{ type: 'match_win', amount_c: 70 }, { type: 'tip_sent', amount_c: 20 }]
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
  const r = await check({ balance: 20, spins: [0, 0], stakes: [5], matchWins: [20] });
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
  // Withdrawals keep working — the deposit is still withdrawable, which is the
  // thing that must not break.
  assert.equal(r.withdrawable, 100, 'the explained balance must still come out');
  // But the 4 coins of rakeback now have no record anywhere, so they cannot be
  // accounted for and are held. That is the honest consequence of the column
  // being missing, and the reason to run the migration rather than a reason to
  // treat unknown money as explained.
  assert.equal(r.unexplained, 4);
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

// ── Money with no history ──────────────────────────────────────────────────
//
// The rule only ever asked what portion of a balance was LOCKED and let
// everything else out, which inverts the safe default: a balance arriving by
// any route it did not know about had nothing locked against it, so all of it
// was withdrawable the moment the account had one win to its name.
//
// An account did exactly that — no deposit, no tip, no spin, no rakeback, no
// match row of any kind, 9,990 coins written straight onto the profile, and
// $10 of real money withdrawn against them.

test('coins that appear from nowhere cannot be withdrawn', async () => {
  // The account, as it actually was: one win on the profile, nothing else.
  const r = await check({ balance: 9990, wins: 1, losses: 0 });
  assert.equal(r.explainedBalance, 0, 'nothing in the ledger accounts for this');
  assert.equal(r.unexplained, 9990);
  assert.equal(r.withdrawable, 0,
    'a balance with no history was fully withdrawable after a single win');
});

test('a win on the profile is not a substitute for a ledger', async () => {
  // hasPlayed is the only gate a granted balance ever had to pass, and one win
  // clears it forever. It is an absolute gate, never an accounting of funds.
  const r = await check({ balance: 500, wins: 40, losses: 40 });
  assert.equal(r.hasPlayed, true, 'the old gate still passes');
  assert.equal(r.withdrawable, 0, 'and it must no longer be enough on its own');
});

test('only the unexplained part is held, not the whole balance', async () => {
  // Someone with a real history who is also holding granted coins keeps what
  // they earned. Freezing the lot would punish the wrong half.
  const r = await check({ balance: 300, deposits: [100], stakes: [100], matchWins: [150] });
  assert.equal(r.explainedBalance, 250);
  assert.equal(r.unexplained, 50);
  assert.equal(r.withdrawable, 250);
});

test('an admin grant is not explained money', async () => {
  // admin_adjustment is written both for grants and for removals with nothing
  // to tell them apart, so counting it would reopen the hole through the admin
  // panel. A grant that is meant to be withdrawable should be a deposit row.
  const m = load();
  const granted = {
    from(table) {
      const q = { filters: {} };
      const api = {
        select: () => api,
        eq: (c, v) => { q.filters[c] = v; return api; },
        gt: () => api,
        single: async () => ({ data: { c_coins: 10000, wins: 1, losses: 0 } }),
        maybeSingle: async () => ({ data: { rakeback_claimed_total: 0, affiliate_earnings_c: 0 }, error: null }),
        then: (res) => res({
          data: table === 'transactions'
            ? [{ type: 'admin_adjustment', amount_c: 10000 }]
            : [],
        }),
      };
      return api;
    },
  };
  const r = await m.getWithdrawable(granted, 'u');
  assert.equal(r.withdrawable, 0, 'an admin grant was treated as accounted-for money');
});

test('affiliate earnings are explained, and withdrawable', async () => {
  // Credited by an RPC that writes no transaction row; the running total lives
  // on the profile. Miss it and an affiliate's earnings look like money from
  // nowhere and get frozen — the false positive this control must not have.
  const r = await check({ balance: 40, affiliate: 40, rakeback: 0, stakes: [5] });
  assert.equal(r.lifetimeAffiliate, 40);
  assert.equal(r.unexplained, 0, 'affiliate earnings were treated as unaccounted');
  assert.equal(r.withdrawable, 40);
});

test('what a player is told when the balance does not reconcile', async () => {
  const m = load();
  const r = await m.getWithdrawable(db({ balance: 9990, wins: 1, losses: 0 }), 'u');
  const msg = m.playthroughMessage(r);
  assert.match(msg, /review/i, 'the refusal has to say something');
  // Not the shortfall. The exact number is a hint about how close a probe got,
  // and it belongs in the admin queue rather than on the player's screen.
  assert.doesNotMatch(msg, /9990|9,990/, 'the message quotes the unexplained amount back');
});

test('the check runs even with the playthrough switch off', async () => {
  // That switch relaxes a house policy. This one answers whether the money
  // exists at all, so it is not the same question and not the same switch.
  const m = load(false);
  const r = await m.getWithdrawable(db({ balance: 9990, wins: 1, losses: 0 }), 'u');
  assert.equal(r.withdrawable, 0, 'turning off playthrough re-opened the hole');
});

test('money already withdrawn does not keep explaining a balance', async () => {
  // Deposit 100, withdraw all 100, then be granted 50. Counting only the
  // credits leaves 100 of "explained" history sitting there with nothing
  // behind it, and the 50 walks straight back out — the same hole reached by
  // depositing and withdrawing once first.
  const r = await check({
    balance: 50, deposits: [100], withdrawals: [100], stakes: [100],
    matchWins: [], wins: 1, losses: 1,
  });
  assert.equal(r.ledgerOut, 100, 'the withdrawal was not counted against them');
  assert.equal(r.explainedBalance, 0);
  assert.equal(r.withdrawable, 0, 'a spent history was reused to explain new coins');
});

test('a partly reconciled balance still does not quote the shortfall', async () => {
  // The branch where the player CAN withdraw something. The earlier test only
  // exercised the fully blocked wording, so a leak here went unseen.
  const m = load();
  const r = await m.getWithdrawable(
    db({ balance: 300, deposits: [100], stakes: [100], matchWins: [150] }), 'u');
  assert.equal(r.unexplained, 50);
  assert.ok(r.withdrawable > 0, 'this test needs the partial branch');
  const msg = m.playthroughMessage(r);
  assert.match(msg, /withdraw \$250\.00 right now/, 'it must say what they CAN take');
  assert.doesNotMatch(msg, /\$50\.00/, 'the message quotes the unexplained amount back');
});
