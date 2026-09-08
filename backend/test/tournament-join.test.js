// Entering a tournament.
//
// The half where real money moves: the entry fee comes out before the seat
// goes in, and a seat that cannot be given hands the fee straight back.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createStore } = require('../src/services/tournamentPools');
const F = require('../src/services/tournamentFormat');

const USER = '11111111-1111-1111-1111-111111111111';

function boot({ balance = 100, deductFails = false, demo = false } = {}) {
  const calls = { deducted: [], credited: [] };
  const supabase = {
    from: () => {
      const api = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => ({
          data: { username: 'Player', avatar_url: null, c_coins: balance },
        }),
      };
      return api;
    },
    rpc: async (fn, args) => {
      if (fn === 'deduct_coins') {
        if (deductFails) return { error: { message: 'no' } };
        calls.deducted.push(args.amount);
        return { error: null };
      }
      if (fn === 'credit_coins') { calls.credited.push(args.amount); return { error: null }; }
      return { error: null };
    },
  };

  const app = express();
  app.use(express.json());

  // Both stubbed at the module, because the route closes over them at require
  // time — wrapping middleware around the router would not reach either.
  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = {
    ...realAuth,
    requireAuth: (req, _res, next) => { req.user = { id: USER }; next(); },
  };
  const demoPath = require.resolve('../src/services/demoAccounts');
  const realDemo = require(demoPath);
  require.cache[demoPath].exports = { ...realDemo, isDemo: () => demo };

  delete require.cache[require.resolve('../src/routes/tournaments')];
  const routes = require('../src/routes/tournaments');
  const publicPool = routes.publicPool;
  const pools = createStore();
  app.use('/api/tournaments', routes(supabase, null, pools));

  require.cache[authPath].exports = realAuth;
  require.cache[demoPath].exports = realDemo;
  delete require.cache[require.resolve('../src/routes/tournaments')];

  const server = app.listen(0);
  return { server, port: server.address().port, pools, calls, publicPool };
}

const join = (port, body) =>
  fetch(`http://127.0.0.1:${port}/api/tournaments/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));

test('entering takes the stake and seats the player', async () => {
  const { server, port, pools, calls } = boot();
  try {
    const res = await join(port, { entryFee: 5 });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.deducted, [5], 'the entry fee was not taken');
    const pool = pools.get(res.body.poolId);
    assert.equal(pool.players.length, 1);
    assert.equal(pool.entryFee, 5);
  } finally { server.close(); }
});

test('a stake that is not one of the three is refused, and costs nothing', async () => {
  const { server, port, calls } = boot();
  try {
    const res = await join(port, { entryFee: 3 });
    assert.equal(res.status, 400);
    assert.deepEqual(calls.deducted, [], 'a rejected entry still charged');
  } finally { server.close(); }
});

test('too few coins is refused before anything is taken', async () => {
  const { server, port, calls } = boot({ balance: 2 });
  try {
    const res = await join(port, { entryFee: 5 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /need 5 coins/i);
    assert.deepEqual(calls.deducted, []);
  } finally { server.close(); }
});

test('a failed deduction does not seat anyone', async () => {
  // Seating first and charging after leaves a player in a bracket they have
  // not paid for, and nothing can tell them apart from one who has.
  const { server, port, pools } = boot({ deductFails: true });
  try {
    const res = await join(port, { entryFee: 5 });
    assert.equal(res.status, 500);
    assert.equal(pools.pools.size, 0, 'a player who did not pay got a seat');
  } finally { server.close(); }
});

test('a second click returns the same seat rather than charging again', async () => {
  const { server, port, calls } = boot();
  try {
    const first = await join(port, { entryFee: 1 });
    const again = await join(port, { entryFee: 1 });
    assert.equal(again.body.poolId, first.body.poolId);
    assert.equal(again.body.already, true);
    assert.deepEqual(calls.deducted, [1], 'the second click charged a second time');
  } finally { server.close(); }
});

test('a bot tournament is free, and marked as paying nothing', async () => {
  // It exists to walk the bracket end to end. Charging for it would make
  // testing cost real money.
  const { server, port, pools, calls } = boot();
  try {
    const res = await join(port, { entryFee: 10, vsBot: true });
    assert.deepEqual(calls.deducted, [], 'a bot tournament charged an entry fee');
    const pool = pools.get(res.body.poolId);
    assert.equal(pool.free, true, 'nothing marks this pool as paying nothing out');
    assert.equal(res.body.free, true);
  } finally { server.close(); }
});

test('a bot tournament fills and starts immediately', async () => {
  const { server, port, pools } = boot();
  try {
    const res = await join(port, { entryFee: 1, vsBot: true });
    const pool = pools.get(res.body.poolId);
    assert.equal(pool.players.length, F.POOL_SIZE, 'the bracket was not filled');
    assert.equal(pool.state, 'running', 'it did not start');
  } finally { server.close(); }
});

test('a demo account fills up straight away, without asking for bots', async () => {
  // A demo account is a showcase. Sitting in a queue for fifteen minutes
  // waiting for fifteen real people is the opposite of one.
  const { server, port, pools } = boot({ demo: true });
  try {
    const res = await join(port, { entryFee: 1 });
    const pool = pools.get(res.body.poolId);
    assert.equal(pool.players.length, F.POOL_SIZE);
    assert.equal(pool.state, 'running');
  } finally { server.close(); }
});

test('a demo account still pays its entry — only the filling is faked', async () => {
  // The bracket filling instantly is a convenience; not charging would make
  // the demo a different product from the one it is demonstrating.
  const { server, port, calls } = boot({ demo: true });
  try {
    await join(port, { entryFee: 5 });
    assert.deepEqual(calls.deducted, [5]);
  } finally { server.close(); }
});

test('the bots are not identifiable from what the client receives', async () => {
  // The whole point of them is that the screen looks like a real tournament.
  const { server, port, pools, publicPool } = boot();
  try {
    const res = await join(port, { entryFee: 1, vsBot: true });
    const shown = publicPool(pools.get(res.body.poolId));
    const json = JSON.stringify(shown);
    assert.ok(!/isBot/.test(json), 'the client is told which players are bots');
    assert.ok(!/joinedAt/.test(json), 'internal join timestamps leaked');
    assert.equal(shown.players.length, F.POOL_SIZE);
    assert.ok(shown.players.every(p => p.username), 'a bot arrived with no name');
  } finally { server.close(); }
});

// ── Whether the client leaves the bet screen ───────────────────────────────

test('a bot bracket reports as started, because it has something to watch', async () => {
  const { server, port } = boot();
  try {
    const res = await join(port, { entryFee: 1, vsBot: true });
    assert.equal(res.body.started, true);
    assert.equal(res.body.players, F.POOL_SIZE);
  } finally { server.close(); }
});

test('a real entry that is still waiting reports as not started', async () => {
  // Sending a player to a bracket of empty chairs reads as the tournament
  // being broken rather than as it not having begun.
  const { server, port } = boot();
  try {
    const res = await join(port, { entryFee: 1 });
    assert.equal(res.body.started, false, 'one player was told the bracket had begun');
    assert.equal(res.body.players, 1);
    assert.equal(res.body.size, F.POOL_SIZE);
    assert.ok(res.body.startsAt > 0, 'nothing says when it will start');
  } finally { server.close(); }
});

test('a second click reports the same state, not a blank one', async () => {
  // The re-entry path returns early, so it has to answer the same questions —
  // otherwise clicking twice moves the screen backwards.
  const { server, port } = boot();
  try {
    await join(port, { entryFee: 1 });
    const again = await join(port, { entryFee: 1 });
    assert.equal(again.body.already, true);
    assert.equal(again.body.started, false);
    assert.equal(again.body.players, 1, 'the second click lost the seat count');
    assert.ok(again.body.startsAt > 0);
  } finally { server.close(); }
});
