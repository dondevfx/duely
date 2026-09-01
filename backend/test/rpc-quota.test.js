// The deposit monitor's RPC budget.
//
// Both Solana pollers asked for an address's last 10 signatures and then
// fetched all ten transactions, every 45 seconds, forever — nothing remembered
// that nine of them were the same nine as the pass before. Eight addresses at
// eleven calls each, every 45 seconds, is about 169,000 calls a day: a month's
// quota gone, the provider answering "max usage reached", and deposits going
// undetected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('a transaction is fetched at most once', () => {
  // One getTransaction call site, behind a cache. Two call sites is the old
  // shape — one per poller, each re-downloading the same ten every pass.
  assert.equal((CODE.match(/method:\s*'getTransaction'/g) || []).length, 1,
    'every getTransaction must go through the memoised helper');
  assert.match(CODE, /async function getSolanaTx\(rpc, signature\)/);
  assert.match(CODE, /_txCache\.get\(signature\)/);
  assert.match(CODE, /_txCache\.set\(signature, tx\)/);
});

test('both Solana pollers use it', () => {
  for (const fn of ['fetchSplTxs', 'fetchSolTxs']) {
    const at = CODE.indexOf(`function ${fn}`);
    assert.ok(at > 0, `${fn} is gone`);
    const body = CODE.slice(at, at + 3000);
    assert.match(body, /await getSolanaTx\(rpc, sig\.signature\)/,
      `${fn} still fetches transactions directly`);
  }
});

test('a missing transaction is not cached', () => {
  // A null result means the node has not caught up yet, or the signature fell
  // outside its history. Neither is permanent, and caching it would make a
  // real deposit invisible for as long as the process runs.
  const at = CODE.indexOf('async function getSolanaTx');
  const body = CODE.slice(at, CODE.indexOf('\n}', at));
  const nullReturn = body.indexOf('if (!tx) return null;');
  const set = body.indexOf('_txCache.set');
  assert.ok(nullReturn > 0 && set > nullReturn,
    'the early return must come before anything is stored');
});

test('the cache is bounded', () => {
  assert.match(CODE, /_txCache\.size >= TX_CACHE_MAX/);
  assert.match(CODE, /_txCache\.delete\(_txCache\.keys\(\)\.next\(\)\.value\)/,
    'Map iterates in insertion order, so the first key is the oldest');
});

test('a quota message is reported as a quota message', () => {
  // A provider that is out of credits does not answer with JSON. The bare
  // words "max usage reached" made .json() throw, so every address logged
  // "Unexpected token 'm'" — which reads like a parsing bug rather than a
  // bill to pay.
  assert.match(CODE, /async function readJson\(res\)/);
  assert.match(CODE, /upstream returned non-JSON \(HTTP \$\{res\.status\}\)/);
  // Every upstream in this file, not just the Solana RPC — CoinGecko,
  // Blockstream, Etherscan, TronGrid and BlockCypher can all answer this way.
  assert.ok(!/await (res|sigRes|r|txRes|txR)\.json\(\)/.test(CODE),
    'every response body must go through readJson so a non-JSON reply is legible');
});

test('the stranded sweep stops when the provider is rate limited', () => {
  // web3.js retries a 429 internally four times with its own backoff and
  // prints an untagged line for each, so an account out of credits turned one
  // hourly cleanup into a hundred log lines about a provider that will say no
  // to every one of them. Nothing here can succeed until the quota resets, and
  // the job has no deadline — everything it would have moved is still there
  // next hour.
  const sweep = CODE.slice(CODE.indexOf('async function sweepStrandedUsdc'));
  assert.match(sweep, /429\|rate\.\?limit\|max usage/i);
  const guard = sweep.indexOf('max usage');
  const brk = sweep.indexOf('break;', guard);
  const perAddrLog = sweep.indexOf('stranded sweep failed for user');
  assert.ok(brk > 0 && brk < perAddrLog,
    'the rate-limit branch must break out, not fall through to the per-address log');
});
