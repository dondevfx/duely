// Every coin, and whether it has been wagered.
//
// The aggregate rule says how MUCH of a balance may leave. This says WHICH
// coins may: money arrives in lots, each knowing what it is and what it owes,
// wagers pay obligations down oldest-first, and withdrawals spend oldest-first.
//
// The arithmetic is a pure function so it can be tested without a database,
// which is the half that has to be right.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEvents, getCoinLots, CREDIT_SOURCES, DEBIT_TYPES } = require('../src/services/coinLots');

// Events in the order they happened. `at` is just an ordering number.
const credit = (at, amount, source) => ({ at, kind: 'credit', amount, source });
const wager  = (at, amount) => ({ at, kind: 'wager',  amount });
const debit  = (at, amount) => ({ at, kind: 'debit',  amount });

// ── What each kind of money owes ───────────────────────────────────────────

test('a deposit is locked until it is wagered', () => {
  const r = applyEvents([credit(1, 20, 'deposit')]);
  assert.equal(r.free, 0, 'a deposit was free the moment it landed');
  assert.equal(r.lockedCoins, 20);
  assert.equal(r.owed, 20);
});

test('wagering it in full clears what it owed', () => {
  // The stake leaves the balance when the match starts, so the deposit lot is
  // spent by the act of wagering it. What comes back is a win, and a win is
  // free — which is the whole point of playing it through.
  const r = applyEvents([credit(1, 20, 'deposit'), wager(2, 20)]);
  assert.equal(r.owed, 0, 'the obligation must be paid off');
  assert.equal(r.remaining, 0, 'the stake is with the house until the match settles');

  const won = applyEvents([credit(1, 20, 'deposit'), wager(2, 20), credit(3, 38, 'match_win')]);
  assert.equal(won.free, 38, 'the winnings must come back free');
});

test('wagering half frees none of it', () => {
  // A lot is free or it is not. Half a played-through deposit is not half
  // withdrawable — the requirement is on the lot, and it has not been met.
  const r = applyEvents([credit(1, 20, 'deposit'), wager(2, 10)]);
  assert.equal(r.owed, 10, 'half the requirement is still outstanding');
  assert.equal(r.free, 0, 'a partly wagered deposit released coins');
  assert.equal(r.remaining, 10, 'ten went in as the stake');
  assert.equal(r.lockedCoins, 10);
});

test('winnings never owe anything', () => {
  const r = applyEvents([credit(1, 30, 'match_win')]);
  assert.equal(r.owed, 0);
  assert.equal(r.free, 30, 'a win was locked, and it was never at risk of that');
});

test('tips and wheel prizes owe, draws and refunds do not', () => {
  for (const [source, shouldOwe] of [
    ['tip_received', true], ['rewards_spin', true], ['deposit', true],
    ['match_win', false], ['match_draw', false], ['match_refund', false],
    ['referral_bonus', false], ['daily_bonus', false],
  ]) {
    const r = applyEvents([credit(1, 10, source)]);
    assert.equal(r.owed > 0, shouldOwe,
      `${source} ${shouldOwe ? 'must carry' : 'must not carry'} a playthrough obligation`);
  }
});

test('an unknown credit type is assumed to owe', () => {
  // Failing the other way would make any type added later withdrawable on
  // arrival, which is the whole class of bug this is here for.
  const r = applyEvents([credit(1, 10, 'some_new_kind_of_credit')]);
  assert.equal(r.owed, 10);
  assert.equal(r.free, 0);
});

test('an admin grant is not a credit at all', () => {
  // Written for grants and removals with nothing to tell them apart. Counting
  // it would let a grant be withdrawn, which is the hole this exists to close.
  const r = applyEvents([credit(1, 10000, 'admin_adjustment')]);
  assert.equal(r.remaining, 10000,
    'an unrecognised type must still be tracked, not dropped');
  assert.equal(r.free, 0, 'an admin grant was withdrawable');
});

// ── Which coins a wager pays for, and which a withdrawal spends ────────────

test('a wager pays down the oldest obligation first', () => {
  const r = applyEvents([
    credit(1, 10, 'deposit'),
    credit(2, 10, 'deposit'),
    wager(3, 10),
  ]);
  // The older lot pays the obligation AND provides the stake, so it is gone.
  // What is left is the second deposit, still owing.
  assert.equal(r.owed, 10, 'the newer deposit still owes');
  assert.equal(r.remaining, 10);
  assert.equal(r.lots.length, 1, 'the spent lot should be gone');
  assert.equal(r.lots[0].owed, 10, 'the wrong lot was released');
});

test('a withdrawal spends free coins, oldest first — never a locked one', () => {
  // The obligation is on the LOT. Plain oldest-first let a withdrawal consume
  // a locked deposit and leave the free winnings standing, so the obligation
  // outlived the coins it was attached to and the ledger read 30 free where
  // the aggregate read 10.
  const r = applyEvents([
    credit(1, 20, 'deposit'),      // older, and locked
    credit(2, 30, 'match_win'),    // newer, and free
    debit(3, 20),
  ]);
  assert.equal(r.remaining, 30, 'twenty should have left');
  assert.equal(r.owed, 20, 'the deposit still owes, because it is still here');
  assert.equal(r.free, 10, 'it spent the winnings, leaving the locked deposit');
  const deposit = r.lots.find(l => l.source === 'deposit');
  assert.equal(deposit.remaining, 20, 'the locked deposit was spent by a withdrawal');

  // Among free lots it IS oldest-first.
  const two = applyEvents([
    credit(1, 10, 'match_win'),
    credit(2, 10, 'match_draw'),
    debit(3, 10),
  ]);
  assert.equal(two.lots.length, 1);
  assert.equal(two.lots[0].source, 'draw', 'the newer free lot was spent first');
});

test('wagering before the money arrives still counts toward it', () => {
  // Wager, lose it all, deposit again. The aggregate rule never made someone
  // re-wager money they had already played through in total, and this must not
  // start: the requirement is a lifetime total, not a per-lot race.
  const r = applyEvents([
    credit(1, 20, 'deposit'),
    wager(2, 20),            // staked it and lost — the stake left here
    credit(3, 20, 'deposit'),
  ]);
  assert.equal(r.owed, 20, 'the second deposit carries its own requirement');
  // And wagering beyond what is owed carries forward to the next lot: play
  // through a deposit, win, keep playing, then deposit again — the surplus
  // wagering already covers it.
  const r2 = applyEvents([
    credit(1, 10, 'deposit'),
    wager(2, 10), credit(3, 19, 'match_win'),
    wager(4, 19), credit(5, 36, 'match_win'),   // 19 of wagering owed to nothing
    credit(6, 10, 'deposit'),
  ]);
  assert.equal(r2.owed, 0, 'wagering ahead must carry forward');
  assert.equal(r2.free, 46, 'the new deposit lands already played through');
});

test('a losing match takes the stake and gives nothing back', () => {
  // No match_loss row is counted: the stake left when the match started, and
  // counting the loss as well would take it twice. That double count is what
  // made the ledger read higher than the balance on every account that played.
  const r = applyEvents([
    credit(1, 20, 'deposit'),
    wager(2, 5),
  ]);
  assert.equal(r.remaining, 15, 'the stake left once, not twice');
  assert.equal(r.owed, 15, 'and it paid off five of the requirement');
});

// ── The shapes that break naive arithmetic ─────────────────────────────────

test('money out with no lot behind it is reported, not ignored', () => {
  // Withdrawing against a balance the history cannot explain. The lots go to
  // zero and the excess is counted rather than silently absorbed.
  const r = applyEvents([debit(1, 10)]);
  assert.equal(r.remaining, 0);
  assert.equal(r.free, 0);
  assert.equal(r.unmatchedDebit, 10);
});

test('a balance from nowhere frees nothing', () => {
  // The account that started all of this: 9,990 coins, one win on the profile,
  // and no credit row of any kind.
  const r = applyEvents([wager(1, 5)]);
  assert.equal(r.free, 0, 'coins with no lot behind them were withdrawable');
  assert.equal(r.remaining, 0);
});

test('fractions do not drift', () => {
  // Rakeback and affiliate shares are four-decimal numbers, and a hundred of
  // them summed with plain floats leaves a balance that never quite reaches
  // zero — which would leave a lot permanently, invisibly locked.
  const events = [credit(1, 0.0001, 'match_win')];
  for (let i = 0; i < 100; i++) events.push(credit(i + 2, 0.0001, 'match_win'));
  const r = applyEvents(events);
  assert.equal(r.remaining, 0.0101);
  assert.equal(r.free, 0.0101);

  const spend = applyEvents([...events, debit(999, 0.0101)]);
  assert.equal(spend.remaining, 0, `left ${spend.remaining} behind`);
});

test('events are applied in time order, not the order they were fetched', () => {
  // Transactions and matches come from separate queries; concatenated, every
  // wager lands after every credit and every debit lands wherever its query
  // happened to sit.
  //
  // Wagers alone cannot show this — wagering carries forward, so paying an
  // obligation before or after the lot arrives lands in the same place. A
  // DEBIT can: money that left BEFORE a win arrived did not spend that win.
  const jumbled = [
    credit(2, 20, 'match_win'),   // arrived second
    debit(1, 20),                 // but this went out first
  ];
  const r = applyEvents(jumbled);
  assert.equal(r.remaining, 20,
    'a debit was applied to a lot that did not exist yet, spending it early');
  assert.equal(r.unmatchedDebit, 20,
    'and the money that left with nothing behind it went unreported');

  // The other way round is the ordinary case: win, then spend it.
  const after = applyEvents([credit(1, 20, 'match_win'), debit(2, 20)]);
  assert.equal(after.remaining, 0);
  assert.equal(after.unmatchedDebit, 0);
});

test('zero and negative amounts are skipped, not applied', () => {
  const r = applyEvents([
    credit(1, 0, 'deposit'), credit(2, -5, 'deposit'), credit(3, 10, 'match_win'),
  ]);
  assert.equal(r.lots.length, 1);
  assert.equal(r.remaining, 10);
});

// ── The whole rule, on the scenarios that were asked for ───────────────────

test("deposit $20, wager it, win: everything comes out", () => {
  const r = applyEvents([
    credit(1, 20, 'deposit'), wager(2, 20), credit(3, 38, 'match_win'),
  ]);
  assert.equal(r.free, 38);
  assert.equal(r.owed, 0);
});

test('deposit $20, two $5 games won: the unwagered part stays', () => {
  const r = applyEvents([
    credit(1, 20, 'deposit'),
    wager(2, 5), credit(3, 9.5, 'match_win'),
    wager(4, 5), credit(5, 9.5, 'match_win'),
  ]);
  // 10 staked and returned as 19 of winnings; 10 of the deposit is untouched
  // and still owes.
  assert.equal(r.owed, 10, 'the unwagered half still owes');
  assert.equal(r.free, 19, 'the winnings must be reachable');
  assert.equal(r.lockedCoins, 10);
  assert.equal(r.remaining, 29);
});

test('tipped coins are locked on the account that receives them', () => {
  const r = applyEvents([credit(1, 20, 'tip_received')]);
  assert.equal(r.free, 0);
  const played = applyEvents([
    credit(1, 20, 'tip_received'), wager(2, 20), credit(3, 38, 'match_win'),
  ]);
  assert.equal(played.owed, 0, 'wagering the tip must clear it');
  assert.equal(played.free, 38);
});

// ── Reading a real account ─────────────────────────────────────────────────
//
// applyEvents is the arithmetic; getCoinLots decides which rows become which
// events. Everything above tests the first, so a mistake in the second — a
// row counted as the wrong kind — goes unseen.

function db({ rows = [], stakes = [], affiliate = 0, rakeback = 0 }) {
  return {
    from(table) {
      const f = {};
      const chain = {
        select: () => chain,
        eq: (c, v) => { f[c] = v; return chain; },
        gt: () => Promise.resolve({
          data: f.player1_id ? stakes.map(a => ({ entry_fee_c: a, played_at: '2020-01-02' })) : [],
        }),
        maybeSingle: async () => ({
          data: { affiliate_earnings_c: affiliate, rakeback_claimed_total: rakeback }, error: null,
        }),
        then: (res) => Promise.resolve({ data: table === 'transactions' ? rows : [] }).then(res),
      };
      return chain;
    },
  };
}

test('a losing stake is taken once, not twice', async () => {
  // The stake leaves when the match STARTS and writes no row; only the loss is
  // written afterwards. Counting match_loss as a debit as well takes it twice,
  // and every account that had played read lower than its balance.
  assert.ok(!DEBIT_TYPES.has('match_loss'),
    'match_loss must not be a debit — the wager already took the stake');

  const r = await getCoinLots(db({
    rows: [
      { type: 'deposit',    amount_c: 20, created_at: '2020-01-01' },
      { type: 'match_loss', amount_c: 5,  created_at: '2020-01-03' },
    ],
    stakes: [5],
  }), 'u');
  assert.equal(r.remaining, 15, 'five left the balance once');
  assert.equal(r.owed, 15, 'and paid off five of the requirement');
});

test('a winning match nets out to the payout minus the stake', async () => {
  const r = await getCoinLots(db({
    rows: [
      { type: 'deposit',   amount_c: 10, created_at: '2020-01-01' },
      { type: 'match_win', amount_c: 19, created_at: '2020-01-03' },
    ],
    stakes: [10],
  }), 'u');
  assert.equal(r.remaining, 19, 'ten out as the stake, nineteen back as the win');
  assert.equal(r.owed, 0);
  assert.equal(r.free, 19);
});

test('diamond rows are not coins, whatever amount_c says', async () => {
  // Diamond rows carry the prize on crypto_amount and leave amount_c at 0
  // today, so a row shaped like that proves nothing — it is skipped for being
  // zero either way. The symbol check is what protects against amount_c ever
  // being filled in for a diamond movement, which would mint coin lots out of
  // a currency that cannot be withdrawn at all.
  const r = await getCoinLots(db({
    rows: [{ type: 'tip_received', amount_c: 500, crypto_amount: 500,
             crypto_symbol: 'diamonds', created_at: '2020-01-01' }],
  }), 'u');
  assert.equal(r.remaining, 0, 'a diamond tip added coin lots');
  assert.equal(r.lots.length, 0);
});

test('affiliate earnings are free, claimed rakeback is not', async () => {
  // Both are credited by RPCs that write no transaction row, so both are read
  // from the profile. Rakeback is a rebate and has to be played through;
  // affiliate is a share of other people's rake, already played through by
  // whoever paid it.
  const aff = await getCoinLots(db({ affiliate: 40 }), 'u');
  assert.equal(aff.free, 40, 'affiliate earnings were locked');

  const rb = await getCoinLots(db({ rakeback: 40 }), 'u');
  assert.equal(rb.free, 0, 'claimed rakeback was withdrawable without being played');
  assert.equal(rb.owed, 40);
});

test('an admin grant reaches the ledger as coins that owe everything', async () => {
  const r = await getCoinLots(db({
    rows: [{ type: 'admin_adjustment', amount_c: 10000, created_at: '2020-01-01' }],
  }), 'u');
  assert.equal(r.free, 0, 'a granted balance was withdrawable');
});
