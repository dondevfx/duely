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

test('a demo account fills up on its own, one entrant at a time', async () => {
  // A demo account is a showcase. Sitting in a queue for fifteen minutes
  // waiting for fifteen real people is the opposite of one — but sixteen
  // players appearing in the same instant does not read as a tournament
  // filling up either, it reads as a list being printed. So they arrive one
  // after another, and the bracket is drawn on the sixteenth exactly as it
  // would be for anyone else.
  const { server, port, pools } = boot({ demo: true });
  try {
    const res = await join(port, { entryFee: 1 });
    const pool = pools.get(res.body.poolId);
    assert.ok(pool.players.length >= 2, 'nobody had arrived by the time it answered');
    assert.ok(pool.players.length < F.POOL_SIZE, 'the whole bracket appeared at once');
    assert.equal(pool.state, 'filling');

    const filled = await waitFor(() => pool.players.length === F.POOL_SIZE, 15000);
    assert.ok(filled, `only reached ${pool.players.length}`);
    assert.equal(pool.state, 'running');
  } finally { server.close(); }
});

// Polls rather than sleeping a fixed amount: the pace is deliberately uneven,
// so any single sleep is either flaky or slow.
async function waitFor(cond, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

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
    // When entry CLOSES. There is no start time to report: it starts when
    // the bracket is full, and one that has not filled by then is refunded.
    assert.ok(res.body.closesAt > 0, 'nothing says when entry closes');
    assert.equal(res.body.startsAt, undefined, 'the window is being sold as a start time');
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
    assert.ok(again.body.closesAt > 0);
  } finally { server.close(); }
});

// ── Changing your mind about the stake ─────────────────────────────────────


test('picking a different stake moves you and refunds the first', async () => {
  const { server, port, pools, calls } = boot();
  try {
    const first = await join(port, { entryFee: 5 });
    const second = await join(port, { entryFee: 1 });
    assert.notEqual(second.body.poolId, first.body.poolId, 'it kept the old pool');
    assert.equal(second.body.entryFee, 1, 'the new stake was not applied');
    assert.deepEqual(calls.deducted, [5, 1], 'the new stake was not charged');
    assert.deepEqual(calls.credited, [5], 'the first entry was not refunded');
    assert.equal(pools.get(first.body.poolId), null, 'the abandoned pool was left behind');
  } finally { server.close(); }
});

test('picking the SAME stake twice still charges once', async () => {
  const { server, port, calls } = boot();
  try {
    const a = await join(port, { entryFee: 5 });
    const b = await join(port, { entryFee: 5 });
    assert.equal(b.body.poolId, a.body.poolId);
    assert.deepEqual(calls.deducted, [5]);
    assert.deepEqual(calls.credited, []);
  } finally { server.close(); }
});

test('the response says which stake was actually taken', async () => {
  // The screen showed a stake the server had not charged, and neither knew.
  const { server, port } = boot();
  try {
    const res = await join(port, { entryFee: 10 });
    assert.equal(res.body.entryFee, 10);
  } finally { server.close(); }
});

test('leaving gives the entry back before it starts', async () => {
  const { server, port, calls } = boot();
  try {
    const res = await join(port, { entryFee: 5 });
    const out = await fetch(`http://127.0.0.1:${port}/api/tournaments/${res.body.poolId}/leave`,
      { method: 'POST' }).then(r => r.json());
    assert.equal(out.ok, true);
    assert.equal(out.refunded, true);
    assert.deepEqual(calls.credited, [5]);
  } finally { server.close(); }
});

test('leaving after it starts refunds nothing', async () => {
  const { server, port, calls } = boot();
  try {
    const res = await join(port, { entryFee: 5, vsBot: true });
    const out = await fetch(`http://127.0.0.1:${port}/api/tournaments/${res.body.poolId}/leave`,
      { method: 'POST' }).then(r => r.json());
    assert.equal(out.forfeited, true);
    assert.deepEqual(calls.credited, [], 'a forfeit was refunded');
  } finally { server.close(); }
});

test('a bet that is refused never takes the money', async () => {
  // Entering while already in a running tournament used to hand back the one
  // they were in, at whatever stake it had been entered for — so a player who
  // set the slider to ten and pressed Play was taken to their running one-coin
  // bracket, which told them it was a one-coin entry. Nothing was wrong with
  // the bracket; the bet had simply been ignored.
  const { server, port, pools, calls } = boot();
  try {
    const first = await join(port, { entryFee: 1, vsBot: true });
    const pool = pools.get(first.body.poolId);
    assert.equal(pool.state, 'running', 'a bot bracket did not start');

    const second = await join(port, { entryFee: 10 });
    assert.equal(second.status, 400, 'a second entry was accepted while one was running');
    assert.equal(second.body.inProgress, true);
    assert.equal(second.body.poolId, pool.id, 'the refusal does not say which one they are in');
    assert.ok(!calls.deducted.includes(10), 'the refused stake was charged anyway');
  } finally { server.close(); }
});

test('a second click on a bracket still filling is not a second entry', async () => {
  const { server, port, calls } = boot();
  try {
    await join(port, { entryFee: 5 });
    const again = await join(port, { entryFee: 5 });
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);
    assert.deepEqual(calls.deducted, [5], 'the second click charged again');
  } finally { server.close(); }
});
