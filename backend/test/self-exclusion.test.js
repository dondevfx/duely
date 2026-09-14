// Self-exclusion: a player locks their own account until a date.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SX = require('../src/services/selfExclusion');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');

function fakeSupabase(until, { fail = false } = {}) {
  const calls = { select: 0 };
  return {
    calls,
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => {
        calls.select++;
        return fail ? { data: null, error: { message: 'column does not exist' } }
                    : { data: { self_excluded_until: until }, error: null };
      } }) }),
    }),
  };
}

test('every event that starts a match is gated; leaving and resuming are not', () => {
  for (const e of ['join_tower_queue', 'join_bj_queue', 'play_color_rush_vs_bot', 'play_bj_vs_bot',
                   'create_private_room', 'join_private_room', 'request_rematch',
                   'tower_rematch_request', 'wordle_solo_start', 'invite_friend']) {
    assert.ok(SX.GATED_EVENTS.test(e), `${e} is not gated`);
  }
  for (const e of ['leave_tower_queue', 'resume_match', 'player_forfeit', 'chat_message',
                   'tower_score_ping', 'authenticate', 'leave_all_queues']) {
    assert.ok(!SX.GATED_EVENTS.test(e), `${e} is gated and should not be`);
  }
});

test('a lock in the future is read, cached, and reported with its date', async () => {
  SX._cache.clear();
  const future = new Date(Date.now() + 3 * 864e5).toISOString();
  const sb = fakeSupabase(future);
  const until = await SX.excludedUntil(sb, 'u1');
  assert.equal(until, Date.parse(future));
  await SX.excludedUntil(sb, 'u1');
  assert.equal(sb.calls.select, 1, 'every game start queried the database');
  assert.match(SX.lockMessage(until), /locked until/);
});

test('before the migration runs, nobody is locked and nothing breaks', async () => {
  SX._cache.clear();
  assert.equal(await SX.excludedUntil(fakeSupabase(null, { fail: true }), 'u2'), 0);
});

test('REST routes refuse a locked account with a 403', async () => {
  SX._cache.clear();
  SX.setExcludedUntil('u3', Date.now() + 864e5);
  let status = 0, body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  assert.equal(await SX.rejectIfExcluded(null, { user: { id: 'u3' } }, res), true);
  assert.equal(status, 403);
  assert.equal(body.selfExcluded, true);
  SX.setExcludedUntil('u4', Date.now() - 1000);
  assert.equal(await SX.rejectIfExcluded(null, { user: { id: 'u4' } }, res), false, 'an expired lock still blocks');
});

test('the gate is wired into the socket, tournaments, tips and deposit addresses, not withdrawals', () => {
  const h = read('src', 'socket', 'handlers.js');
  const conn = h.indexOf("io.on('connection', (socket) => {");
  const gate = h.indexOf('selfExclusion.GATED_EVENTS.test(event)', conn);
  const firstHandler = h.indexOf("socket.on('", conn);
  assert.ok(gate > conn && gate < firstHandler, 'the wrapper must be installed before any handler registers');

  assert.match(read('src', 'routes', 'tournaments.js'), /router\.post\('\/join', requireAuth, async \(req, res\) => \{\s*if \(await rejectIfExcluded/);
  const w = read('src', 'routes', 'wallet.js');
  assert.match(w, /router\.post\('\/tip', requireAuth, async \(req, res\) => \{\s*if \(await rejectIfExcluded/);
  assert.match(w, /router\.post\('\/get-address', requireAuth, async \(req, res\) => \{\s*if \(await rejectIfExcluded/);
  assert.doesNotMatch(w, /router\.post\('\/withdraw', requireAuth, async \(req, res\) => \{\s*if \(await rejectIfExcluded/,
    'a locked player must still be able to withdraw');
});

test('the lock route: tomorrow at the earliest, five years at most, never shortened', () => {
  const a = read('src', 'routes', 'auth.js');
  const r = a.slice(a.indexOf("router.post('/self-exclude'"), a.indexOf("router.patch('/me'"));
  assert.match(r, /until < tomorrowStart/);
  assert.match(r, /5 \* 366 \* DAY/);
  assert.match(r, /current > Date\.now\(\) && until < current/, 'a lock can be shortened');
  assert.match(read('..', 'PENDING_SQL.sql'), /ADD COLUMN IF NOT EXISTS self_excluded_until timestamptz/);
});

test('Settings has the drop-down, the date, and a confirmation; Profile links the FAQ', () => {
  const p = fe('pages', 'Profile.jsx');
  assert.ok(p.includes('<SelfExclusionSection profile={profile} refreshProfile={refreshProfile} />'));
  assert.ok(p.includes('type="date"'));
  assert.ok(p.includes("api.post('/auth/self-exclude', { until })"));
  assert.ok(p.includes('Yes, lock it'), 'no confirmation before an irreversible lock');
  assert.ok(p.includes('<Link to="/faq"'), 'the FAQ is not linked beside the terms');
  assert.ok(fe('App.jsx').includes('<Route path="/faq"'));
  assert.ok(fe('pages', 'FAQ.jsx').includes('<h1 className="text-4xl font-black text-white mb-2">FAQ</h1>'));
});
