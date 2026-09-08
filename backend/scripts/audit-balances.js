#!/usr/bin/env node
/**
 * Where every coin balance came from, and how much of it may leave.
 *
 * Read-only. It runs the real getWithdrawable against every account, so what
 * it prints is what the withdrawal endpoint would decide this second — not a
 * second implementation that can drift from it.
 *
 *   railway run node backend/scripts/audit-balances.js
 *
 * Two numbers per account matter:
 *
 *   unexplained   balance the ledger cannot account for. Deposits, winnings,
 *                 draws, tips in, wheel prizes, referral and daily bonuses and
 *                 escrow refunds, plus affiliate earnings and claimed rakeback
 *                 from the profile, minus what has gone out again. Anything
 *                 above that arrived by a route that leaves no record, and is
 *                 not withdrawable. An account showed 9,990 of it and withdrew
 *                 $10 of real money before this existed.
 *
 *   unwagered     the part of what came in that still has to be played through
 *                 before it can be withdrawn. Deposits, tips, wheel prizes and
 *                 claimed rakeback all carry it; winnings never did.
 *
 * Exits non-zero if any account holds unexplained coins, so it can be run on a
 * schedule and noticed rather than read.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getWithdrawable, playthroughMessage } = require('../src/services/walletService');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const usd = (n) => (Number(n) || 0).toFixed(2);
const pad = (n, w) => String(usd(n)).padStart(w);

(async () => {
  const { data: profiles, error } = await supabase
    .from('profiles').select('id, username, c_coins').order('c_coins', { ascending: false });
  if (error) { console.error('could not read profiles:', error.message); process.exit(1); }

  const held = (profiles || []).filter(p => (parseFloat(p.c_coins) || 0) > 0.005);
  console.log(`\n${held.length} account(s) holding coins\n` + '─'.repeat(78));
  console.log(
    '  ' + 'account'.padEnd(15) + 'balance'.padStart(11) + 'explained'.padStart(12) +
    'unwagered'.padStart(11) + 'withdrawable'.padStart(14) + '  note');
  console.log('─'.repeat(78));

  let flagged = 0;
  let totalOwedToPlayers = 0;

  for (const p of held) {
    const r = await getWithdrawable(supabase, p.id);
    totalOwedToPlayers += r.withdrawable;
    const note = r.unexplained > 0.005
      ? `${usd(r.unexplained)} UNEXPLAINED`
      : r.unplayedDeposits > 0.005 ? 'playthrough outstanding' : '';
    if (r.unexplained > 0.005) flagged++;
    console.log(
      '  ' + String(p.username).slice(0, 14).padEnd(15) +
      pad(r.balance, 11) + pad(r.explainedBalance, 12) +
      pad(r.unplayedDeposits, 11) + pad(r.withdrawable, 14) +
      (note ? '  ' + note : ''));
  }

  console.log('─'.repeat(78));
  console.log(`  withdrawable across all accounts: ${usd(totalOwedToPlayers)}`);
  console.log('  (this is the figure the payout wallet has to cover — see check-deposits.js)\n');

  if (flagged) {
    console.log(`${flagged} account(s) hold coins the ledger cannot account for.`);
    console.log('Those coins are already blocked from withdrawal. Worth finding out how');
    console.log('they were credited: nothing in the code writes coins without a row.\n');
    process.exit(1);
  }
  console.log('Every balance is accounted for.\n');
})().catch((e) => { console.error('\naudit failed to run:', e.message, '\n'); process.exit(1); });
