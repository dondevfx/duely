#!/usr/bin/env node
/**
 * Balance / ledger reconciliation. READ-ONLY: it never writes anything.
 *
 *   railway run node backend/scripts/reconcile-ledger.js
 *
 * Checks, per account:
 *
 *   1. NEGATIVE BALANCE        c_coins or diamonds below zero.
 *   2. LEDGER MISMATCH         current balance != sum of balance_ledger deltas
 *                              (opening snapshot + every change since). The
 *                              trigger records every change atomically, so a
 *                              mismatch means the trigger was disabled or rows
 *                              were removed. Needs PENDING_SQL section 24.
 *   3. UNATTRIBUTED CHANGE     coins moved (balance_ledger) with no matching
 *                              app transaction row in the same window. Known
 *                              gaps (match escrow, tournament entry, rakeback)
 *                              appear here until they write rows of their own,
 *                              so this is a review list, not proof of fraud.
 *   4. DUPLICATE DEPOSIT       the same tx_hash credited as a deposit twice.
 *   5. STUCK WITHDRAWAL LOCK   a withdrawal_locks row older than 15 minutes.
 *
 * Exits 1 if any check in 1, 2, 4 or 5 finds something; 3 is reported only.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const PAGE = 1000;
const EPS = 0.005;

async function readAll(sb, table, cols, build = (q) => q) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(sb.from(table).select(cols)).range(from, from + PAGE - 1);
    if (error) return { rows: null, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows: out, error: null };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Pure: the checks, given rows. Exported for tests. */
function reconcile({ profiles = [], ledger = null, transactions = [], locks = [], now = Date.now() }) {
  const findings = { negative: [], mismatch: [], unattributed: [], duplicateDeposits: [], stuckLocks: [] };

  for (const p of profiles) {
    if ((Number(p.c_coins) || 0) < -EPS || (Number(p.diamonds) || 0) < 0) {
      findings.negative.push({ id: p.id, c_coins: p.c_coins, diamonds: p.diamonds });
    }
  }

  if (ledger) {
    const sums = new Map();
    for (const r of ledger) {
      const s = sums.get(r.user_id) || { coins: 0, diamonds: 0 };
      s.coins += Number(r.coins_delta) || 0;
      s.diamonds += Number(r.diamonds_delta) || 0;
      sums.set(r.user_id, s);
    }
    for (const p of profiles) {
      const s = sums.get(p.id);
      if (!s) { findings.mismatch.push({ id: p.id, reason: 'no ledger rows (no opening snapshot)' }); continue; }
      const dc = round2((Number(p.c_coins) || 0) - s.coins);
      const dd = (Number(p.diamonds) || 0) - s.diamonds;
      if (Math.abs(dc) > EPS || dd !== 0) {
        findings.mismatch.push({ id: p.id, balance: p.c_coins, ledgerCoins: round2(s.coins), coinsOff: dc, diamondsOff: dd });
      }
    }

    // Coins moved per user (non-opening ledger rows) vs coins the app recorded.
    const moved = new Map();
    for (const r of ledger) {
      if (r.kind === 'opening') continue;
      moved.set(r.user_id, (moved.get(r.user_id) || 0) + (Number(r.coins_delta) || 0));
    }
    const CREDIT = new Set(['deposit', 'match_win', 'match_draw', 'match_refund', 'tip_received', 'rewards_spin', 'referral_bonus', 'daily_bonus', 'affiliate_payout', 'rakeback_claim', 'tournament_refund']);
    const DEBIT  = new Set(['withdrawal', 'match_loss', 'tip_sent', 'tournament_entry']);
    const recorded = new Map();
    for (const t of transactions) {
      const amt = Number(t.amount_c) || 0;
      // Tournament settlement writes a match_loss per losing entrant for the
      // P&L; the entry itself is already the tournament_entry row, so that one
      // is not counted a second time.
      if (t.type === 'match_loss' && t.notes === 'Tournament entry') continue;
      const sign = CREDIT.has(t.type) ? 1 : DEBIT.has(t.type) ? -1 : 0;
      if (!sign) continue;
      recorded.set(t.user_id, (recorded.get(t.user_id) || 0) + sign * amt);
    }
    for (const [uid, m] of moved) {
      const diff = round2(m - (recorded.get(uid) || 0));
      if (Math.abs(diff) > EPS) findings.unattributed.push({ id: uid, ledgerMoved: round2(m), recorded: round2(recorded.get(uid) || 0), diff });
    }
  }

  const seenHash = new Map();
  for (const t of transactions) {
    if (t.type !== 'deposit' || !t.tx_hash) continue;
    const k = `${t.tx_hash}`;
    seenHash.set(k, (seenHash.get(k) || 0) + 1);
  }
  for (const [hash, n] of seenHash) if (n > 1) findings.duplicateDeposits.push({ tx_hash: hash, times: n });

  for (const l of locks) {
    if (now - Date.parse(l.created_at) > 15 * 60 * 1000) findings.stuckLocks.push(l);
  }
  return findings;
}

module.exports = { reconcile };

if (require.main === module) {
  (async () => {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are needed.'); process.exit(1); }
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const profiles = await readAll(sb, 'profiles', 'id, c_coins, diamonds');
    if (profiles.error) { console.error('profiles:', profiles.error.message); process.exit(1); }
    const ledger = await readAll(sb, 'balance_ledger', 'user_id, coins_delta, diamonds_delta, kind', (q) => q.order('id'));
    const txs = await readAll(sb, 'transactions', 'user_id, type, amount_c, tx_hash, status, notes', (q) => q.neq('status', 'failed'));
    const locks = await readAll(sb, 'withdrawal_locks', 'user_id, created_at');

    if (ledger.error) console.log('\n(balance_ledger not readable — run PENDING_SQL section 24. Checks 2 and 3 skipped.)');
    if (locks.error) console.log('(withdrawal_locks not readable — run PENDING_SQL section 25. Check 5 skipped.)');

    const f = reconcile({
      profiles: profiles.rows, ledger: ledger.error ? null : ledger.rows,
      transactions: txs.rows || [], locks: locks.error ? [] : locks.rows,
    });
    const show = (title, list, n = 20) => {
      console.log(`\n${title}: ${list.length}`);
      for (const x of list.slice(0, n)) console.log('  ', JSON.stringify(x));
      if (list.length > n) console.log(`   … ${list.length - n} more`);
    };
    console.log(`\nReconciled ${profiles.rows.length} accounts, ${txs.rows?.length ?? 0} transactions` +
      (ledger.error ? '' : `, ${ledger.rows.length} ledger rows`));
    show('1. Negative balances', f.negative);
    show('2. Balance != ledger', f.mismatch);
    show('3. Coins moved with no matching transaction row (review)', f.unattributed);
    show('4. Duplicate deposits', f.duplicateDeposits);
    show('5. Stuck withdrawal locks', f.stuckLocks);
    const hard = f.negative.length + f.mismatch.length + f.duplicateDeposits.length + f.stuckLocks.length;
    console.log(hard ? `\n${hard} problem(s) need attention.\n` : '\nNo hard problems found.\n');
    process.exit(hard ? 1 : 0);
  })().catch((e) => { console.error('reconcile failed:', e.message); process.exit(1); });
}
