// Withdrawals landing in the same second must not share a nonce (EVM) or the
// same unspent outputs (BTC/LTC/DOGE).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lock = require('../src/services/payoutSendLock');

// A shared fake database: the two "servers" below are two callers of
// withPayoutLock that share nothing but this table, as two instances would.
function fakeDb({ missing = false } = {}) {
  const rows = new Map();
  const nonces = new Map();
  const table = (name) => {
    const q = { filters: [] };
    const api = {
      insert(row) {
        if (missing) return Promise.resolve({ error: { code: '42P01', message: 'relation "payout_send_locks" does not exist' } });
        if (rows.has(row.key)) return Promise.resolve({ error: { code: '23505', message: 'duplicate' } });
        rows.set(row.key, { ...row, created_at: new Date().toISOString() });
        return Promise.resolve({ error: null });
      },
      delete() { q.op = 'delete'; return api; },
      eq(col, v) { q.filters.push(r => r[col] === v); return api; },
      lt(col, v) { q.filters.push(r => r[col] < v); return api; },
      select() { return api; },
      maybeSingle() { const r = nonces.get(q.key); return Promise.resolve({ data: r ?? null, error: null }); },
      upsert(row) { nonces.set(row.key, row); return Promise.resolve({ error: null }); },
      then(res, rej) {
        const hit = [...rows.values()].filter(r => q.filters.every(f => f(r)));
        if (q.op === 'delete') hit.forEach(r => rows.delete(r.key));
        return Promise.resolve({ data: hit, error: null }).then(res, rej);
      },
    };
    return api;
  };
  return { from: table, rows, nonces };
}
lock._setClient(fakeDb());
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
  
  assert.match(fn, /_nextNonce\.set\(key, nonce \+ 1\)/);
  // The wait for a block stays OUTSIDE the queue, or throughput is block time.
  assert.ok(fn.indexOf('tx.wait(1)') > fn.indexOf('});', q));
  assert.match(s, /return serialized\(`utxo:\$\{coin\}`, \(\) => sendUtxoCoinNow/);
});

test('the database lock keeps two servers from broadcasting at once', async () => {
  const shared = fakeDb();
  lock._setClient(shared);
  const log = [];
  const job = (id) => async () => { log.push(`start ${id}`); await new Promise(r => setTimeout(r, 40)); log.push(`end ${id}`); };
  // Called directly, bypassing the in-memory queue, as two separate processes would.
  await Promise.all([lock.withPayoutLock('evm:w', job('server1')), lock.withPayoutLock('evm:w', job('server2'))]);
  assert.equal(log[1].startsWith('end'), true, `overlapped: ${log.join(', ')}`);
  assert.equal(shared.rows.size, 0, 'the lock is released');
  lock._setClient(fakeDb());
});

test('an abandoned lock is taken over; a missing table falls back and still sends', async () => {
  const shared = fakeDb();
  shared.rows.set('evm:z', { key: 'evm:z', holder: 'dead', created_at: new Date(Date.now() - lock.STALE_MS - 1000).toISOString() });
  lock._setClient(shared);
  assert.equal(await lock.withPayoutLock('evm:z', async () => 'sent', { log: { error() {} } }), 'sent');

  lock._setClient(fakeDb({ missing: true }));
  assert.equal(await lock.withPayoutLock('evm:m', async (info) => info.db, { log: { warn() {} } }), false);
  lock._setClient(fakeDb());
});

test('EVM sends take the highest of chain, this server and the stored nonce, and store the next', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'chainSend.js'), 'utf8');
  assert.match(s, /Math\.max\(chainNonce, _nextNonce\.get\(key\) \?\? 0, stored \?\? 0\)/);
  assert.match(s, /await writeNonce\(key, nonce \+ 1\)/);
  assert.match(s, /return inProcess\(key, \(\) => withPayoutLock\(key, fn\)\)/);
});
