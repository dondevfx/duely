// Withdrawals landing in the same second must not share a nonce (EVM) or the
// same unspent outputs (BTC/LTC/DOGE).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { serialized } = require('../src/services/chainSend');

test('sends from one wallet run one after another, in order', async () => {
  const log = [];
  const slow = (id, ms) => async () => { log.push(`start ${id}`); await new Promise(r => setTimeout(r, ms)); log.push(`end ${id}`); return id; };
  const results = await Promise.all([
    serialized('evm:x', slow('a', 30)),
    serialized('evm:x', slow('b', 1)),
    serialized('evm:x', slow('c', 1)),
  ]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('a failed send does not block the next one', async () => {
  const first = serialized('evm:y', async () => { throw new Error('rejected'); });
  const second = serialized('evm:y', async () => 'ok');
  await assert.rejects(first, /rejected/);
  assert.equal(await second, 'ok');
});

test('different wallets do not wait on each other', async () => {
  let bDone = false;
  const a = serialized('evm:a', () => new Promise(r => setTimeout(() => r(bDone), 30)));
  const b = serialized('evm:b', async () => { bDone = true; });
  await b;
  assert.equal(await a, true);
});

test('EVM sends pick the nonce inside the queue and never reuse one', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'chainSend.js'), 'utf8');
  const fn = s.slice(s.indexOf('async function sendEvm'), s.indexOf('async function sendEth'));
  const q = fn.indexOf('serialized(key, async () => {');
  assert.ok(q > 0);
  assert.ok(fn.indexOf("getTransactionCount(wallet.address, 'pending')") > q);
  assert.match(fn, /Math\.max\(chainNonce, _nextNonce\.get\(key\) \?\? 0\)/);
  assert.match(fn, /_nextNonce\.set\(key, nonce \+ 1\)/);
  // The wait for a block stays OUTSIDE the queue, or throughput is block time.
  assert.ok(fn.indexOf('tx.wait(1)') > fn.indexOf('});', q));
  assert.match(s, /return serialized\(`utxo:\$\{coin\}`, \(\) => sendUtxoCoinNow/);
});
