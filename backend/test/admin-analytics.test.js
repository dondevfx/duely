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
// What a PostgREST instance will hand back in one request no matter what
// the client asks for.
const PAGE_CAP = 1000;

function fakeDb(tables, seen = []) {
  return {
    from(table) {
      const q = { table, gte: null, lte: null, calls: 0, lastRange: null };
      seen.push(q);
      const chain = {
        select() { return chain; },
        gte(_c, v) { q.gte = v; return chain; },
        lte(_c, v) { q.lte = v; return chain; },
        order() { return chain; },
        // range(), and it enforces a server-side page ceiling the way
        // PostgREST does — asking for more than PAGE_CAP rows in one request
        // silently returns PAGE_CAP of them. That ceiling is the whole reason
        // the route pages, so the double has to have it or the test proves
        // nothing.
        range(from, to) {
          q.calls++;
          q.lastRange = [from, to];
          const rows = (tables[table] || []).filter(r => {
            const ts = r.created_at || r.played_at;
            return (!q.gte || ts >= q.gte) && (!q.lte || ts <= q.lte);
          });
          const want = Math.min(to - from + 1, PAGE_CAP);
          return Promise.resolve({ data: rows.slice(from, from + want), error: null });
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
      assert.ok(q.lastRange, `${q.table} was not fetched by page`);
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

// ── The bug that made a 90-day range report zero fees ─────────────────────

test('a range wider than one page is read in full', async () => {
  // This is the reported failure, reproduced: 30 days showed fees and 90 days
  // showed none. A single request came back cut at the server's row ceiling,
  // and because rows arrive oldest-first the cut fell on the NEWEST ones —
  // which is exactly where fee collections are. The metric did not read low,
  // it read zero.
  const rows = [];
  for (let i = 0; i < 2500; i++) {
    rows.push({ created_at: day(1), type: 'deposit', amount_c: 1, status: 'confirmed', user_id: 'u' });
  }
  // The fee sits past the first page, where the old code could never see it.
  rows.push({ created_at: day(2), type: 'fee_collection', amount_c: 42, status: 'confirmed', user_id: 'u' });

  const { server, port } = await boot({ profiles: [], matches: [], transactions: rows });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-03');
    assert.equal(body.totals.deposits, 2500, 'every page must be read, not just the first');
    assert.equal(body.totals.fees, 42, 'the fee is past the first page — this is the reported bug');
    assert.deepEqual(body.truncated, [], 'and reading it in full is not truncation');
  } finally { server.close(); }
});

test('paging stops at a short page rather than looping', async () => {
  const seen = [];
  const { server, port } = await boot({
    profiles: [{ created_at: day(1), id: 'a' }], matches: [], transactions: [],
  }, seen);
  try {
    await get(port, 'from=2026-03-01&to=2026-03-02');
    const profiles = seen.find(q => q.table === 'profiles');
    assert.equal(profiles.calls, 1, 'one short page is the end of the range');
  } finally { server.close(); }
});

// ── Demo accounts ─────────────────────────────────────────────────────────

test('demo accounts are not in any number on the page', async () => {
  // A demo wins every bot match by design and can be topped up on demand, so
  // leaving them in makes every figure a mixture of what happened and what
  // was staged.
  process.env.DEMO_ACCOUNT_IDS = 'demo-1,demo-2';
  delete require.cache[require.resolve('../src/services/demoAccounts')];
  delete require.cache[require.resolve('../src/routes/admin')];

  const { server, port } = await boot({
    profiles: [
      { created_at: day(1), id: 'real-1' },
      { created_at: day(1), id: 'demo-1' },
    ],
    matches: [
      { played_at: day(1), player1_id: 'real-1', player2_id: 'real-2', prize_pool_c: 10 },
      // Dropped even though only one side is a demo: the opponent did not
      // play a real match either.
      { played_at: day(1), player1_id: 'real-3', player2_id: 'demo-2', prize_pool_c: 999 },
    ],
    transactions: [
      { created_at: day(1), type: 'deposit', amount_c: 5,   status: 'confirmed', user_id: 'real-1' },
      { created_at: day(1), type: 'deposit', amount_c: 500, status: 'confirmed', user_id: 'demo-1' },
    ],
  });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-02');
    assert.equal(body.totals.new_users, 1, 'the demo signup is not a signup');
    assert.equal(body.totals.matches, 1);
    assert.equal(body.totals.wagered, 10, 'the staged 999 must not be in the money');
    assert.equal(body.totals.deposits, 5);
    assert.equal(body.totals.active_players, 2, 'real-1 and real-2, not real-3 or demo-2');
  } finally {
    server.close();
    delete process.env.DEMO_ACCOUNT_IDS;
    delete require.cache[require.resolve('../src/services/demoAccounts')];
    delete require.cache[require.resolve('../src/routes/admin')];
  }
});

// ── Per-game metrics ──────────────────────────────────────────────────────

test('each game reports what it earned, not just how often it was played', async () => {
  // A count says which games get played, not which ones earn. Rake is the
  // platform's only income from a match and comes off the coin pool at 5%;
  // diamonds pay out in full, so a game played entirely in diamonds is
  // popular and free, and a count cannot tell those two apart.
  const { server, port } = await boot({
    profiles: [], transactions: [],
    matches: [
      // Paid PvP in coins.
      { played_at: day(1), game_type: 'tower', player1_id: 'a', player2_id: 'b', prize_pool_c: 100 },
      // Paid vs a bot — the engines write null for the bot's side.
      { played_at: day(1), game_type: 'tower', player1_id: 'a', player2_id: null, prize_pool_c: 20 },
      // Diamonds: no rake, and must not land in the coin column.
      { played_at: day(1), game_type: 'tower', player1_id: 'a', player2_id: 'c', prize_pool_diamonds: 5000 },
      // Free.
      { played_at: day(1), game_type: 'carDash', player1_id: 'a', player2_id: 'b' },
    ],
  });
  try {
    const { body } = await get(port, 'from=2026-03-01&to=2026-03-02');
    const t = body.by_game.tower;
    assert.equal(t.matches, 3);
    assert.equal(t.rake_c, 6, '5% of 120 coins — the diamond match contributes none');
    assert.equal(t.wagered_c, 120);
    assert.equal(t.wagered_diamonds, 5000);
    assert.equal(t.pvp, 2);
    assert.equal(t.vs_bot, 1, 'a null player id is the bot side, not missing data');
    assert.equal(t.paid, 3);
    assert.equal(body.by_game.carDash.free, 1);
    assert.equal(body.by_game.carDash.rake_c, 0);
  } finally { server.close(); }
});
