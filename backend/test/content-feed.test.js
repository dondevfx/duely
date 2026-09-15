// GET /api/v1/content-feed — auth, privacy, pseudonyms, counting, schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

process.env.DEMO_ACCOUNT_IDS = 'dddddddd-0000-4000-8000-000000000001';
const contentFeedRoutes = require('../src/routes/contentFeed');
const feed = require('../src/services/contentFeed');
const F = require('../src/services/tournamentFormat');

const KEY = 'test-content-feed-key-0123456789abcdef';
const SECRET = 'test-pseudonym-secret-0123456789abcdef';
const ADMIN = 'aaaaaaaa-0000-4000-8000-00000000000a';
const DEMO = 'dddddddd-0000-4000-8000-000000000001';
const TESTER = 'eeeeeeee-0000-4000-8000-00000000000e';
const U = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 2026-09-15 18:00 UTC
const NOW = Date.UTC(2026, 8, 15, 18, 0, 0);
const at = (h, m = 0, s = 0) => new Date(Date.UTC(2026, 8, 15, h, m, s)).toISOString();
const yesterday = new Date(Date.UTC(2026, 8, 14, 22, 0, 0)).toISOString();

const USERNAMES = { [U(1)]: 'alice_real', [U(2)]: 'bob_real', [U(3)]: 'carol_private', [U(4)]: 'dan_banned', [U(5)]: 'erin_real', [U(6)]: 'frank_real' };

function fixture() {
  const profiles = [
    { id: U(1), username: 'alice_real', email: 'alice@example.com', wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', elo: 1842, wins: 20, losses: 5, is_private: false, banned: false, created_at: at(3) },
    { id: U(2), username: 'bob_real', email: 'bob@example.com', elo: 1795, wins: 9, losses: 9, is_private: false, banned: false, created_at: yesterday },
    { id: U(3), username: 'carol_private', email: 'carol@example.com', elo: 2500, wins: 50, losses: 1, is_private: true, banned: false, created_at: at(4) },
    { id: U(4), username: 'dan_banned', email: 'dan@example.com', elo: 2400, wins: 40, losses: 1, is_private: false, banned: true, created_at: yesterday },
    { id: U(5), username: 'erin_real', elo: 1500, wins: 2, losses: 0, is_private: false, banned: false, created_at: at(10) }, // not placed
    { id: U(6), username: 'frank_real', elo: 0, wins: 3, losses: 3, is_private: false, banned: false, created_at: yesterday },    // placed, shown at 1000
    { id: DEMO, username: 'demo_acct', elo: 3000, wins: 99, losses: 0, is_private: false, created_at: at(5) },
    { id: TESTER, username: 'qa_tester', elo: 2900, wins: 99, losses: 0, is_private: false, created_at: at(6) },
    { id: ADMIN, username: 'the_admin', elo: 2800, wins: 99, losses: 0, is_private: false, created_at: at(7) },
  ];
  const m = (p1, p2, game, when, extra = {}) => ({ player1_id: p1, player2_id: p2, winner_id: p1, game_type: game, entry_fee_c: 5, entry_fee_diamonds: 0, played_at: when, ...extra });
  const matches = [
    m(U(1), U(2), 'colorRush', at(9)),
    m(U(1), U(2), 'colorRush', at(9, 0, 3)),          // duplicate settlement, 3s later
    m(U(2), U(1), 'tower', at(11)),
    m(U(1), null, 'tower', at(12)),                   // vs bot, not a duel
    m(U(1), DEMO, 'tower', at(12)),                   // demo
    m(U(2), TESTER, 'tower', at(12)),                 // test account
    m(U(1), U(2), 'tower', at(13), { status: 'cancelled' }),
    m(U(1), null, 'tournament', at(13)),              // tournament entry row
    m(U(1), U(2), 'tower', yesterday),                // not today
  ];
  const w = (uid, amount, notes, when, extra = {}) => ({ user_id: uid, type: 'match_win', amount_c: amount, status: 'confirmed', notes, created_at: when, ...extra });
  const transactions = [
    w(U(1), 9.5, 'Color Rush vs bob_real', at(9)),
    w(U(1), 9.5, 'Color Rush vs bob_real', at(9, 0, 2)),  // duplicate settlement
    w(U(2), 19, 'Tower vs alice_real', at(11)),
    w(U(3), 500, 'Tower vs alice_real', at(12)),          // private: counted, never named
    w(U(4), 400, 'Tower vs alice_real', at(12, 30)),      // banned: counted, never named
    w(DEMO, 1000, 'Tower vs alice_real', at(13)),         // demo: not counted
    w(TESTER, 900, 'Tower vs bob_real', at(13)),          // test: not counted
    w(U(1), 50, 'Tower vs bob_real', at(14), { status: 'pending' }),
    w(U(2), 7.25, 'Tournament — 2nd of 3', at(15)),
    w(U(1), 30, 'Block Burst vs bob_real', yesterday),    // recent, not today
    { user_id: U(1), type: 'match_loss', amount_c: 5, status: 'confirmed', notes: 'x', created_at: at(9) },
  ];
  return { profiles, matches, transactions };
}

// A Supabase stand-in: honours in(), range() and writes to content_pseudonyms,
// records every call, and fails a table on request.
function fakeSupabase(fx, { fail = new Set(), throwOn = new Set() } = {}) {
  const calls = [];
  const pseud = new Map();
  const from = (table) => {
    if (throwOn.has(table)) throw new Error(`boom SELECT * FROM ${table} WHERE id='${U(1)}' alice@example.com`);
    const state = { table, op: 'select', inIds: null };
    const rows = () => ({ matches: fx.matches, transactions: fx.transactions, profiles: fx.profiles })[table] || [];
    const chain = {
      select(cols) { calls.push({ table, op: 'select', cols }); return chain; },
      gte() { return chain; }, gt() { return chain; }, eq() { return chain; }, neq() { return chain; },
      not() { return chain; }, order() { return chain; }, limit() { return chain; },
      in(_c, ids) { state.inIds = ids; return chain; },
      insert(row) {
        calls.push({ table, op: 'insert', row });
        if (table !== 'content_pseudonyms') return Promise.resolve({ error: { message: 'denied' } });
        if (pseud.has(row.digest)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key content_pseudonyms_pkey' } });
        if ([...pseud.values()].includes(row.name)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key content_pseudonyms_name_key' } });
        pseud.set(row.digest, row.name);
        return Promise.resolve({ error: null });
      },
      update() { calls.push({ table, op: 'update' }); return chain; },
      delete() { calls.push({ table, op: 'delete' }); return chain; },
      upsert() { calls.push({ table, op: 'upsert' }); return chain; },
      range(a, b) { return chain.then ? resolve(a, b) : null; },
      then(res, rej) { return resolve(0, 1e9).then(res, rej); },
    };
    const resolve = (a, b) => {
      if (fail.has(table)) return Promise.resolve({ data: null, error: { message: `relation "${table}" column secret_col does not exist SELECT id, email FROM profiles` } });
      if (table === 'content_pseudonyms') {
        const data = [...pseud].filter(([d]) => !state.inIds || state.inIds.includes(d)).map(([digest, name]) => ({ digest, name }));
        return Promise.resolve({ data, error: null });
      }
      let data = rows();
      if (state.inIds) data = data.filter(r => state.inIds.includes(r.id));
      return Promise.resolve({ data: data.slice(a, b + 1), error: null });
    };
    return chain;
  };
  return { from, rpc: (...a) => { calls.push({ op: 'rpc', a }); return Promise.resolve({ error: { message: 'no' } }); }, calls, pseud };
}

function pools() {
  const slot = F.joinableSlot(NOW);
  const seat = (n, bots = 0) => [...Array(n)].map((_, i) => ({ userId: U(100 + i), username: `real_player_${i}` }))
    .concat([...Array(bots)].map((_, i) => ({ userId: `bot-${i}`, username: `Bot${i}`, isBot: true })));
  const list = [
    { id: 'p1', state: 'filling', slotStart: slot.startsAt, entryFee: 5, players: seat(12) },
    { id: 'p2', state: 'filling', slotStart: slot.startsAt, entryFee: 1, players: seat(15), demo: true },  // demo
    { id: 'p3', state: 'filling', slotStart: slot.startsAt, entryFee: 10, players: seat(1, 15), free: true }, // Play vs Bot
    { id: 'p4', state: 'running', slotStart: slot.startsAt, entryFee: 1, players: seat(16) },
    { id: 'p5', state: 'filling', slotStart: slot.startsAt - 1, entryFee: 1, players: seat(14) },          // old slot
    { id: 'p6', state: 'filling', slotStart: slot.startsAt, entryFee: 7, players: seat(14) },              // invalid stake
  ];
  return { pools: new Map(list.map(p => [p.id, p])) };
}

async function boot({ fx = fixture(), sb, env = {}, limiter, logs = [], poolStore = pools() } = {}) {
  const supabase = sb || fakeSupabase(fx);
  const log = { error: (...a) => logs.push(a), warn: (...a) => logs.push(a), log: (...a) => logs.push(a) };
  const app = express();
  app.use('/api/v1/content-feed', contentFeedRoutes(supabase, {
    pools: poolStore,
    env: { CONTENT_FEED_API_KEY: KEY, CONTENT_FEED_PSEUDONYM_SECRET: SECRET, ADMIN_USER_ID: ADMIN, CONTENT_FEED_EXCLUDE_USER_IDS: TESTER, ...env },
    now: () => NOW, limiter, log,
  }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/content-feed`;
  const call = (opts = {}) => fetch(base, opts).then(async r => ({ status: r.status, text: await r.text(), headers: r.headers }));
  return { call, supabase, logs, close: () => new Promise(r => server.close(r)) };
}
const auth = (k = KEY) => ({ headers: { Authorization: `Bearer ${k}` } });

// ── 1–4 authentication ─────────────────────────────────────────────────────
test('no key, a malformed key and a wrong key are 401; the right key is 200', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call()).status, 401);
    assert.equal((await s.call({ headers: { Authorization: KEY } })).status, 401);             // not Bearer
    assert.equal((await s.call({ headers: { Authorization: 'Basic abc' } })).status, 401);
    assert.equal((await s.call(auth(KEY + 'x'))).status, 401);
    assert.equal((await s.call(auth('wrong-key-wrong-key-wrong-key-wrong'))).status, 401);
    const ok = await s.call(auth());
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /no-store/);
  } finally { await s.close(); }
});

test('an unset or short key refuses everyone, even a matching one', async () => {
  for (const k of [undefined, '', 'short']) {
    const s = await boot({ env: { CONTENT_FEED_API_KEY: k } });
    try {
      assert.equal((await s.call()).status, 401);
      assert.equal((await s.call(auth(k || ''))).status, 401);
    } finally { await s.close(); }
  }
});

test('no pseudonym secret: 503, never names without one', async () => {
  const s = await boot({ env: { CONTENT_FEED_PSEUDONYM_SECRET: '' } });
  try { assert.equal((await s.call(auth())).status, 503); } finally { await s.close(); }
});

// ── 5 read-only ────────────────────────────────────────────────────────────
test('the key cannot mutate: every other method is 405 and touches nothing', async () => {
  const s = await boot();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await s.call({ method, ...auth(), body: JSON.stringify({ c_coins: 1e6 }) });
      assert.equal(r.status, 405, method);
    }
    assert.equal(s.supabase.calls.length, 0);
  } finally { await s.close(); }
});

test('a GET only reads, and only writes a pseudonym row', async () => {
  const s = await boot();
  try {
    await s.call(auth());
    const writes = s.supabase.calls.filter(c => c.op !== 'select');
    assert.ok(writes.every(c => c.op === 'insert' && c.table === 'content_pseudonyms'), JSON.stringify(writes));
    for (const w of writes) assert.deepEqual(Object.keys(w.row).sort(), ['digest', 'name']);
    // Never selects identifying columns.
    for (const c of s.supabase.calls.filter(c => c.op === 'select')) {
      assert.doesNotMatch(c.cols, /username|email|wallet|c_coins|(^|, )diamonds|avatar/, c.cols);
    }
  } finally { await s.close(); }
});

test('the key is used by the content feed route and nowhere else', () => {
  const src = path.join(__dirname, '..', 'src');
  const hits = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('CONTENT_FEED_API_KEY')) hits.push(path.relative(src, p));
  });
  walk(src);
  assert.deepEqual(hits.map(h => h.replace(/\\/g, '/')), ['routes/contentFeed.js']);
  // And it is not a Supabase key: the route never builds a client from it.
  assert.doesNotMatch(fs.readFileSync(path.join(src, 'routes', 'contentFeed.js'), 'utf8'), /createClient/);
});

// ── 6–13 privacy ───────────────────────────────────────────────────────────
test('no emails, ids, wallets, tokens, usernames, demo, test, private or banned players leave', async () => {
  const fx = fixture();
  const s = await boot({ fx });
  try {
    const r = await s.call(auth());
    assert.equal(r.status, 200);
    const text = r.text;
    assert.doesNotMatch(text, /@/);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/i);
    assert.doesNotMatch(text, /0x[0-9a-f]{10}/i);
    assert.doesNotMatch(text, /eyJ|Bearer|test-content-feed-key|test-pseudonym-secret/);
    for (const p of fx.profiles) assert.ok(!text.includes(p.username), p.username);
    for (const name of Object.values(USERNAMES)) assert.ok(!text.includes(name));
    assert.ok(!text.includes('real_player_'));
    assert.doesNotMatch(text, /"(id|user_id|userId|email|username|wallet_address|notes|player1_id)"/);
    const body = JSON.parse(text);
    // Private and banned winners are the two biggest wins — and are not featured.
    assert.notEqual(body.biggest_win.amount, 500);
    assert.notEqual(body.biggest_win.amount, 400);
    assert.equal(body.leaderboard.length, 3); // alice, bob, frank — not carol/dan/demo/tester/admin/erin
  } finally { await s.close(); }
});

test('quotes are always null: Duely has no quote field', async () => {
  const fx = fixture();
  fx.transactions.forEach(t => { t.quote = 'I love Duely!'; t.testimonial = 'Best site'; });
  const s = await boot({ fx });
  try {
    const body = JSON.parse((await s.call(auth())).text);
    for (const w of body.recent_winners) assert.equal(w.quote, null);
    assert.doesNotMatch(JSON.stringify(body), /love Duely|Best site/);
  } finally { await s.close(); }
});

test('assertPublicSafe refuses a raw row, and the route answers 500 without detail', async () => {
  assert.throws(() => feed.assertPublicSafe({ x: { id: U(1) } }));
  assert.throws(() => feed.assertPublicSafe({ x: 'alice@example.com' }));
  assert.throws(() => feed.assertPublicSafe({ x: U(1) }));
  assert.throws(() => feed.assertPublicSafe({ w: '0xabcdefabcdefabcdefabcdefabcdef' }));
  assert.throws(() => feed.assertPublicSafe({ t: 'eyJhbGciOi.eyJzdWIiOi.sig' }));
  assert.throws(() => feed.assertPublicSafe({ n: 'alice_real' }, { forbidden: new Set(['alice_real']) }));
  assert.doesNotThrow(() => feed.assertPublicSafe({ n: 'NeonTiger' }, { forbidden: new Set(['Tiger']) }));
});

// ── pseudonyms ─────────────────────────────────────────────────────────────
test('same user → same name; different users → different names; not derived from the username', async () => {
  const ids = [...Array(300)].map((_, i) => U(1000 + i));
  const a = await feed.resolvePseudonyms(ids, { secret: SECRET });
  const b = await feed.resolvePseudonyms([...ids].reverse(), { secret: SECRET });
  for (const id of ids) assert.equal(a.get(id), b.get(id));
  assert.equal(new Set(a.values()).size, ids.length, 'unique across 300 users');
  for (const n of a.values()) assert.match(n, /^[A-Z][a-z]+[A-Z][a-z]+(\d{2})?$/);
  // A different secret gives different names: the mapping needs the secret.
  const c = await feed.resolvePseudonyms(ids, { secret: SECRET.replace('0', '9') });
  assert.ok(ids.filter(id => a.get(id) === c.get(id)).length < 10);
});

test('collisions are resolved: two users with the same first choice get different, stored names', async () => {
  const ids = [...Array(3000)].map((_, i) => U(5000 + i));
  const first = new Map();
  let pair = null;
  for (const id of ids) {
    const n = feed.candidateName(SECRET, feed.pseudonymDigest(SECRET, id), 0);
    if (first.has(n)) { pair = [first.get(n), id]; break; }
    first.set(n, id);
  }
  assert.ok(pair, 'found a natural collision');
  const sb = fakeSupabase(fixture());
  const store = {
    load: async (digests) => new Map([...sb.pseud].filter(([d]) => digests.includes(d))),
    claim: async (digest, name) => {
      const { error } = await sb.from('content_pseudonyms').insert({ digest, name });
      return !error ? 'ok' : /pkey/.test(error.message) ? 'exists' : 'taken';
    },
  };
  const one = await feed.resolvePseudonyms(pair, { secret: SECRET, store });
  assert.notEqual(one.get(pair[0]), one.get(pair[1]));
  // Later, each alone, in the other order: still the same names.
  const again1 = await feed.resolvePseudonyms([pair[1]], { secret: SECRET, store });
  const again0 = await feed.resolvePseudonyms([pair[0]], { secret: SECRET, store });
  assert.equal(again1.get(pair[1]), one.get(pair[1]));
  assert.equal(again0.get(pair[0]), one.get(pair[0]));
  // The store holds digests, never ids.
  for (const [d] of sb.pseud) { assert.match(d, /^[0-9a-f]{64}$/); assert.ok(!pair.includes(d)); }
});

test('a pseudonym is never a real username', async () => {
  const id = U(1);
  const natural = feed.candidateName(SECRET, feed.pseudonymDigest(SECRET, id), 0);
  const m = await feed.resolvePseudonyms([id], { secret: SECRET, avoid: new Set([natural]) });
  assert.notEqual(m.get(id), natural);
});

test('one user in several sections has one name everywhere', async () => {
  const s = await boot();
  try {
    const body = JSON.parse((await s.call(auth())).text);
    const aliceName = (await feed.resolvePseudonyms([U(1)], { secret: SECRET })).get(U(1));
    const bobName = (await feed.resolvePseudonyms([U(2)], { secret: SECRET })).get(U(2));
    assert.equal(body.biggest_win.display_name, bobName);          // 19 today
    assert.equal(body.leaderboard[0].display_name, aliceName);
    assert.equal(body.leaderboard[1].display_name, bobName);
    assert.ok(body.recent_winners.some(w => w.display_name === aliceName));
    assert.ok(body.recent_winners.some(w => w.display_name === bobName));
  } finally { await s.close(); }
});

// ── counting ───────────────────────────────────────────────────────────────
test('real numbers: duels, paid out, new players, biggest win, board, tournament', async () => {
  const s = await boot();
  try {
    const body = JSON.parse((await s.call(auth())).text);
    // colorRush once (duplicate dropped) + tower; not bot, demo, test, cancelled, tournament, yesterday.
    assert.equal(body.totals.duels_today, 2);
    // 9.5 (deduped) + 19 + 500 private + 400 banned + 7.25; not demo, test, pending, yesterday.
    assert.equal(body.totals.paid_out_today, 935.75);
    // alice, carol, erin today; not demo, tester, admin.
    assert.equal(body.totals.new_players_today, 3);
    assert.deepEqual({ game: body.biggest_win.game, amount: body.biggest_win.amount }, { game: 'Tower', amount: 19 });
    assert.deepEqual(body.recent_winners.map(w => [w.game, w.amount]),
      [['Tournament', 7.25], ['Tower', 19], ['Color Rush', 9.5], ['Block Burst', 30]]);
    assert.deepEqual(body.leaderboard.map(p => [p.rank, p.elo]), [[1, 1842], [2, 1795], [3, 1000]]);
    const nt = body.next_tournament;
    assert.equal(nt.entrants, 12);                   // the real 5-coin bracket; not demo, free, running, old or invalid
    assert.equal(nt.spots_left, 4);
    assert.equal(nt.entry_fee, 5);
    assert.equal(nt.prize, F.prizesFor(5).net);
    assert.equal(nt.start_time, new Date(F.joinableSlot(NOW).closesAt).toISOString());
    assert.equal(nt.game, null);                     // not revealed before round one
  } finally { await s.close(); }
});

test('cancelled and duplicate results are not counted', () => {
  const dayStart = feed.utcDayStart(NOW);
  const excluded = new Set();
  const base = { player1_id: U(1), player2_id: U(2), game_type: 'tower', entry_fee_c: 1, played_at: at(10) };
  assert.equal(feed.countDuels([base, { ...base, played_at: at(10, 0, 5) }], { excluded, dayStart }), 1);
  assert.equal(feed.countDuels([base, { ...base, player1_id: U(2), player2_id: U(1), played_at: at(10, 0, 1) }], { excluded, dayStart }), 1);
  assert.equal(feed.countDuels([base, { ...base, played_at: at(10, 5) }], { excluded, dayStart }), 2); // a rematch
  assert.equal(feed.countDuels([{ ...base, status: 'cancelled' }, { ...base, status: 'abandoned' }], { excluded, dayStart }), 0);
  const tx = { user_id: U(1), type: 'match_win', status: 'confirmed', amount_c: 5, notes: 'Tower vs x', created_at: at(10) };
  assert.equal(feed.coinWins([tx, { ...tx, created_at: at(10, 0, 9) }], { excluded }).length, 1);
  assert.equal(feed.coinWins([tx, { ...tx, status: 'failed' }, { ...tx, status: 'pending' }], { excluded }).length, 1);
});

test('invalid tournament data is not exposed', () => {
  const slot = F.joinableSlot(NOW);
  const bad = [
    { state: 'filling', slotStart: slot.startsAt, entryFee: 5, players: [...Array(40)].map((_, i) => ({ userId: `x${i}` })) }, // over capacity
    { state: 'filling', slotStart: slot.startsAt, entryFee: -1, players: [{ userId: 'x' }] },
    { state: 'filling', slotStart: slot.startsAt, entryFee: 1, players: [{ userId: 'b', isBot: true }] },
    null,
  ];
  const nt = feed.nextTournament(bad, NOW);
  assert.equal(nt.entrants, 0);
  assert.equal(nt.spots_left, F.POOL_SIZE);
  assert.equal(nt.entry_fee, F.ENTRY_FEES[0]);
  assert.deepEqual(Object.keys(nt).sort(), ['entrants', 'entry_fee', 'game', 'possible_games', 'prize', 'spots_left', 'start_time']);
});

test('game names come only from the known list, never the rest of the note', () => {
  assert.equal(feed.gameFromNote('Tower vs alice_real'), 'Tower');
  assert.equal(feed.gameFromNote('Tournament — 1st of 3'), 'Tournament');
  assert.equal(feed.gameFromNote('alice_real'), null);
  assert.equal(feed.gameFromNote('Towerish vs x'), null);
  assert.equal(feed.gameFromNote(null), null);
});

// ── 17 rate limit ──────────────────────────────────────────────────────────
test('rate limited at 30 an hour, bad keys included', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 15; i++) await s.call(auth('nope-nope-nope-nope-nope-nope-nope-1'));
    for (let i = 0; i < 15; i++) assert.equal((await s.call(auth())).status, 200);
    assert.equal((await s.call(auth())).status, 429);
  } finally { await s.close(); }
});

// ── 18 errors ──────────────────────────────────────────────────────────────
test('database errors are not leaked; a failed source nulls its section only', async () => {
  const logs = [];
  const s = await boot({ sb: fakeSupabase(fixture(), { fail: new Set(['matches']), throwOn: new Set(['transactions']) }), logs });
  try {
    const r = await s.call(auth());
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /relation|secret_col|SELECT|FROM|boom|example\.com|stack/i);
    const body = JSON.parse(r.text);
    assert.equal(body.totals.duels_today, null);
    assert.equal(body.totals.paid_out_today, null);
    assert.equal(body.biggest_win, null);
    assert.equal(body.recent_winners, null);
    assert.equal(typeof body.totals.new_players_today, 'number');
    const logged = JSON.stringify(logs);
    assert.doesNotMatch(logged, /[0-9a-f]{8}-[0-9a-f]{4}-|@|alice|secret_col|SELECT/);
  } finally { await s.close(); }
});

test('a failed tournament source nulls only that section', async () => {
  const logs = [];
  const poolStore = { get pools() { throw new Error(`crash for ${U(1)} alice_real`); } };
  const s = await boot({ logs, poolStore });
  try {
    const r = await s.call(auth());
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).next_tournament, null);
    assert.doesNotMatch(r.text + JSON.stringify(logs), /alice_real|crash|[0-9a-f]{8}-[0-9a-f]{4}-/);
  } finally { await s.close(); }
});

test('if anything identifying would leave, the answer is a bare 500 and the log names nothing', async () => {
  const logs = [];
  const sb = fakeSupabase(fixture());
  // A corrupted pseudonym row holding a raw user id.
  sb.pseud.set(feed.pseudonymDigest(SECRET, U(1)), U(1));
  const s = await boot({ sb, logs });
  try {
    const r = await s.call(auth());
    assert.equal(r.status, 500);
    assert.equal(r.text, '{"error":"Feed unavailable"}');
    assert.doesNotMatch(JSON.stringify(logs), /[0-9a-f]{8}-[0-9a-f]{4}-|alice|unsafe value at/);
  } finally { await s.close(); }
});

// ── schema ─────────────────────────────────────────────────────────────────
test('response schema is stable', async () => {
  const s = await boot();
  try {
    const body = JSON.parse((await s.call(auth())).text);
    const keys = (o) => Object.keys(o).sort();
    assert.deepEqual(keys(body), ['biggest_win', 'leaderboard', 'next_tournament', 'recent_winners', 'totals', 'updated_at']);
    assert.match(body.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(keys(body.totals), ['duels_today', 'new_players_today', 'paid_out_today']);
    for (const v of Object.values(body.totals)) assert.equal(typeof v, 'number');
    assert.deepEqual(keys(body.biggest_win), ['amount', 'display_name', 'game']);
    for (const w of body.recent_winners) {
      assert.deepEqual(keys(w), ['amount', 'display_name', 'game', 'quote', 'won_at']);
      assert.equal(typeof w.display_name, 'string'); assert.equal(typeof w.amount, 'number');
    }
    for (const p of body.leaderboard) assert.deepEqual(keys(p), ['display_name', 'elo', 'rank']);
    assert.ok(body.leaderboard.length <= 5);
    assert.ok(body.recent_winners.length <= 5);
  } finally { await s.close(); }
});
