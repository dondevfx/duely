// A claimed rakeback has to leave a number behind.
//
// Claimed rakeback is playthrough-bearing — it is coins that arrived without
// being risked — but the claim itself is a Postgres RPC that credits coins
// atomically and writes nothing else, and transactions.type has a check
// constraint that rejects 'rakeback' and every variant of the name (probed
// against production). So the total is a counter on the profile, and these
// routes are the only place it is incremented. Miss it and rakeback silently
// carries no requirement, which is the bug rather than the feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const USER = 'u-1';

// A profiles table plus the three claim RPCs.
function fakeDb({ claimed = 0, rpcAmount = 4, columnMissing = false }) {
  const state = { total: claimed, updates: [], rpcs: [] };
  return {
    state,
    rpc: async (name, args) => { state.rpcs.push({ name, args }); return { data: rpcAmount, error: null }; },
    from() {
      const q = {};
      const api = {
        select: () => api,
        update: (patch) => { q.patch = patch; return api; },
        eq: (col, val) => {
          q[col] = val;
          if (q.patch) {
            if (columnMissing) return Promise.resolve({ error: { message: 'column does not exist' } });
            state.total = q.patch.rakeback_claimed_total;
            state.updates.push(q.patch);
            return Promise.resolve({ error: null });
          }
          return api;
        },
        maybeSingle: async () => columnMissing
          ? { data: null, error: { message: 'column profiles.rakeback_claimed_total does not exist' } }
          : { data: { rakeback_claimed_total: state.total }, error: null },
      };
      return api;
    },
  };
}

function boot(db) {
  const app = express();
  app.use(express.json());
  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = {
    ...realAuth,
    requireAuth: (req, _res, next) => { req.user = { id: USER }; next(); },
  };
  delete require.cache[require.resolve('../src/routes/rakeback')];
  const routes = require('../src/routes/rakeback');
  app.use('/api/rakeback', routes(db));
  require.cache[authPath].exports = realAuth;
  delete require.cache[require.resolve('../src/routes/rakeback')];
  const server = app.listen(0);
  return { server, port: server.address().port };
}

const claim = (port, kind) =>
  fetch(`http://127.0.0.1:${port}/api/rakeback/claim/${kind}`, { method: 'POST' })
    .then(async r => ({ status: r.status, body: await r.json() }));

for (const kind of ['instant', 'daily', 'weekly']) {
  test(`a ${kind} claim is added to the running total`, async () => {
    const db = fakeDb({ claimed: 10, rpcAmount: 4 });
    const { server, port } = boot(db);
    try {
      const res = await claim(port, kind);
      assert.equal(res.status, 200);
      assert.equal(res.body.claimed, 4, 'the claim itself must still work');
      assert.equal(db.state.total, 14,
        `${kind} rakeback was credited but not recorded — it carries no playthrough`);
    } finally { server.close(); }
  });
}

test('claims accumulate rather than overwrite', async () => {
  const db = fakeDb({ claimed: 0, rpcAmount: 2.5 });
  const { server, port } = boot(db);
  try {
    await claim(port, 'instant');
    await claim(port, 'daily');
    await claim(port, 'weekly');
    assert.equal(db.state.total, 7.5, 'each claim must add to the total, not replace it');
  } finally { server.close(); }
});

test('a claim of nothing records nothing', async () => {
  const db = fakeDb({ claimed: 5, rpcAmount: 0 });
  const { server, port } = boot(db);
  try {
    await claim(port, 'instant');
    assert.equal(db.state.updates.length, 0, 'wrote a row for a zero claim');
    assert.equal(db.state.total, 5);
  } finally { server.close(); }
});

test('the claim still succeeds when the column is missing', async () => {
  // The coins are already credited by the time the record is written. Failing
  // the request afterwards would tell a player their claim failed when it did
  // not — and the migration (PENDING_SQL 21) may not have run yet.
  const db = fakeDb({ rpcAmount: 4, columnMissing: true });
  const { server, port } = boot(db);
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const res = await claim(port, 'instant');
    assert.equal(res.status, 200, 'a missing column must not fail the claim');
    assert.equal(res.body.claimed, 4);
    assert.ok(warned.some(w => w.includes('not recorded')),
      'an unrecorded claim must say so — silence is how it goes unnoticed');
  } finally { console.warn = realWarn; server.close(); }
});

test('the amount recorded is the amount the RPC actually paid', async () => {
  // Not the requested amount, not a guess: rakeback claims pay whatever has
  // accrued, and recording anything else puts the requirement out of step with
  // the coins that landed.
  const db = fakeDb({ claimed: 0, rpcAmount: 3.7 });
  const { server, port } = boot(db);
  try {
    await claim(port, 'instant');
    assert.equal(db.state.total, 3.7);
    assert.equal(db.state.rpcs[0].name, 'claim_rakeback_instant');
  } finally { server.close(); }
});
