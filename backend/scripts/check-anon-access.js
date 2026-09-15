#!/usr/bin/env node
/**
 * What can somebody do with the key that ships in the frontend bundle?
 *
 * Read-only, and safe to run against production: every probe uses an amount of
 * 0, a read, or a write aimed at a user id that belongs to nobody. Postgres
 * checks privileges BEFORE it looks for rows, so a locked table still answers
 * "permission denied" and an open one changes nothing.
 *
 * It exists because of a real incident. The tables were protected — an anon
 * client is refused on UPDATE profiles and INSERT transactions — but the
 * FUNCTIONS were not, and every balance-moving RPC was executable by `anon`.
 * The anon key is in the JavaScript bundle, so this, in the console of the live
 * site, minted coins:
 *
 *     supabase.rpc('credit_coins', { user_id: '<your id>', amount: 10000 })
 *
 * An account ended up holding 9,990 coins with no transaction row behind them
 * and withdrew $10 of real money against them.
 *
 * Two actors:
 *   anon           always — the public key with no session
 *   authenticated  when TEST_USER_JWT is set — a real signed-in test account's
 *                  access token (never a real player's). This is the role a
 *                  logged-in attacker actually has, and it is granted
 *                  separately from anon, so passing as anon does not prove it.
 *
 * Run it after PENDING_SQL section 22, and after any migration that adds a
 * function. Exits non-zero if anything the browser should not reach is open.
 *
 *   railway run node backend/scripts/check-anon-access.js
 *   TEST_USER_JWT=<token> railway run node backend/scripts/check-anon-access.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url  = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
if (!url || !anon) {
  console.error('\n  SUPABASE_URL and SUPABASE_ANON_KEY are needed.\n');
  process.exit(1);
}

// A uuid that belongs to nobody: if a call somehow succeeds despite the amount
// being zero, it still lands on no real account.
const NOBODY = '00000000-0000-0000-0000-000000000000';

// Everything the backend calls. Amounts are 0 so a permitted call is a no-op.
const RPCS = [
  ['credit_coins',                { user_id: NOBODY, amount: 0 }],
  ['deduct_coins',                { user_id: NOBODY, amount: 0 }],
  ['credit_diamonds',             { user_id: NOBODY, amount: 0 }],
  ['deduct_diamonds',             { user_id: NOBODY, amount: 0 }],
  ['credit_affiliate_c',          { owner_id: NOBODY, amount: 0 }],
  ['credit_fee_balance',          { user_id: NOBODY, amount: 0 }],
  ['add_rakeback_instant',        { p_user_id: NOBODY, p_amount: 0 }],
  ['add_rakeback_daily',          { p_user_id: NOBODY, p_amount: 0 }],
  ['add_rakeback_weekly',         { p_user_id: NOBODY, p_amount: 0 }],
  ['claim_rakeback_instant',      { p_user_id: NOBODY }],
  ['claim_rakeback_daily',        { p_user_id: NOBODY }],
  ['claim_rakeback_weekly',       { p_user_id: NOBODY }],
  ['claim_daily_bonus',           { p_user_id: NOBODY }],
  // Argument names must match the function EXACTLY.
  //
  // PostgREST resolves an RPC by name AND parameter names, so a wrong guess
  // comes back as "could not find the function" — which this script used to
  // report as "n/a, no such function" and pass. All four of these were being
  // probed with the wrong names, so for four money-adjacent functions the
  // script could never have told an open one from a missing one. They were in
  // fact locked; the check was not checking.
  ['increment_win',                { uid: NOBODY }],
  ['increment_loss',               { uid: NOBODY }],
  ['update_win_streak',            { p_winner_id: NOBODY, p_loser_id: null }],
  ['increment_qualifying_wagered', { user_id: NOBODY, amount: 0 }],
  ['claim_diamond_bonus',          { p_user_id: NOBODY, p_amount: 0 }],
  // Added in audit #3: the two bank-moving functions were never probed.
  ['pay_referral_from_bank',       { admin_id: NOBODY, referrer_id: NOBODY, amount: 0 }],
  ['collect_admin_fees',           { admin_id: NOBODY }],
];

// Read probes. Tables that are private by design must be locked; the ones the
// app never reads from the browser should be locked too (section 22).
const TABLES = [
  'profiles', 'transactions', 'matches', 'deposit_addresses',
  // Added in audit #3.
  'referral_rewards', 'kyc_submissions', 'support_tickets', 'support_messages',
  'friends', 'player_reports', 'game_highscores',
];

// Write probes: each aimed at NOBODY so a permitted write touches no row.
const WRITES = [
  ['profiles',        (c) => c.from('profiles').update({ c_coins: 1, diamonds: 1 }).eq('id', NOBODY)],
  ['transactions',    (c) => c.from('transactions').insert({ user_id: NOBODY, type: 'deposit', amount_c: 0, status: 'confirmed' })],
  ['transactions (update)', (c) => c.from('transactions').update({ amount_c: 0 }).eq('user_id', NOBODY)],
  ['transactions (delete)', (c) => c.from('transactions').delete().eq('user_id', NOBODY)],
  ['matches',         (c) => c.from('matches').update({ winner_id: NOBODY }).eq('id', NOBODY)],
  ['referral_rewards',(c) => c.from('referral_rewards').update({ status: 'pending' }).eq('referrer_id', NOBODY)],
  ['game_highscores', (c) => c.from('game_highscores').update({ score: 0 }).eq('user_id', NOBODY)],
];

// "permission denied" is the only answer that means locked.
//
// "Could not find the function" is NOT a pass. It means the name or the
// argument names did not resolve, and a probe that does not resolve tells you
// nothing about whether the real function is reachable — it is a broken test,
// not a clean result. Counted separately and reported as inconclusive, and the
// script exits non-zero on any of them, because a silent [n/a] on the one
// script that exists to catch the original exploit is how the next one gets
// missed.
const isLocked = (error) => !!error && /permission denied/i.test(error.message);
const isMissing = (error) => !!error &&
  /does not exist|not find the function|schema cache/i.test(error.message);

let open = 0;
let inconclusive = 0;

async function probe(label, sb) {
  console.log(`\n══ As ${label} ═════════════════════════════════════════`);

  console.log('\nFunctions:');
  for (const [fn, args] of RPCS) {
    const { error } = await sb.rpc(fn, args);
    if (isMissing(error)) {
      inconclusive++;
      console.log(`  [  ??  ] ${fn} — did not resolve; the probe's argument names are wrong, or it is not deployed`);
      continue;
    }
    if (isLocked(error))  { console.log(`  [locked] ${fn}`); continue; }
    open++;
    console.log(`  [ OPEN ] ${fn}` + (error ? `  (ran, then: ${error.message.slice(0, 50)})` : '  (succeeded)'));
  }

  console.log('\nTables (read):');
  for (const t of TABLES) {
    const { data, error } = await sb.from(t).select('*').limit(1);
    if (isMissing(error)) { console.log(`  [ n/a  ] ${t} (not deployed)`); continue; }
    if (isLocked(error))  { console.log(`  [locked] ${t}`); continue; }
    // A read the RLS policy filters to nothing is still a grant: for a signed-
    // in user their own rows are expected, so only anon counts it as open.
    if (label === 'anon') { open++; console.log(`  [ OPEN ] ${t} — ${(data || []).length} row(s) readable`); }
    else console.log(`  [ read ] ${t} — ${(data || []).length} row(s) visible (check these are only this user's own)`);
  }

  console.log('\nTables (write):');
  for (const [t, run] of WRITES) {
    const { error } = await run(sb);
    if (isMissing(error)) { console.log(`  [ n/a  ] ${t} (not deployed)`); continue; }
    if (isLocked(error)) { console.log(`  [locked] ${t}`); continue; }
    open++;
    console.log(`  [ OPEN ] ${t}` + (error ? `  (${error.message.slice(0, 50)})` : ''));
  }
}

(async () => {
  console.log('\nWhat the public anon key can reach' + '\n' + '─'.repeat(52));
  await probe('anon', createClient(url, anon));

  const jwt = process.env.TEST_USER_JWT;
  if (jwt) {
    await probe('authenticated (TEST_USER_JWT)', createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }));
  } else {
    console.log('\n(authenticated role not probed — set TEST_USER_JWT to a TEST account\'s access token to check it)');
  }

  console.log('\n' + '─'.repeat(52));
  if (open) {
    console.log(`${open} thing(s) the browser can reach that it should not.`);
    console.log('Run PENDING_SQL section 22.\n');
    process.exit(1);
  }
  if (inconclusive) {
    // Non-zero on purpose. A probe that did not resolve is a broken check, and
    // a broken check that exits green is worse than no check — it is exactly
    // the state this script was in for four functions before anyone looked.
    console.log(`${inconclusive} probe(s) did not resolve, so nothing was proved about them.`);
    console.log('Fix the argument names in RPCS to match the real signatures.\n');
    process.exit(1);
  }
  console.log('Nothing reachable. The browser can authenticate and nothing else.\n');
})().catch((e) => { console.error('\ncheck failed to run:', e.message, '\n'); process.exit(1); });
