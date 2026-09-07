#!/usr/bin/env node
/**
 * Credit a swap that finished but never paid the player.
 *
 * For deposits stranded by the amountReceive bug: ChangeNow completed the
 * exchange, the USDC landed in our treasury, and the poller read the received
 * amount as zero and filed the row as below_min. The money is ours and the
 * player is owed it.
 *
 * Refuses to act by default. It prints what it would do and stops until --send.
 *
 *   railway run node backend/scripts/credit-finished-swap.js --exchange <id>
 *   railway run node backend/scripts/credit-finished-swap.js --exchange <id> --send
 *
 * Safe to run twice. The claim is the same atomic flip swapPoller uses — the
 * row moves to 'confirmed' only if it was not already, and only the run that
 * actually moves it credits. A second run finds nothing to claim and stops.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getExchangeStatus } = require('../src/services/simpleSwapService');
const { creditCoins, recordDeposit } = require('../src/services/walletService');

const OUR_FEE = 0.001;          // the same 0.1% swapPoller takes
const MIN_CREDIT_USD = 3.00;    // and the same floor

const arg = (n) => {
  const i = process.argv.indexOf('--' + n);
  return i === -1 ? null : process.argv[i + 1];
};
const SEND = process.argv.includes('--send');
const die = (m) => { console.error('\n  ' + m + '\n'); process.exit(1); };

(async () => {
  const exchangeId = arg('exchange');
  if (!exchangeId) die('usage: --exchange <changenow id> [--send]');
  if (!process.env.SUPABASE_SERVICE_KEY) die('SUPABASE_SERVICE_KEY is not set — run this under `railway run`');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: row, error } = await supabase
    .from('transactions')
    .select('id, user_id, type, status, amount_c, crypto_amount, crypto_symbol')
    .eq('tx_hash', exchangeId).maybeSingle();
  if (error) die(`could not read the transaction: ${error.message}`);
  if (!row) die(`no transaction recorded for exchange ${exchangeId}`);
  if (row.status === 'confirmed') die(`already credited: $${row.amount_c} to ${row.user_id}`);

  // Ask ChangeNow what actually happened rather than trusting the stored row —
  // the stored row is the thing that was wrong.
  const ex = await getExchangeStatus(exchangeId);
  if (ex.status !== 'finished') die(`exchange is "${ex.status}", not finished — nothing to credit yet`);
  if (!(ex.amountTo > 0)) die(`ChangeNow reports ${ex.amountTo} received — nothing to credit`);
  if (!ex.txTo) die('no payout hash — the swap has not actually paid out');

  const credit = Math.floor(ex.amountTo * (1 - OUR_FEE) * 100) / 100;
  if (credit < MIN_CREDIT_USD) die(`$${credit} is under the $${MIN_CREDIT_USD} floor — genuinely below_min`);

  const { data: before } = await supabase
    .from('profiles').select('username, c_coins').eq('id', row.user_id).maybeSingle();

  console.log(`
  exchange    ${exchangeId}
  status      ${ex.status}
  payout      ${ex.txTo}
  received    ${ex.amountTo} USDC
  fee         ${(ex.amountTo * OUR_FEE).toFixed(4)} (0.1%)
  credit      ${credit} coins

  player      ${before?.username || row.user_id}
  balance     ${before?.c_coins} -> ${(Number(before?.c_coins || 0) + credit).toFixed(2)}
  row status  ${row.status} -> confirmed
`);

  if (!SEND) return console.log('  Nothing credited. Re-run with --send to do it.\n');

  // The same atomic claim swapPoller uses: only the run that actually flips the
  // row credits, so running this twice cannot pay twice.
  const { data: claimed } = await supabase
    .from('transactions')
    .update({ status: 'confirmed', amount_c: credit })
    .eq('tx_hash', exchangeId)
    .in('status', ['below_min', 'stuck', 'converting'])
    .select('id');

  if (!claimed || !claimed.length) die('the row was claimed by something else — nothing credited');

  try {
    await creditCoins(supabase, row.user_id, credit);
  } catch (e) {
    await supabase.from('transactions').update({ status: row.status })
      .eq('tx_hash', exchangeId).eq('status', 'confirmed').then().catch(() => {});
    die(`credit failed, row rolled back to ${row.status}: ${e.message}`);
  }
  await recordDeposit(supabase, row.user_id, credit, 'crypto').catch(() => {});

  const { data: after } = await supabase
    .from('profiles').select('c_coins').eq('id', row.user_id).maybeSingle();
  console.log(`  credited ${credit} coins. balance is now ${after?.c_coins}\n`);
})().catch((e) => die(e.message));
