// Economy audit #3: database-enforced withdrawal lock, the append-only balance
// ledger, and reconciliation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { acquireWithdrawalLock, releaseWithdrawalLock, STALE_MS } = require('../src/services/withdrawalLock');
const { reconcile } = require('../scripts/reconcile-ledger');

// A fake withdrawal_locks table with a real primary-key constraint, shared by
// several "servers" the way one database is.
function fakeDb() {
  const rows = new Map();
  let delay = 0;
  const tick = () => new Promise(r => setTimeout(r, delay));
  const db = {
    rows,
    slow(ms) { delay = ms; },
    from: () => {
      const q = {};
      q.insert = async ({ user_id }) => {
        await tick();
        if (rows.has(user_id)) return { error: { code: '23505', message: 'duplicate key' } };
        rows.set(user_id, { user_id, created_at: new Date().toISOString() });
        return { error: null };
      };
      q.delete = () => {
        const f = { uid: null, before: null };
        const chain = {
          eq: (_c, v) => { f.uid = v; return chain; },
          lt: (_c, v) => { f.before = v; return chain; },
          select: async () => {
            const r = rows.get(f.uid);
            if (r && (!f.before || r.created_at < f.before)) { rows.delete(f.uid); return { data: [r] }; }
            return { data: [] };
          },
          then: (res) => { const r = rows.get(f.uid); if (r) rows.delete(f.uid); res({ error: null }); },
        };
        return chain;
      };
      return q;
    },
  };
  return db;
}
const quiet = { error() {}, warn() {} };

test('ten concurrent withdrawals for one account across four servers: exactly one gets the lock', async () => {
  const db = fakeDb();
  db.slow(2);
  const results = await Promise.all(Array.from({ length: 10 }, () => acquireWithdrawalLock(db, 'u1', { log: quiet })));
  assert.equal(results.filter(r => r.ok).length, 1, `${results.filter(r => r.ok).length} withdrawals ran at once`);
  assert.ok(results.filter(r => !r.ok).every(r => r.reason === 'in_progress'));
});

test('the lock is released, and a different account is never blocked', async () => {
  const db = fakeDb();
  const a = await acquireWithdrawalLock(db, 'u1', { log: quiet });
  assert.ok((await acquireWithdrawalLock(db, 'u2', { log: quiet })).ok, 'one user blocked another');
  await releaseWithdrawalLock(db, 'u1', a);
  assert.ok((await acquireWithdrawalLock(db, 'u1', { log: quiet })).ok, 'the lock was never released');
});

test('a lock left by a crash is taken over after the stale window, not before', async () => {
  const db = fakeDb();
  db.rows.set('u1', { user_id: 'u1', created_at: new Date(Date.now() - 60_000).toISOString() });
  assert.equal((await acquireWithdrawalLock(db, 'u1', { log: quiet })).ok, false, 'a fresh lock was taken over');
  db.rows.set('u1', { user_id: 'u1', created_at: new Date(Date.now() - STALE_MS - 60_000).toISOString() });
  assert.equal((await acquireWithdrawalLock(db, 'u1', { log: quiet })).ok, true, 'an abandoned lock blocks withdrawals forever');
});

test('an unexpected lock error refuses the withdrawal; only a missing table falls back', async () => {
  const broken = { from: () => ({ insert: async () => ({ error: { code: '08006', message: 'connection lost' } }) }) };
  assert.equal((await acquireWithdrawalLock(broken, 'u1', { log: quiet })).ok, false, 'proceeded without knowing it held the lock');
  const missing = { from: () => ({ insert: async () => ({ error: { code: '42P01', message: 'relation "withdrawal_locks" does not exist' } }) }) };
  const r = await acquireWithdrawalLock(missing, 'u1', { log: quiet });
  assert.deepEqual(r, { ok: true, db: false });
});

test('both withdrawal routes take and release the database lock', () => {
  const w = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
  assert.equal((w.match(/const dbLock = await acquireWithdrawalLock\(supabase, req\.user\.id\);/g) || []).length, 2);
  assert.equal((w.match(/await releaseWithdrawalLock\(supabase, req\.user\.id, dbLock\);/g) || []).length, 2);
});

test('the ledger migration is atomic, complete and append-only', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'PENDING_SQL.sql'), 'utf8');
  const sec = sql.slice(sql.indexOf('24. Append-only balance ledger'));
  assert.ok(/AFTER INSERT OR UPDATE OF c_coins, diamonds ON profiles/.test(sec), 'some balance changes are not recorded');
  assert.ok(/BEFORE UPDATE OR DELETE ON balance_ledger/.test(sec) && /append-only/.test(sec), 'ledger rows can be edited');
  assert.ok(/LOCK TABLE profiles IN SHARE ROW EXCLUSIVE MODE;[\s\S]*'opening'[\s\S]*CREATE TRIGGER profiles_balance_ledger/.test(sec),
    'the opening snapshot is not taken under a lock before the trigger starts');
  assert.ok(/REVOKE ALL ON balance_ledger FROM PUBLIC, anon, authenticated;/.test(sec));
  assert.ok(/withdrawal_locks \(\s*user_id\s+uuid\s+PRIMARY KEY/.test(sql), 'the withdrawal lock is not unique per user');
});

test('reconciliation flags negatives, ledger mismatches, duplicate deposits and stuck locks', () => {
  const f = reconcile({
    profiles: [
      { id: 'ok', c_coins: 10, diamonds: 5 },
      { id: 'minted', c_coins: 1000, diamonds: 0 },
      { id: 'neg', c_coins: -1, diamonds: 0 },
    ],
    ledger: [
      { user_id: 'ok', kind: 'opening', coins_delta: 5, diamonds_delta: 5 },
      { user_id: 'ok', kind: 'change', coins_delta: 5, diamonds_delta: 0 },
      { user_id: 'minted', kind: 'opening', coins_delta: 10, diamonds_delta: 0 },
      { user_id: 'neg', kind: 'opening', coins_delta: -1, diamonds_delta: 0 },
    ],
    transactions: [
      { user_id: 'ok', type: 'deposit', amount_c: 5, tx_hash: 'h1' },
      { user_id: 'x', type: 'deposit', amount_c: 5, tx_hash: 'h2' },
      { user_id: 'x', type: 'deposit', amount_c: 5, tx_hash: 'h2' },
    ],
    locks: [{ user_id: 'stuck', created_at: new Date(Date.now() - 16 * 60_000).toISOString() }],
  });
  assert.deepEqual(f.negative.map(x => x.id), ['neg']);
  assert.deepEqual(f.mismatch.map(x => x.id), ['minted'], 'a balance the ledger cannot explain was missed');
  assert.deepEqual(f.duplicateDeposits.map(x => x.tx_hash), ['h2']);
  assert.equal(f.stuckLocks.length, 1);
  assert.equal(f.unattributed.length, 0, 'a recorded deposit was flagged as unattributed');
});
