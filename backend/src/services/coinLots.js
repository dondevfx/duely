/**
 * Every coin, and whether it has been wagered.
 *
 * The playthrough rule was an aggregate: how much came in that carries a
 * requirement, minus how much has been wagered, held back off the balance. It
 * answers "how much of this balance may leave" correctly, but it cannot say
 * WHICH coins are free and which are not, so it cannot show its working — and
 * on an account holding a deposit and winnings at once, it cannot tell you
 * which half is which.
 *
 * This is the per-coin version. Money arrives in LOTS. A lot knows what it is,
 * what it cost to unlock, and how much of it is left:
 *
 *   deposit  $20   obligation $20   ← must be wagered before it can leave
 *   win      $9    obligation $0    ← never carried one
 *   tip      $5    obligation $5
 *
 * Wagers pay down obligations oldest-first. Withdrawals and losses spend
 * remaining coins oldest-first. What may be withdrawn is the sum of what is
 * left in lots whose obligation is met.
 *
 * DERIVED, NOT STORED. Every lot is rebuilt from the transaction history on
 * each check rather than kept in a table and mutated. A stored ledger is one
 * missed increment away from being wrong in a direction nobody can see, and
 * that is exactly the failure this whole area is recovering from — a balance
 * written straight onto a profile with no record behind it. History cannot
 * drift from itself.
 *
 * It also means no money path has to be changed to feed it. There are eighteen
 * places that credit or debit coins; a stored ledger needs all eighteen to
 * remember, and the one that forgets is silent.
 */

// What a credit row is, and whether that kind of money has to be played
// through before it can be withdrawn.
//
// Deposits, tips and wheel prizes are money that arrived without being risked.
// Winnings, draws and refunds were already at stake — they carried no
// obligation under the aggregate rule either, and must not gain one here.
const CREDIT_SOURCES = {
  deposit:        { label: 'deposit',  playthrough: true  },
  tip_received:   { label: 'tip',      playthrough: true  },
  rewards_spin:   { label: 'spin',     playthrough: true  },
  match_win:      { label: 'win',      playthrough: false },
  match_draw:     { label: 'draw',     playthrough: false },
  match_refund:   { label: 'refund',   playthrough: false },
  referral_bonus: { label: 'referral', playthrough: false },
  daily_bonus:    { label: 'bonus',    playthrough: false },
};

// Money leaving. Spends the oldest coins first.
//
// match_loss is NOT here, and that is the whole of the double-entry. A match
// takes the stake out of the balance when it STARTS, and writes no row for it;
// only the loss is written afterwards. So the stake leaving is modelled by the
// wager event itself, and counting match_loss as well would take it twice.
//
// It balances out as:
//   win    stake out at the wager, gross payout back in as match_win
//   loss   stake out at the wager, nothing back
//   draw   stake out at the wager, stake back in as match_draw
//
// Without it, every win credited its gross payout against no debit at all, and
// the ledger read higher than the balance on every account that had played —
// 16.13 of "free" coins against a 6.51 balance on one of them.
const DEBIT_TYPES = new Set(['withdrawal', 'tip_sent']);

// admin_adjustment is deliberately neither. It is written for grants and for
// removals with nothing to tell them apart, so counting it as a credit would
// let an admin grant be withdrawn — the hole this all exists to close. A grant
// meant to be withdrawable should be written as a deposit.

const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * The lot ledger, from a list of events in time order.
 *
 * Pure, so the arithmetic can be tested without a database — which is the half
 * that has to be right.
 *
 * Each event is { at, kind: 'credit'|'wager'|'debit', amount, source }.
 */
function applyEvents(events) {
  const lots = [];
  let unmatchedDebit = 0;   // money out with no lot to take it from
  let wagerCarry = 0;       // wagering with nothing left to pay down

  const ordered = [...events].sort((a, b) => (a.at || 0) - (b.at || 0));

  for (const e of ordered) {
    const amount = round(e.amount);
    if (!(amount > 0)) continue;

    if (e.kind === 'credit') {
      const src = CREDIT_SOURCES[e.source] || { label: e.source, playthrough: true };
      lots.push({
        source:    src.label,
        at:        e.at,
        amount,
        remaining: amount,
        // The obligation is the size of the lot, and is paid down by wagering.
        owed:      src.playthrough ? amount : 0,
      });
      // Wagering that happened before this lot existed still counts toward it.
      // A player who wagers, loses, and deposits again should not have to
      // re-wager money they have already played through in total — the
      // aggregate rule never made them, and this must not start.
      if (wagerCarry > 0 && lots[lots.length - 1].owed > 0) {
        const lot = lots[lots.length - 1];
        const pay = Math.min(lot.owed, wagerCarry);
        lot.owed = round(lot.owed - pay);
        wagerCarry = round(wagerCarry - pay);
      }
      continue;
    }

    if (e.kind === 'wager') {
      // Two things at once: it pays down obligations, and the stake itself
      // leaves the balance.
      let left = amount;
      for (const lot of lots) {
        if (left <= 0) break;
        if (lot.owed <= 0) continue;
        const pay = Math.min(lot.owed, left);
        lot.owed = round(lot.owed - pay);
        left = round(left - pay);
      }
      wagerCarry = round(wagerCarry + left);

      let stake = amount;
      for (const lot of lots) {
        if (stake <= 0) break;
        if (lot.remaining <= 0) continue;
        const take = Math.min(lot.remaining, stake);
        lot.remaining = round(lot.remaining - take);
        stake = round(stake - take);
      }
      unmatchedDebit = round(unmatchedDebit + stake);
      continue;
    }

    if (e.kind === 'debit') {
      // A withdrawal can only ever spend FREE coins — it is the one movement
      // the obligation exists to stop. Oldest-first among those.
      //
      // Not oldest-first overall: a deposit sitting locked beside winnings is
      // the older lot, so plain FIFO let a withdrawal consume the locked
      // deposit and leave the free winnings behind. The obligation then
      // outlived the coins it was attached to, and the ledger read 30 free
      // where the aggregate read 10.
      //
      // A wager is the opposite case and is handled above: staking locked
      // coins is exactly how they are played through.
      let left = amount;
      for (const lot of lots) {
        if (left <= 0) break;
        if (lot.remaining <= 0 || lot.owed > 0) continue;
        const take = Math.min(lot.remaining, left);
        lot.remaining = round(lot.remaining - take);
        left = round(left - take);
      }
      // Anything a withdrawal could not take from a free lot is money that
      // left without being entitled to — either history this cannot see, or a
      // withdrawal that predates the rule.
      unmatchedDebit = round(unmatchedDebit + left);
    }
  }

  const remaining   = round(lots.reduce((s, l) => s + l.remaining, 0));
  // Free coins are what is left in lots that owe nothing.
  const free        = round(lots.reduce((s, l) => s + (l.owed <= 0 ? l.remaining : 0), 0));
  const lockedCoins = round(remaining - free);
  const owed        = round(lots.reduce((s, l) => s + l.owed, 0));

  return {
    lots: lots.filter(l => l.remaining > 0 || l.owed > 0),
    remaining, free, lockedCoins, owed, unmatchedDebit, wagerCarry,
  };
}

/**
 * The same, for a real account.
 *
 * Affiliate earnings and claimed rakeback are read from the profile because
 * both are credited by RPCs that write no transaction row. They enter as one
 * lot each, dated at the beginning, since there is no per-payment history to
 * order them by. Rakeback carries a playthrough obligation — it is a rebate,
 * not a win. Affiliate earnings do not: they are a share of other people's
 * rake, which was already played through by whoever paid it.
 */
async function getCoinLots(supabase, userId) {
  const [{ data: rows }, { data: p1 }, { data: p2 }, { data: prof }] = await Promise.all([
    supabase.from('transactions')
      .select('type, amount_c, crypto_symbol, created_at')
      .eq('user_id', userId).eq('status', 'confirmed'),
    supabase.from('matches').select('entry_fee_c, played_at')
      .eq('player1_id', userId).gt('entry_fee_c', 0),
    supabase.from('matches').select('entry_fee_c, played_at')
      .eq('player2_id', userId).gt('entry_fee_c', 0),
    // Separately, and allowed to fail: a column that does not exist yet makes
    // PostgREST reject the whole query.
    supabase.from('profiles').select('affiliate_earnings_c, rakeback_claimed_total')
      .eq('id', userId).maybeSingle(),
  ]);

  const events = [];
  const t = (v) => new Date(v || 0).getTime();

  for (const r of rows || []) {
    if (r.crypto_symbol === 'diamonds') continue;   // not withdrawable, not coins
    const amount = parseFloat(r.amount_c) || 0;
    if (!(amount > 0)) continue;
    if (CREDIT_SOURCES[r.type]) {
      events.push({ at: t(r.created_at), kind: 'credit', amount, source: r.type });
    } else if (DEBIT_TYPES.has(r.type)) {
      events.push({ at: t(r.created_at), kind: 'debit', amount });
    }
  }

  for (const m of [...(p1 || []), ...(p2 || [])]) {
    events.push({ at: t(m.played_at), kind: 'wager', amount: parseFloat(m.entry_fee_c) || 0 });
  }

  const affiliate = parseFloat(prof?.affiliate_earnings_c) || 0;
  const rakeback  = parseFloat(prof?.rakeback_claimed_total) || 0;
  if (affiliate > 0) events.push({ at: 0, kind: 'credit', amount: affiliate, source: 'referral_bonus' });
  if (rakeback  > 0) events.push({ at: 0, kind: 'credit', amount: rakeback,  source: 'rewards_spin' });

  return applyEvents(events);
}

module.exports = { applyEvents, getCoinLots, CREDIT_SOURCES, DEBIT_TYPES };
