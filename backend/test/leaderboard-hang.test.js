// The two wagered boards that spun forever.
//
// weekStart() called startOfPacificWeek, which was never imported into this
// file. Every request threw a ReferenceError — and because Express 4 does not
// catch a rejected promise from an async handler, the request was never
// answered at all. Not slow: unanswered. A request to the live endpoint was
// still open after ninety seconds, so the client's spinner had nothing that
// could stop it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'leaderboard.js'), 'utf8');
const routes = require('../src/routes/leaderboard');

// A supabase double. `mode` decides whether queries resolve or reject; the
// rejecting one is the shape that used to hang.
function fakeDb(mode = 'ok') {
  const rows = {
    matches: [
      { player1_id: 'a', player2_id: 'b', entry_fee_c: 5, entry_fee_diamonds: 100, winner_id: 'a' },
      { player1_id: 'a', player2_id: null, entry_fee_c: 3, entry_fee_diamonds: 60,  winner_id: 'a' },
    ],
    profiles: [
      { id: 'a', username: 'Ann', wins: 1, losses: 0, elo: 1000, profile_color: null, avatar_url: null, current_streak: 1 },
      { id: 'b', username: 'Bob', wins: 0, losses: 1, elo: 1000, profile_color: null, avatar_url: null, current_streak: 0 },
    ],
  };
  const chain = (data) => {
    let p;
    if (mode === 'reject') {
      p = Promise.reject(new Error('simulated upstream failure'));
      // Every chained call below hands back ANOTHER rejected promise, and the
      // route only ever awaits the last one — so the intermediate links would
      // surface as unhandled rejections after the test ended. A no-op catch
      // marks them handled without changing what the awaited one does.
      p.catch(() => {});
    } else {
      p = Promise.resolve({ data, error: null });
    }
    return new Proxy(p, {
      get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => chain(data)),
    });
  };
  return { from: (table) => chain(rows[table] || []) };
}

async function boot(mode) {
  const app = express();
  app.use('/lb', routes(fakeDb(mode)));
  const server = app.listen(0);
  return { server, port: server.address().port };
}

const ALL = ['/', '/streak', '/diamonds', '/weekly', '/coins', '/wagered', '/wagered-diamonds', '/game/tower'];

// Every request in this file is time-boxed, because the bug under test is a
// request that is never answered. Without a deadline the test reproducing it
// HANGS rather than fails — which is the least useful way for a suite to tell
// you something is broken. Two seconds is far longer than any of these need.
async function get(port, route) {
  return fetch(`http://127.0.0.1:${port}/lb${route}`, { signal: AbortSignal.timeout(2000) })
    .catch((e) => {
      throw new Error(`${route} never answered (${e.name}) — this is the hang the file exists to prevent`);
    });
}

test('the wagered boards answer instead of hanging', async () => {
  const { server, port } = await boot('ok');
  try {
    for (const r of ['/wagered', '/wagered-diamonds']) {
      const res = await get(port, `${r}?userId=a`);
      assert.equal(res.status, 200, `${r} did not answer`);
      const body = await res.json();
      assert.ok(Array.isArray(body.players), `${r} returned no players array`);
    }
  } finally { server.close(); }
});

test('the wagered board actually totals the stakes', async () => {
  const { server, port } = await boot('ok');
  try {
    const body = await (await get(port, '/wagered?userId=a')).json();
    // Ann is in both matches (5 + 3), Bob only the first (5).
    const ann = body.players.find(p => p.id === 'a');
    assert.equal(ann.total_wagered, 8);
    assert.equal(body.userRank, 1);
  } finally { server.close(); }
});

test('every route answers even when the database rejects', async () => {
  // The rule this file was missing. A handler that throws must produce a
  // response — an unanswered request is a spinner with nothing to stop it.
  const { server, port } = await boot('reject');
  try {
    for (const r of ALL) {
      const res = await get(port, r);
      assert.equal(res.status, 500, `${r} did not answer when the query failed`);
    }
  } finally { server.close(); }
});

test('every handler is wrapped, not just the ones that broke', () => {
  // The bug was "somebody forgot", and there are eight routes here to forget
  // in — so the guard belongs on all of them rather than on the two that
  // happened to be reported.
  const handlers = SRC.match(/router\.get\('[^']*',\s*/g) || [];
  const wrapped  = SRC.match(/router\.get\('[^']*',\s*wrap\(async/g) || [];
  assert.equal(wrapped.length, handlers.length, 'an unwrapped handler can still hang');
  assert.ok(handlers.length >= 8);
});

test('startOfPacificWeek is imported, not merely called', () => {
  // The existing week-reset test asserted the CALL — startOfPacificWeek(new
  // Date()) — and passed the whole time the import was missing. Checking that
  // a name is used says nothing about whether it resolves.
  assert.match(SRC, /const \{ startOfPacificWeek \} = require\('\.\.\/services\/weekReset'\)/);
});
