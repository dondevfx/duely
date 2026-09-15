// Economy audit #2: each test reproduces a finding, and fails if the fix goes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createStore } = require('../src/services/tournamentPools');
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');

test('V1: the retired daily coin bonus cannot mint a coin, however it is called', async () => {
  const calls = [];
  const supabase = { rpc: async (fn) => { calls.push(fn); return { data: null, error: null }; },
    from: () => ({ insert: () => ({ then: () => ({ catch() {} }) }), select: () => ({ eq: () => ({ single: async () => ({ data: {} }) }) }) }) };
  const authPath = require.resolve('../src/middleware/auth');
  const real = require(authPath);
  require.cache[authPath].exports = { ...real, requireAuth: (req, _r, next) => { req.user = { id: 'u1' }; next(); } };
  delete require.cache[require.resolve('../src/routes/bonus')];
  const app = express(); app.use(express.json());
  app.use('/b', require('../src/routes/bonus')(supabase));
  require.cache[authPath].exports = real;
  delete require.cache[require.resolve('../src/routes/bonus')];
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      fetch(`http://127.0.0.1:${port}/b/claim`, { method: 'POST' }).then(r => r.status)));
    assert.ok(results.every(s => s === 410), `a claim was accepted: ${results}`);
    assert.ok(!calls.includes('claim_daily_bonus'), 'the coin-minting function was reached');
  } finally { server.close(); }
});

test('V2: a demo and a real account never share a tournament pool, in either order', () => {
  const now = Date.now();
  const a = createStore();
  const r1 = a.join({ userId: 'real', username: 'r', entryFee: 5, now }).pool;
  const d1 = a.join({ userId: 'demo', username: 'd', entryFee: 5, now, demo: true }).pool;
  assert.notEqual(r1.id, d1.id, 'a demo was seated in a real pool');
  assert.equal(!!r1.demo, false);
  const b = createStore();
  const d2 = b.join({ userId: 'demo', username: 'd', entryFee: 5, now, demo: true }).pool;
  const r2 = b.join({ userId: 'real', username: 'r', entryFee: 5, now }).pool;
  assert.notEqual(r2.id, d2.id, 'a real player was seated in a demo pool');
  // Two demos still share, and two real players still share.
  assert.equal(b.join({ userId: 'demo2', username: 'd2', entryFee: 5, now, demo: true }).pool.id, d2.id);
  assert.equal(b.join({ userId: 'real2', username: 'r2', entryFee: 5, now }).pool.id, r2.id);
  assert.match(src('routes', 'tournaments.js'), /demo: demo && !vsBot,/, 'the route does not tell the store who is a demo');
});

test('V3: private rooms and invites never pair a demo with a real account', () => {
  const h = src('socket', 'handlers.js');
  assert.match(h, /if \(!!pending\.p1\.isDemo !== !!authenticatedUser\.isDemo\) \{\s*return socket\.emit\('error', \{ message: 'Room not found/);
  assert.match(h, /side, isDemo: !!authenticatedUser\.isDemo \};/, 'the room host is not marked demo or real');
  assert.match(h, /if \(!!isDemoAccount\(friendId\) !== !!authenticatedUser\.isDemo\) return fail\(/, 'a demo can invite a real account');
  // The check sits before the pairing, not after it.
  const join = h.slice(h.indexOf("socket.on('join_private_room'"), h.indexOf('_pairPrivatePlayers(gameType, p1, p2'));
  assert.ok(join.includes('pending.p1.isDemo !== !!authenticatedUser.isDemo'));
});

test('V4: a failed-looking credit never re-opens a bonus that may already have paid', () => {
  const b = src('routes', 'bonus.js');
  assert.ok(!b.includes('update({ signup_bonus_claimed_at: null })'), 'the signup grant can be claimed twice');
  assert.ok(!b.includes('update({ last_spin_claimed: null })'), 'the daily spin re-arms after a lost response');
  assert.ok(b.includes('SIGNUP CLAIM UNRESOLVED') && b.includes('SPIN UNRESOLVED'));
});

test('V5: Play vs Bot never takes over a real waiting room', () => {
  const s = createStore();
  const now = Date.now();
  const real = s.join({ userId: 'real', username: 'r', entryFee: 5, now }).pool;
  const solo = s.join({ userId: 'tester', username: 't', entryFee: 5, now, solo: true }).pool;
  assert.notEqual(solo.id, real.id, 'a vs-bot entry was seated in a real pool');
  assert.equal(real.players.length, 1);
  assert.match(src('routes', 'tournaments.js'), /solo: vsBot,/);
});
