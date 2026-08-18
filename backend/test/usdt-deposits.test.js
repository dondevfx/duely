// USDT on Solana, replacing BNB.
//
// It rides the USDC path rather than the ChangeNow one, which is the whole
// reason it was worth adding: both are dollar stablecoins with 6 decimals on
// the same chain, so the amount that arrives IS the amount credited. No swap,
// no price lookup, no second confirmation wait.
//
// The gas problem that makes USDT-on-TRON expensive does not exist here: the
// sweep has the admin wallet pay the fee while the deposit address signs only
// as transfer authority, so an address holding nothing but tokens can still be
// emptied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const MONITOR = strip(read('src', 'services', 'blockchainMonitor.js'));
const CHAIN   = strip(read('src', 'services', 'chainSend.js'));
const ADDR    = strip(read('src', 'services', 'addressService.js'));

test('the mint is the real Tether mint on Solana', () => {
  // A wrong mint means scanning an account nobody will ever pay into: deposits
  // arrive and are never seen, which is exactly how BNB failed.
  assert.match(CHAIN, /USDT_MINT = new solWeb3\.PublicKey\('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'\)/,
    'Es9vMFrz... is USDT-SPL; getting this wrong silently loses every deposit');
});

test('USDT deposits credit directly instead of going through ChangeNow', () => {
  assert.match(MONITOR, /if \(coin === 'usdc' \|\| coin === 'usdt'\)/,
    'a dollar stablecoin on our own chain needs no swap');
});

test('a USDT deposit gets a Solana address', () => {
  const block = ADDR.slice(ADDR.indexOf("case 'usdc':"), ADDR.indexOf('default:'));
  assert.match(block, /case 'usdt':/, 'USDT-SPL lives on Solana');
  assert.match(block, /solAddress\(privKey\)/);
});

test('the detector watches the USDT mint, not the USDC one', () => {
  const fn = MONITOR.slice(MONITOR.indexOf('async function fetchSplTxs'),
                           MONITOR.indexOf('async function fetchSolTxs'));
  assert.match(fn, /coin\.toLowerCase\(\) === 'usdt'/, 'the mint must follow the coin');
  assert.match(fn, /getAssociatedTokenAddressSync\(MINT,/,
    'the token account must be derived from the chosen mint');
});

test('both stablecoins are dispatched', () => {
  assert.match(MONITOR, /case 'usdc': return fetchSplTxs\(address, 'usdc'\)/);
  assert.match(MONITOR, /case 'usdt': return fetchSplTxs\(address, 'usdt'\)/);
});

test('the sweep empties the token that actually arrived', () => {
  // Sweeping with a hardcoded USDC mint would find an empty account and no-op,
  // leaving every USDT deposit stranded in its per-user address.
  const at = MONITOR.indexOf('const swept = await sweepSplToken(');
  assert.notEqual(at, -1, 'the per-deposit sweep must be token-aware');
  assert.match(MONITOR.slice(at, at + 120), /sweepSplToken\(privKey, coin\)/);
});

test('the deposit address is derived for the right coin', () => {
  // getAddress(userId, 'usdc') would sweep the wrong address entirely — USDC
  // and USDT derive to different keys because the coin id is part of it.
  const at = MONITOR.indexOf('const swept = await sweepSplToken(');
  const before = MONITOR.slice(at - 200, at);
  assert.match(before, /getAddress\(userId, coin\)/,
    'the sweep must use the depositing coin, not a hardcoded one');
});

test('the hourly backfill covers USDT too', () => {
  const fn = MONITOR.slice(MONITOR.indexOf('async function sweepStrandedUsdc'));
  assert.match(fn.slice(0, 600), /\['usdc', 'usdt'\]/,
    'a backfill that only knows USDC lets USDT pile up untouched');
  assert.match(fn.slice(0, 900), /getAddress\(row\.user_id, row\.coin\)/);
});

test('the admin fee-payer trick still applies', () => {
  // This is what makes SPL stablecoins viable and USDT-on-TRON expensive: a
  // deposit address holds no SOL, so it cannot pay its own fee.
  const fn = CHAIN.slice(CHAIN.indexOf('async function sweepSplToken'));
  assert.match(fn.slice(0, 2000), /tx\.feePayer = adminKp\.publicKey/,
    'the admin wallet pays; the deposit address only signs as authority');
});

// ── Withdrawals ────────────────────────────────────────────────────────────
//
// USDT replaces BNB here too. It pays out through a USDC→USDT Jupiter swap on
// Solana — one transaction, near-1:1, no exchange in the path — where BNB went
// through ChangeNow at several percent and two confirmation waits.

const WALLET  = strip(read('src', 'routes', 'wallet.js'));
const JUPITER = strip(read('src', 'services', 'jupiterService.js'));
const FRONT   = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Wallet.jsx'), 'utf8');

test('USDT is withdrawable and BNB is not', () => {
  const at = FRONT.indexOf('const WITHDRAW_COINS');
  const block = FRONT.slice(at, FRONT.indexOf('];', at))
    .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(block, /id:\s*'usdt'/, 'USDT must be offered');
  assert.ok(!/id:\s*'bnb'/.test(block), 'BNB is replaced');
});

test('the player is sent what the swap produced, not what they asked for', () => {
  // Sending the requested figure would mean covering the difference out of the
  // bank on every withdrawal. Small per trade, unbounded in aggregate.
  const branch = WALLET.slice(WALLET.indexOf("coin.toLowerCase() === 'usdt'"),
                              WALLET.indexOf('const swap = await createWithdrawalSwap'));
  assert.match(branch, /amount:\s*swapped\.usdtReceived/,
    'the send amount must come from the swap output');
  assert.match(branch, /cryptoAmt = swapped\.usdtReceived/,
    'and the recorded amount must be what actually left');
});

test('the swap output goes to the admin wallet, then is sent on', () => {
  // Jupiter cannot be relied on to create a token account for an arbitrary
  // destination, and a swap that lands nowhere is worse than one more
  // transaction. sendSplToken creates the recipient's account.
  const fn = JUPITER.slice(JUPITER.indexOf('async function swapUsdcToUsdt'));
  assert.ok(!/destinationTokenAccount/.test(fn.slice(0, 2000)),
    'the output must stay in the admin wallet, not be aimed at a player account');
  const branch = WALLET.slice(WALLET.indexOf("coin.toLowerCase() === 'usdt'"),
                              WALLET.indexOf('const swap = await createWithdrawalSwap'));
  assert.match(branch, /sendCrypto\(\{[\s\S]*coin:\s*'usdt'/, 'a second step sends it on');
});

test('a stablecoin pair uses tight slippage', () => {
  // 150bps is right for USDC→SOL. On a stablecoin pair it is just accepting a
  // worse price than the market is offering.
  const fn = JUPITER.slice(JUPITER.indexOf('async function swapUsdcToUsdt'));
  assert.match(fn.slice(0, 1500), /slippageBps=50/);
});

test('a direct payout is not held to an exchange minimum', () => {
  // ChangeNow's USDC→coin floor is about their costs. Enforcing it on a payout
  // that never touches them would reject withdrawals for no reason.
  assert.match(WALLET, /DIRECT_PAYOUT_COINS = new Set\(\['sol', 'usdc', 'usdt'\]\)/);
  const guard = WALLET.slice(WALLET.indexOf('const liveMin'), WALLET.indexOf('const liveMin') + 300);
  assert.match(guard, /DIRECT_PAYOUT_COINS\.has/, 'direct payouts must skip the ChangeNow check');
});

test('a USDT withdrawal address is validated as Solana', () => {
  // The same ticker exists on TRON and Ethereum. Accepting one of those would
  // send real money to an address on a chain we are not paying out on.
  const v = strip(read('src', 'services', 'addressValidator.js'));
  assert.match(v, /usdt:\s*isSolana/, 'a TRON or ETH address must be rejected');
});
