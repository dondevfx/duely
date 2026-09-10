#!/usr/bin/env node
/**
 * Does every balance add up from its own history?
 *
 * Read-only, and safe against production. It rebuilds what each account's
 * balance SHOULD be from the ledger — credits in, debits out, stakes wagered —
 * and reports every account where the number on the profile disagrees.
 *
 * This is the check the original incident would have failed loudly. An account
 * held 9,990 coins with no transaction row behind them: the balance said one
 * thing, the ledger said another, and nothing anywhere compared the two. The
 * grants that allowed it are closed now (scripts/check-anon-access.js proves
 * that), but "the hole is closed" and "no money was created" are different
 * claims, and only this one answers the second.
 *
 * A discrepancy is not proof of fraud. Match stakes are taken with deduct_coins
 * and write no transaction row of their own — they are recovered from the
 * matches table — so an account with unusual history can drift a little. The
 * point is the SIZE and the DIRECTION: a large positive drift means coins
 * exist that nothing accounts for, and that is the shape of a mint.
 *
 *   railway run node backend/scripts/reconcile-balances.js
 *   railway run node backend/scripts/reconcile-balances.js --limit 5000
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { applyEvents, CREDIT_SOURCES, DEBIT_TYPES } = require('../src/services/coinLots');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('\n  SUPABASE_URL and SUPABASE_SERVICE_KEY are needed.\n');
  process.exit(1);
}
const sb = createClient(url, key);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const LIMIT = arg('--limit', 2000);
// Below this, a difference is rounding and match-stake inference rather than a
// finding. Above it, somebody should look.
const TOLERANCE = arg('--tolerance', 0.5);

(async () => {
  console.log('\nReconciling balances against the ledger\n' + '─'.repeat(56));

  const { data: profiles, error } = await sb
    .from('profiles')
    .select('id, username, c_coins')
    .order('c_coins', { ascending: false })
    .limit(LIMIT);
  if (error) { console.error('could not read profiles:', error.message); process.exit(1); }

  const [{ data: txs }, { data: p1 }, { data: p2 }] = await Promise.all([
    sb.from('transactions').select('user_id, type, amount_c, crypto_symbol, created_at')
      .eq('status', 'confirmed').limit(100000),
    sb.from('matches').select('player1_id, entry_fee_c, played_at').gt('entry_fee_c', 0).limit(100000),
    sb.from('matches').select('player2_id, entry_fee_c, played_at').gt('entry_fee_c', 0).limit(100000),
  ]);

  const byUser = new Map();
  const push = (uid, ev) => {
    if (!uid) return;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(ev);
  };
  const at = (v) => new Date(v || 0).getTime();

  // Two types the WITHDRAWAL model deliberately ignores, which this one must
  // not. coinLots decides what may leave the platform, and treating an
  // admin-granted coin as unexplained there is the strict, correct answer.
  // Here the question is different — "does the balance add up?" — and a
  // hand-adjustment that is recorded in the ledger adds up perfectly well.
  // Leaving them out made the admin account look like it had minted a
  // thousand coins, which is exactly the false positive that gets a real one
  // ignored.
  const EXTRA_SIGNED = new Set(['admin_adjustment', 'fee_collection']);
  const unknown = new Map();

  for (const r of txs || []) {
    if (r.crypto_symbol === 'diamonds') continue;      // not coins
    const amount = parseFloat(r.amount_c) || 0;
    if (EXTRA_SIGNED.has(r.type)) {
      // Signed: an adjustment can be a debit, and is written as a negative.
      if (amount === 0) continue;
      push(r.user_id, amount > 0
        ? { at: at(r.created_at), kind: 'credit', amount, source: r.type }
        : { at: at(r.created_at), kind: 'debit', amount: -amount });
      continue;
    }
    if (!(amount > 0)) continue;
    if (CREDIT_SOURCES[r.type]) push(r.user_id, { at: at(r.created_at), kind: 'credit', amount, source: r.type });
    else if (DEBIT_TYPES.has(r.type)) push(r.user_id, { at: at(r.created_at), kind: 'debit', amount });
    else if (r.type !== 'match_loss') unknown.set(r.type, (unknown.get(r.type) || 0) + 1);
  }

  // A type nobody has modelled is a hole in this report, not a clean result.
  if (unknown.size) {
    console.log('\n  Transaction types this report does not model:');
    for (const [t, n] of unknown) console.log(`    ${t} (${n} rows) — drift below may be wrong`);
  }
  for (const m of p1 || []) push(m.player1_id, { at: at(m.played_at), kind: 'wager', amount: parseFloat(m.entry_fee_c) || 0 });
  for (const m of p2 || []) push(m.player2_id, { at: at(m.played_at), kind: 'wager', amount: parseFloat(m.entry_fee_c) || 0 });

  const findings = [];
  let checked = 0;
  for (const p of profiles || []) {
    const balance = parseFloat(p.c_coins) || 0;
    const events = byUser.get(p.id) || [];
    if (balance === 0 && events.length === 0) continue;
    checked++;

    const lots = applyEvents(events);
    // What the ledger says should be there: every credit, less every debit.
    // Stakes are not subtracted here — a wager leaves and (win or lose) is
    // accounted for by the match_win/match_loss rows that follow it.
    const explained = events.reduce((sum, e) => {
      if (e.kind === 'credit') return sum + e.amount;
      if (e.kind === 'debit')  return sum - e.amount;
      return sum;
    }, 0);

    const drift = Math.round((balance - explained) * 10000) / 10000;
    if (Math.abs(drift) > TOLERANCE) {
      findings.push({ id: p.id, username: p.username, balance, explained: Math.round(explained * 10000) / 10000, drift, events: events.length, owed: lots.owed });
    }
  }

  findings.sort((a, b) => b.drift - a.drift);

  console.log(`\nAccounts checked: ${checked}`);
  console.log(`Outside ±${TOLERANCE}: ${findings.length}\n`);

  if (findings.length) {
    console.log('  drift      balance   explained  events  account');
    for (const f of findings.slice(0, 40)) {
      const flag = f.drift > TOLERANCE ? '  <-- unexplained coins' : '';
      console.log(
        `  ${String(f.drift).padStart(9)}  ${String(f.balance).padStart(9)}  ` +
        `${String(f.explained).padStart(9)}  ${String(f.events).padStart(6)}  ` +
        `${(f.username || f.id).slice(0, 24)}${flag}`);
    }
    if (findings.length > 40) console.log(`  … and ${findings.length - 40} more`);
    const minted = findings.filter(f => f.drift > TOLERANCE);
    const total = minted.reduce((s, f) => s + f.drift, 0);
    console.log(`\n  ${minted.length} account(s) hold ${Math.round(total * 100) / 100} coins the ledger cannot account for.`);
  } else {
    console.log('  Every balance matches its ledger within tolerance.');
  }

  console.log('\n' + '─'.repeat(56));
  // Positive drift is the one that matters: coins that exist and should not.
  // Negative drift means an account is missing coins it was owed, which is a
  // support issue rather than a security one.
  process.exit(findings.some(f => f.drift > TOLERANCE) ? 1 : 0);
})().catch((e) => { console.error('\nreconcile failed:', e.message, '\n'); process.exit(1); });
