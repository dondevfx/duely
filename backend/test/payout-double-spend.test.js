// A payout that failed to CONFIRM is not a payout that failed to SEND.
//
// Every chain broadcasts first and confirms second. When the confirm step
// throws — a timeout, a dropped RPC, a lost HTTP response — the transaction is
// usually already on the network. The withdrawal handler refunds on a payout
// error, so treating that as a failure pays the player on-chain AND gives their
// coins back: a real double-spend, and one anybody can fish for by retrying
// withdrawals during congestion until a confirmation happens to time out.
//
// It was closed for Solana and left open on every other chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// chainSend calls node-fetch, not global fetch, so a stub has to be installed
// in the module cache before it is loaded — otherwise the test quietly hits the
// real network and proves nothing.
const Module = require('node:module');
function loadChainSend(handler) {
  const nf = require.resolve('node-fetch');
  const real = require.cache[nf];
  require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: handler };
  const p = require.resolve('../src/services/chainSend');
  const had = require.cache[p];
  delete require.cache[p];
  try {
    return require('../src/services/chainSend');
  } finally {
    if (real) require.cache[nf] = real; else delete require.cache[nf];
    delete require.cache[p];
    if (had) require.cache[p] = had;
  }
}

const chainSend = require('../src/services/chainSend');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'chainSend.js'), 'utf8');
const WALLET = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');

test('an ETH confirmation timeout keeps the hash', () => {
  // The widest window of the lot: sendTransaction returns as soon as the
  // transaction is broadcast, and tx.wait(1) then waits for a whole block.
  const fn = SRC.slice(SRC.indexOf('async function sendEvm'), SRC.indexOf('async function sendEth'));
  assert.match(fn, /catch \(e\) \{\s*throw new PayoutError\(e\.message, null\)/,
    'a broadcast failure must carry null — it is the only safe refund');
  assert.match(fn, /could not confirm: \$\{e\.message\}`, tx\.hash\)/,
    'a confirmation failure must carry the hash, or the caller refunds blind');
});

test('ETH and BNB share the guarded path', () => {
  // They were two copies of broadcast-then-wait. One would have been fixed and
  // the other forgotten.
  assert.match(SRC, /async function sendEth[\s\S]{0,220}?return sendEvm\(/);
  assert.match(SRC, /async function sendBnb[\s\S]{0,220}?return sendEvm\(/);
});

test('TRX and the UTXO coins know their id before broadcasting', () => {
  // Neither has a separate confirm step, but both can lose the RESPONSE after
  // the node accepted the transaction. Both ids are derivable beforehand, so a
  // lost response is still identifiable rather than indistinguishable from a
  // rejection.
  const trx = SRC.slice(SRC.indexOf('async function sendTrx'), SRC.indexOf('// ── BTC / LTC / DOGE'));
  assert.match(trx, /const txID = signed\.txID;/);
  assert.match(trx, /could not confirm[\s\S]{0,40}txID\)/, 'a lost response must carry the id');
  assert.match(trx, /TRX send failed[\s\S]{0,60}null\)/, 'an outright rejection is safe to refund');

  const utxo = SRC.slice(SRC.indexOf('  const preHash'), SRC.indexOf('// ── USDC sweep'));
  assert.match(utxo, /const preHash = skel\.tx\?\.hash/);
  assert.match(utxo, /could not confirm[\s\S]{0,40}preHash\)/);
  assert.match(utxo, /BlockCypher broadcast[\s\S]{0,80}null\)/,
    'an explicit rejection is safe to refund');
});

test('the handler asks the chain the payout was sent on', async () => {
  // It called checkSolanaSignature for every coin. An ETH hash looked up on
  // Solana is never found and comes back 'missing' — a payout that really
  // landed, classified as one that never happened, and refunded on top.
  assert.match(WALLET, /await checkPayout\(coin, sig\)/,
    'the check must be routed by coin');
  assert.doesNotMatch(WALLET, /checkSolanaSignature\(sig\)/,
    'every coin was being asked of Solana');
});

test('checkPayout routes each coin to its own chain', async () => {
  // Proven by observation: each branch is given a reference no chain will know,
  // and the call is watched to see which network it reaches.
  const seen = [];
  const cs = loadChainSend(async (url) => {
    seen.push(String(url));
    return { status: 404, json: async () => ({}), text: async () => '{}' };
  });
  const opts = { attempts: 1, delayMs: 0 };
  await cs.checkPayout('trx', 'deadbeef', opts);
  assert.ok(seen.some(u => u.includes('trongrid')), 'trx did not reach Tron');

  seen.length = 0;
  await cs.checkPayout('btc', 'deadbeef', opts);
  assert.ok(seen.some(u => u.includes('blockcypher') && u.includes('btc')),
    'btc did not reach the Bitcoin explorer');

  seen.length = 0;
  await cs.checkPayout('doge', 'deadbeef', opts);
  assert.ok(seen.some(u => u.includes('doge')), 'doge did not reach the Dogecoin explorer');
});

test('no reference at all is missing, never confirmed', async () => {
  // A null reference means the transaction was never broadcast. That is the one
  // case where refunding is unambiguously right.
  for (const coin of ['eth', 'btc', 'ltc', 'doge', 'trx', 'sol', 'usdc', 'usdt', 'bnb']) {
    assert.equal(await chainSend.checkPayout(coin, null), 'missing', coin);
  }
});

test('an unrecognised coin is unknown, not missing', async () => {
  // 'missing' authorises a refund. A coin this does not understand must never
  // authorise anything — it has to reach a person.
  assert.equal(await chainSend.checkPayout('xmr', 'somehash'), 'unknown');
});

test('a provider that never answers is unknown, not missing', async () => {
  // The distinction the whole guard rests on. "Every node says it does not
  // exist" is an answer; "no node would talk to us" is not, and reading the
  // second as the first refunds a payout that may well have landed.
  const cs = loadChainSend(async () => { throw new Error('ECONNREFUSED'); });
  const opts = { attempts: 2, delayMs: 0 };
  assert.equal(await cs.checkPayout('trx', 'abc', opts), 'unknown');
  assert.equal(await cs.checkPayout('btc', 'abc', opts), 'unknown');
});

test('a UTXO transaction the explorer knows is confirmed', async () => {
  // Zero confirmations still counts: it is in the mempool, the money has left,
  // and refunding on top of it pays twice.
  const cs = loadChainSend(async () => ({ status: 200,
    json: async () => ({ hash: 'abc', confirmations: 0 }) }));
  assert.equal(await cs.checkPayout('btc', 'abc', { attempts: 1, delayMs: 0 }), 'confirmed');
});

test('a Tron transaction that reverted is failed, so it refunds', async () => {
  const cs = loadChainSend(async () => ({ status: 200,
    json: async () => ({ txID: 'abc', ret: [{ contractRet: 'REVERT' }] }) }));
  assert.equal(await cs.checkPayout('trx', 'abc', { attempts: 1, delayMs: 0 }), 'failed');
});

test('every coin that can be withdrawn has a branch', async () => {
  // A coin whose payout cannot be verified must not be silently defaulted to
  // 'unknown' by accident — that would freeze every failed withdrawal of it.
  const { SS_TICKERS } = require('../src/services/simpleSwapService');
  const fn = SRC.slice(SRC.indexOf('async function checkPayout'), SRC.indexOf('// Actual network fee'));
  for (const coin of Object.keys(SS_TICKERS)) {
    assert.match(fn, new RegExp(`'${coin}'`), `${coin} has no checkPayout branch`);
  }
});
