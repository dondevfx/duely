#!/usr/bin/env node
/**
 * Can every coin actually be detected and paid out, right now?
 *
 * Read-only. It moves no money, writes nothing, and never prints the value of
 * a secret — only whether one is set.
 *
 * It exists because the failure this is checking for is silent by nature. ETH
 * deposits were invisible for months: the explorer refused every request for
 * want of an API key, the refusal was read as "no deposits arrived", and
 * nothing anywhere said otherwise. The only way to know a deposit path works
 * is to run it against the live provider and look.
 *
 *   railway run node backend/scripts/check-deposits.js
 *
 * Run it after changing any provider key, and after a deploy that touches the
 * monitor.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchTxs } = require('../src/services/blockchainMonitor');
const { DEPOSIT_COINS } = require('../src/services/coinConfig');

const OK = '  ok  ';
const BAD = ' FAIL ';
const WARN = ' warn ';
let failures = 0;

const line = (mark, label, detail) =>
  console.log(`[${mark}] ${String(label).padEnd(26)} ${detail || ''}`);

// Never prints a value. Whether it is set is the whole question.
function envCheck(name, { required, why }) {
  const set = !!process.env[name];
  if (set) return line(OK, name, 'set');
  if (required) { failures++; return line(BAD, name, 'NOT SET — ' + why); }
  return line(WARN, name, 'not set — ' + why);
}

(async () => {
  console.log('\n── configuration ' + '─'.repeat(40));
  envCheck('WALLET_MASTER_SECRET', { required: true,
    why: 'no deposit address can be derived or swept' });
  envCheck('SUPABASE_SERVICE_KEY', { required: true, why: 'nothing can be credited' });
  envCheck('ETHERSCAN_API_KEY', { required: true,
    why: 'ETH falls back to keyless Blockscout, which rate-limits under normal polling' });
  envCheck('USDC_SPL_ADDRESS', { required: true,
    why: 'deposits have nowhere to be forwarded to' });
  envCheck('ADMIN_PHANTOM_PRIVATE_KEY', { required: true,
    why: 'no withdrawal can be paid out' });
  envCheck('HELIUS_API_KEY', { required: false,
    why: 'Solana falls back to polling, which costs credits' });
  envCheck('HELIUS_WEBHOOK_SECRET', { required: false, why: 'webhooks stay off' });
  envCheck('BLOCKCYPHER_TOKEN', { required: false,
    why: 'LTC/DOGE run on the tokenless tier, ~100 requests/hour shared' });
  envCheck('ALCHEMY_ETH_RPC', { required: false,
    why: 'ETH sends and gas pricing use a public node, no SLA' });
  envCheck('CHANGENOW_API_KEY', { required: false,
    why: 'non-Solana deposits cannot be converted' });

  // ── Does each coin's detector actually answer? ───────────────────────────
  //
  // Against a REAL deposit address, through the same code the monitor runs.
  // A provider that refuses now throws rather than reporting an empty address,
  // so an exception here is the finding.
  console.log('\n── deposit detection, live ' + '─'.repeat(31));
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: rows, error } = await supabase
    .from('deposit_addresses').select('coin, address');
  if (error) { console.error('could not read deposit_addresses:', error.message); process.exit(1); }

  const oneEach = new Map();
  for (const r of rows || []) {
    const c = String(r.coin).toLowerCase();
    if (DEPOSIT_COINS.has(c) && !oneEach.has(c)) oneEach.set(c, r.address);
  }
  for (const coin of DEPOSIT_COINS) {
    const address = oneEach.get(coin);
    if (!address) { line(WARN, coin, 'no address issued yet — cannot test'); continue; }
    const started = Date.now();
    try {
      const txs = await fetchTxs(coin, address);
      line(OK, coin, `${txs.length} tx(s) visible, ${Date.now() - started}ms`);
    } catch (e) {
      failures++;
      line(BAD, coin, `${e.message.slice(0, 88)}`);
    }
  }

  // ── Can a withdrawal actually be paid? ───────────────────────────────────
  //
  // Every payout leaves from the admin USDC wallet, whatever coin the player
  // asked for. Eight withdrawals failed in August for one reason: "Admin wallet
  // USDC balance too low". That is not a code fault and no amount of testing
  // finds it — the wallet is either funded or it is not.
  console.log('\n── payout wallet ' + '─'.repeat(40));
  try {
    const solWeb3 = require('@solana/web3.js');
    const splToken = require('@solana/spl-token');
    const { USDC_MINT } = require('../src/services/chainSend');
    const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const conn = new solWeb3.Connection(rpc, 'confirmed');
    const owner = new solWeb3.PublicKey(process.env.USDC_SPL_ADDRESS);

    const sol = (await conn.getBalance(owner)) / 1e9;
    line(sol > 0.01 ? OK : BAD, 'SOL for fees', `${sol.toFixed(6)} SOL`);
    if (sol <= 0.01) failures++;

    const ata = splToken.getAssociatedTokenAddressSync(USDC_MINT, owner);
    const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
    const usdc = bal ? Number(bal.value.uiAmount) : 0;

    // Against the LIABILITY, not against zero.
    //
    // "More than nothing" is not a useful thing to know about a payout wallet.
    // The question is whether players could be paid what they are owed: one
    // coin is one dollar, c_coins is the withdrawable balance, and diamonds are
    // not withdrawable so they are not counted.
    //
    // Eight withdrawals failed in August against a balance of 4.44 USDC. A
    // check that called that "funded" would have reported everything healthy
    // on the morning it broke.
    // Demo accounts are an env list, not a column — see services/demoAccounts.
    // The first version of this asked for a profiles.is_demo that does not
    // exist. The query errored, `data` came back null, the sum over nothing was
    // 0, and the check cheerfully reported that every player could withdraw in
    // full. A failed query must never read as good news, so it is checked.
    const { isDemo } = require('../src/services/demoAccounts');
    const { data: holders, error: holdersErr } = await supabase
      .from('profiles').select('id, c_coins');
    if (holdersErr) throw new Error(`could not total player balances: ${holdersErr.message}`);
    if (!holders) throw new Error('player balances came back empty — cannot judge cover');
    const owed = holders
      .filter(p => !isDemo(p.id))
      .reduce((sum, p) => sum + (parseFloat(p.c_coins) || 0), 0);

    line(usdc > 0 ? OK : BAD, 'USDC available', `${usdc.toFixed(2)} USDC`);
    if (usdc <= 0) failures++;
    line(OK, 'owed to players', `${owed.toFixed(2)} coins (1 coin = $1, diamonds excluded)`);

    if (usdc < owed) {
      failures++;
      line(BAD, 'cover', `SHORT by ${(owed - usdc).toFixed(2)} — a withdrawal over ` +
        `${usdc.toFixed(2)} fails with "Admin wallet USDC balance too low"`);
    } else {
      line(OK, 'cover', `every player could withdraw in full`);
    }
    console.log('        every withdrawal, in any coin, is paid from this balance.');
  } catch (e) {
    failures++;
    line(BAD, 'payout wallet', e.message.slice(0, 88));
  }

  // ── Anything already stuck ───────────────────────────────────────────────
  console.log('\n── attention queue ' + '─'.repeat(38));
  const CRITICAL = ['refund_failed', 'payout_failed', 'payout_uncertain', 'withdraw_failed'];
  const WARNING = ['stuck', 'pending_retry', 'failed'];
  const { data: bad } = await supabase.from('transactions')
    .select('status, amount_c, created_at, notes')
    .in('status', [...CRITICAL, ...WARNING, 'converting']);
  const byStatus = {};
  for (const t of bad || []) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  if (!Object.keys(byStatus).length) line(OK, 'nothing stuck', '');
  for (const [status, n] of Object.entries(byStatus)) {
    const critical = CRITICAL.includes(status);
    if (critical) failures++;
    line(critical ? BAD : WARN, status, `${n} row(s)`);
  }

  console.log('\n' + '─'.repeat(57));
  console.log(failures ? `${failures} problem(s) above need attention.\n`
                       : 'Every deposit path answers and payouts are funded.\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\ncheck failed to run:', e.message, '\n'); process.exit(1); });
