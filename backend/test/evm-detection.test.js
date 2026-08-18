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
  // "Max rate limit reached" or the deprecation notice. Logging only message
  // says something is wrong without saying what.
  const fn = CODE.slice(CODE.indexOf('function explorerMiss'), CODE.indexOf('const EVM_CHAIN_IDS'));
  assert.match(fn, /d\?\.result/, 'result is the field that says why');
});

test('a normally empty address stays quiet', () => {
  // An address nobody has paid returns status 0 with "No transactions found".
  // Logging that would bury the real faults under one line per address per poll.
  const fn = CODE.slice(CODE.indexOf('function explorerMiss'), CODE.indexOf('const EVM_CHAIN_IDS'));
  assert.match(fn, /no transactions found/i);
  assert.match(fn, /return;/, 'the empty case must return before logging');
});

test('a non-array result cannot crash the poll', () => {
  // On an error response `result` is a STRING. Calling .filter on it throws,
  // and the per-address catch would report it as a poll failure rather than an
  // explorer refusal — hiding the real cause behind a stack trace.
  const fn = CODE.slice(CODE.indexOf('async function fetchEvmTxs'), CODE.indexOf('const fetchEthTxs'));
  assert.match(fn, /Array\.isArray\(d\.result\)/,
    'result is a string on failure, and .filter on a string throws');
});

test('ETH and BNB share one implementation', () => {
  // They were two near-identical copies, which is how one of them ended up
  // using the wrong API key while the other did not.
  assert.match(CODE, /const fetchEthTxs = \(address\) => fetchEvmTxs\('eth'/);
  assert.match(CODE, /const fetchBnbTxs = \(address\) => fetchEvmTxs\('bnb'/);
});
