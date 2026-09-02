// The analytics window behind the redesigned admin dashboard.
//
// /stats answers "what is true right now" over fixed windows. This answers
// "what happened between these two dates, in buckets" — the question a
// dashboard exists for, and the one the old page could not ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// A supabase double for exactly the three tables the route reads. Each call
// records its filters so the test can check the range actually reached the
// query rather than being applied afterwards in JS.
function fakeDb(tables, seen = []) {
  return {
    from(table) {
      const q = { table, gte: null, lte: null, limit: null };
      seen.push(q);
      const chain = {
        select() { return chain; },
        gte(_c, v) { q.gte = v; return chain; },
        lte(_c, v) { q.lte = v; return chain; },
        order() { return chain; },
        limit(n) {
          q.limit = n;
          const rows = (tables[table] || []).filter(r => {
            const ts = r.created_at || r.played_at;
            return (!q.gte || ts >= q.gte) && (!q.lte || ts <= q.lte);
          });
          return Promise.resolve({ data: rows.slice(0, n), error: null });
        },
      };
      return chain;
    },
  };
}

// requireAuth validates a real bearer token against Supabase, which no test
// can produce. Swapped for a pass-through that sets the admin id, so the route
// under test runs while requireAdmin — which is ordinary code — still runs for
// real. Restored after each boot so nothing leaks into other files.
async function boot(tables, seen) {
  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = {
    ...realAuth,
    requireAuth: (req, _res, next) => { req.user = { id: process.env.ADMIN_USER_ID }; next(); },
  };
  const adminPath = require.resolve('../src/routes/admin');
  delete require.cache[adminPath];
  const adminRoutes = require(adminPath);
  require.cache[authPath].exports = realAuth;

  const app = express();
  app.use('/api/admin', adminRoutes(fakeDb(tables, seen)));
  const server = app.listen(0);
  return { server, port: server.address().port };
}

const get = async (port, qs) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/analytics?${qs}`);
  return { status: r.status, body: await r.json() };
};

// A day of matches, spread so the bucketing has something to do.
const day = (d) => `2026-03-${String(d).padStart(2, '0')}T12:00:00.000Z`;

process.env.ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'admin-test';

test('every day in the range gets a bucket, including the empty ones', async () => {
  // Without this a quiet week is drawn as a straight line between the days
  // either side of it, which reads as steady activity rather than as none.
  const { server, port } = await boot({
    profiles: [{ created_at: day(1) }, { created_at: day(1) }, { created_at: day(4) }],
    matches: [], transactions: [],
  });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-05');
    assert.equal(body.bucket, 'day');
    assert.equal(body.points.length, 5, 'five days in, five points out');
    assert.deepEqual(body.points.map(p => p.new_users), [2, 0, 0, 1, 0]);
    assert.equal(body.totals.new_users, 3);
  } finally { server.close(); }
});

test('the bucket follows the span', async () => {
  // A year of daily points is 365 unreadable bars; a week of monthly points
  // is one.
  const { server, port } = await boot({ profiles: [], matches: [], transactions: [] });
  try {
    assert.equal((await get(port, 'from=2026-01-01&to=2026-02-01')).body.bucket, 'day');
    assert.equal((await get(port, 'from=2025-09-01&to=2026-03-01')).body.bucket, 'week');
    assert.equal((await get(port, 'from=2022-01-01&to=2026-01-01')).body.bucket, 'month');
    // Still overridable.
    assert.equal((await get(port, 'from=2026-01-01&to=2026-02-01&bucket=month')).body.bucket, 'month');
  } finally { server.close(); }
});

test('active players is not the sum of its buckets', async () => {
  // Somebody who played Monday and Tuesday is one player, not two — the one
  // total that cannot be added up from the chart.
  const { server, port } = await boot({
    profiles: [],
    matches: [
      { played_at: day(1), player1_id: 'a', player2_id: 'b', prize_pool_c: 2 },
      { played_at: day(2), player1_id: 'a', player2_id: 'b', prize_pool_c: 2 },
      { played_at: day(3), player1_id: 'a', player2_id: 'c', prize_pool_c: 2 },
    ],
    transactions: [],
  });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-04');
    assert.deepEqual(body.points.map(p => p.active_players), [2, 2, 2, 0]);
    assert.equal(body.totals.active_players, 3, 'a, b and c — not six');
    assert.equal(body.totals.matches, 3);
  } finally { server.close(); }
});

test('wagered falls back to the entry fee on rows that predate prize_pool_c', async () => {
  // Otherwise every old match reads as a free one.
  const { server, port } = await boot({
    profiles: [],
    matches: [
      { played_at: day(1), prize_pool_c: 10 },
      { played_at: day(1), entry_fee_c: 3 },   // both sides staked 3
    ],
    transactions: [],
  });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-02');
    assert.equal(body.totals.wagered, 16);
  } finally { server.close(); }
});

test('only confirmed money counts', async () => {
  // A failed withdrawal that still showed in the total would make the money
  // leaving the platform look larger than it was.
  const { server, port } = await boot({
    profiles: [], matches: [],
    transactions: [
      { created_at: day(1), type: 'deposit',    amount_c: 100, status: 'confirmed' },
      { created_at: day(1), type: 'deposit',    amount_c: 500, status: 'pending' },
      { created_at: day(1), type: 'withdrawal', amount_c: -40, status: 'confirmed' },
      { created_at: day(1), type: 'withdrawal', amount_c: -90, status: 'payout_failed' },
      { created_at: day(1), type: 'fee_collection', amount_c: 7, status: 'confirmed' },
    ],
  });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-02');
    assert.equal(body.totals.deposits, 100);
    assert.equal(body.totals.withdrawals, 40, 'and reported as a positive amount');
    assert.equal(body.totals.fees, 7);
  } finally { server.close(); }
});

test('the range reaches the query rather than being filtered afterwards', async () => {
  // Pulling every row ever written and then discarding most of them would
  // work and would get slower every month.
  const seen = [];
  const { server, port } = await boot({ profiles: [], matches: [], transactions: [] }, seen);
  try {
    await get(port, 'from=2026-03-01&to=2026-03-05');
    assert.equal(seen.length, 3, 'profiles, matches, transactions');
    for (const q of seen) {
      assert.ok(q.gte && q.lte, `${q.table} was fetched unbounded`);
      assert.equal(q.limit, 50000, `${q.table} was fetched without a row cap`);
    }
  } finally { server.close(); }
});

test('a truncated range says so', async () => {
  // A capped range looks exactly like a quiet one, and the difference matters
  // when the number is being used to decide something.
  const many = Array.from({ length: 50000 }, () => ({ created_at: day(1) }));
  const { server, port } = await boot({ profiles: many, matches: [], transactions: [] });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-02');
    assert.deepEqual(body.truncated, ['profiles']);
  } finally { server.close(); }
});

test('a backwards or unparseable range is refused', async () => {
  const { server, port } = await boot({ profiles: [], matches: [], transactions: [] });
  try {
    assert.equal((await get(port, 'from=2026-03-05&to=2026-03-01')).status, 400);
    assert.equal((await get(port, 'from=not-a-date&to=2026-03-01')).status, 400);
  } finally { server.close(); }
});
