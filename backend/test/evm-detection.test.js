// ETH and BNB deposit detection.
//
//   [monitor] eth explorer returned status=0 message="NOTOK"
//   [monitor] bnb explorer returned status=0 message="NOTOK"
//
// Both were calling Etherscan/BscScan V1 hosts, which are retired. Every
// request comes back NOTOK, and the old code turned that into an empty list —
// so ETH and BNB deposits were never detected and nothing said so. The same
// silence that hid the BNB key problem hid this.
//
// V2 serves every chain from one endpoint keyed by chainid, with one key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
const CODE = SRC.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

test('the retired V1 endpoints are gone', () => {
  assert.ok(!/api\.bscscan\.com/.test(CODE), 'the BscScan V1 host is retired');
  assert.ok(!/api\.etherscan\.io\/api\?/.test(CODE), 'the Etherscan V1 path is retired');
});

test('both chains go through the V2 endpoint with a chain id', () => {
  assert.match(CODE, /api\.etherscan\.io\/v2\/api\?chainid=/, 'V2 requires an explicit chainid');
  const ids = CODE.match(/EVM_CHAIN_IDS\s*=\s*\{([^}]*)\}/);
  assert.ok(ids, 'the chain id map is missing');
  assert.match(ids[1], /eth:\s*1\b/,  'Ethereum mainnet is chain 1');
  assert.match(ids[1], /bnb:\s*56\b/, 'BSC is chain 56');
});

test('the failure reason is actually logged', () => {
  // message is always the useless "NOTOK"; result carries "Invalid API Key",
  // "Max rate limit reached" or the deprecation notice. Reporting only message
  // says something is wrong without saying what.
  //
  // explorerMiss is gone: every provider now reports failure by throwing, and
  // the reason travels on the error. So the check is that the reason is put
  // ON the error, and that the handler prints it.
  const fn = CODE.slice(CODE.indexOf('function providerFailed'), CODE.indexOf('const _missLogged'));
  assert.match(fn, /lastBody\?\.result|detail/, 'the reason must reach the message');
  assert.match(CODE, /lastBody\?\.result/, 'the EVM path must pass result, not just message');
  assert.match(CODE, /poll error \$\{coin\}\/\$\{address\}: \$\{e\.message\}/,
    'the handler must print the reason it was given');
});

test('a normally empty address stays quiet', () => {
  // An address nobody has paid returns status 0 with "No transactions found".
  // Logging that would bury the real faults under one line per address per poll.
  // It has to return an empty list BEFORE anything can treat it as a failure.
  const fn = CODE.slice(CODE.indexOf('async function fetchEvmTxs'), CODE.indexOf('const fetchEthTxs'));
  assert.match(fn, /no transactions found/i);
  const empty = fn.search(/no transactions found/i);
  const fail  = fn.indexOf('providerFailed');
  assert.ok(empty > 0 && fail > empty, 'the empty case must be settled before the failure path');
});

test('no provider reports a failure as an empty address', () => {
  // The bug that hid every ETH deposit, and the same shape was in four other
  // places: BlockCypher (ltc, doge, btc fallback), TronGrid (trx, trc20) and
  // the Solana RPC (sol, usdc, usdt) each turned a missing field in an error
  // body into "no deposits arrived".
  //
  // Verified against all four providers that an address with genuinely nothing
  // on it returns the field, empty — so the two cases really are separable.
  assert.doesNotMatch(CODE, /if \(!d\.txs\) return \[\]/,   'blockcypher swallows failures');
  assert.doesNotMatch(CODE, /if \(!d\.data\) return \[\]/,  'trongrid swallows failures');
  assert.doesNotMatch(CODE, /\.result \|\| \[\]/,           'the solana rpc swallows failures');
  for (const p of ['blockcypher', 'trongrid', 'solana rpc', 'every explorer']) {
    assert.ok(CODE.includes(`'${p}'`), `${p} does not report failure through providerFailed`);
  }
});

test('a non-array result cannot crash the poll', () => {
  // On an error response `result` is a STRING. Calling .filter on it throws,
  // and the per-address catch would report it as a poll failure rather than an
  // explorer refusal — hiding the real cause behind a stack trace.
  //
  // Scanned from parseEvmTxs rather than from fetchEvmTxs: the guard moved into
  // parseEvmTxs when a second, keyless explorer was added, and a slice that
  // starts at fetchEvmTxs no longer contains it. The rule is unchanged — the
  // check just lives in the function that now does the parsing.
  const fn = CODE.slice(CODE.indexOf('function parseEvmTxs'), CODE.indexOf('const fetchEthTxs'));
  assert.match(fn, /Array\.isArray\(d\.result\)/,
    'result is a string on failure, and .filter on a string throws');
});

test('ETH and BNB share one implementation', () => {
  // They were two near-identical copies, which is how one of them ended up
  // using the wrong API key while the other did not.
  assert.match(CODE, /const fetchEthTxs = \(address\) => fetchEvmTxs\('eth'/);
  assert.match(CODE, /const fetchBnbTxs = \(address\) => fetchEvmTxs\('bnb'/);
});
