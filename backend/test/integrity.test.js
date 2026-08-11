// Win integrity: can a client claim a result it did not earn, or reach into a
// match it is not part of?
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLedger, makeIo, player, botPlayer } = require('./helpers/stubs');

const carDash    = require('../src/services/carDashEngine');
const blockBlast = require('../src/services/blockBlastEngine');
const wordle     = require('../src/services/wordleEngine');

const activeCarDash = (a = 'p1', b = 'p2', agoMs = 5000) => {
  const { roomId } = carDash.createDirectCarDashRoom(player(a, 'u' + a), player(b, 'u' + b));
  const room = carDash.getCarDashRoom(roomId);
  room.state = 'active';
  room.startedAt = Date.now() - agoMs;
  return { roomId, room };
};

// ── Outsiders ──────────────────────────────────────────────────────────────

test('Rush Hour: a stranger cannot touch a match they are not in', async () => {
  const io = makeIo();
  const { supabase } = makeLedger();
  const { roomId, room } = activeCarDash();

  carDash.trackCarDashProgress(roomId, 'INTRUDER', 999999, 999999);
  await carDash.handleCarDashCrash(io, supabase, roomId, 'INTRUDER', 999999);

  assert.notEqual(room.state, 'finished', 'a stranger must not be able to end someone else\'s match');
  assert.deepEqual(room.scores, {}, 'a stranger must not write a score into the room');
  assert.deepEqual(room.progress, {}, 'a stranger must not write progress into the room');
  carDash.deleteCarDashRoom(roomId);
});

test('Block Burst: a stranger\'s score ping is refused outright', () => {
  const { roomId } = blockBlast.createDirectBlockBlastRoom(player('b1','u1'), player('b2','u2'));
  const room = blockBlast.getBlockBlastRoom(roomId);
  room.state = 'active';

  const out = blockBlast.trackBlockBlastScorePing(roomId, 'INTRUDER', 999999);
  assert.equal(out, null, 'a stranger\'s ping must be rejected, not merely clamped');
  assert.ok(!room.pingScores?.INTRUDER, 'a stranger must leave no trace in the room');
  blockBlast.deleteBlockBlastRoom(roomId);
});

test('Word VS: a stranger\'s guess is ignored', () => {
  const io = makeIo();
  const { roomId } = wordle.createDirectWordleRoom(player('w1','u1'), player('w2','u2'));
  const room = wordle.getWordleRoom(roomId);
  const before = JSON.stringify(room.pstate);

  wordle.handleWordleGuess(io, null, roomId, 'INTRUDER', 'crane');

  assert.equal(JSON.stringify(room.pstate), before, 'a stranger must not alter game state');
  assert.ok(!room.settled, 'a stranger must not be able to end the match');
  wordle.deleteWordleRoom(roomId);
});

// ── Inflated claims ────────────────────────────────────────────────────────

test('Rush Hour: an absurd score is clamped to what the clock allows', () => {
  const { roomId, room } = activeCarDash('c1', 'c2', 10_000);
  carDash.trackCarDashProgress(roomId, 'c1', 10_000, 99_999_999);
  // Derived from the engine, not copied. A hardcoded mirror of SCORE_RATE_CAP
  // fails the moment the speed ramp moves — which is a stale test, not a real
  // regression. The assertion that carries weight is the one below: a fabricated
  // score must still be cut down by orders of magnitude whatever the ceiling is.
  const cap = 10 * carDash.SCORE_RATE_CAP + 500;    // mirrors maxScoreFor
  assert.ok(room.scores.c1 <= cap,
    `claimed 99,999,999 and kept ${room.scores.c1}, cap is ${cap}`);
  assert.ok(room.scores.c1 < 99_999_999 / 100,
    'a fabricated score must still be cut down by orders of magnitude');
  carDash.deleteCarDashRoom(roomId);
});

test('the score ceiling leaves room for the fastest legitimate play', () => {
  // Distance alone at top speed, plus a chained near miss, must fit under the
  // clamp — otherwise an honest player loses matches they won.
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'HighwayCanvas.jsx'), 'utf8');
  const num = (re) => Number(String(client.match(re)[1]).replace(/_/g, ''));

  const ptsDist  = num(/const PTS_DIST\s*=\s*([\d._]+);/);
  const ptsTime  = num(/const PTS_TIME\s*=\s*([\d._]+);/);
  const ptsNear  = num(/const PTS_NEAR\s*=\s*([\d._]+);/);
  const comboMax = num(/const COMBO_MAX\s*=\s*([\d._]+);/);
  const spdMax   = num(/const SPD_MAX\s*=\s*([\d._]+);/);
  const odSpeed  = num(/const OD_SPEED\s*=\s*([\d._]+);/);
  const odMax    = num(/const OD_SPEED_MAX\s*=\s*([\d._]+);/);

  const topSpeed = spdMax + odSpeed * odMax;
  const perSec   = ptsDist * topSpeed + ptsTime + 1.5 * ptsNear * comboMax;

  const server = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  const capRate = Number(
    server.match(/const SCORE_RATE_CAP = ([\d_]+);/)[1].replace(/_/g, ''));

  assert.ok(capRate >= perSec,
    `server clamps at ${capRate}/s but legitimate play can reach ${Math.round(perSec)}/s ` +
    '— honest scores would be clipped');
});

test('Rush Hour: survival time cannot exceed the wall clock', () => {
  const { roomId } = activeCarDash('d1', 'd2', 3000);
  const ms = carDash.trackCarDashProgress(roomId, 'd1', 60 * 60 * 1000, 100);
  assert.ok(ms <= 3500, `claimed an hour of survival and kept ${ms}ms`);
  carDash.deleteCarDashRoom(roomId);
});

test('Block Burst: the token bucket caps a spammed score', () => {
  const { roomId } = blockBlast.createDirectBlockBlastRoom(player('e1','u1'), player('e2','u2'));
  blockBlast.getBlockBlastRoom(roomId).state = 'active';
  let last = 0;
  for (let i = 0; i < 5; i++) {
    last = blockBlast.trackBlockBlastScorePing(roomId, 'e1', 99_999_999) ?? last;
  }
  assert.ok(last < 99_999_999, `spamming a huge score kept ${last}`);
  blockBlast.deleteBlockBlastRoom(roomId);
});

// ── The other side of the guard: real actors must still work ───────────────
//
// A membership check that is even slightly too strict silently breaks every bot
// match, because bots drive the same handlers as humans using synthetic socket
// ids. That nearly shipped once.

test('a real player is still accepted everywhere', () => {
  const { roomId, room } = activeCarDash('r1', 'r2', 4000);
  const ms = carDash.trackCarDashProgress(roomId, 'r1', 3000, 500);
  assert.notEqual(ms, null, 'a genuine player\'s progress must be accepted');
  assert.equal(room.scores.r1, 500);
  carDash.deleteCarDashRoom(roomId);

  const { roomId: bbId } = blockBlast.createDirectBlockBlastRoom(player('g1','u1'), player('g2','u2'));
  blockBlast.getBlockBlastRoom(bbId).state = 'active';
  assert.ok(blockBlast.trackBlockBlastScorePing(bbId, 'g1', 1200) > 0,
    'a genuine player\'s score ping must be accepted');
  blockBlast.deleteBlockBlastRoom(bbId);
});

test('bots are room members and can still act', () => {
  const io = makeIo();
  const { roomId } = wordle.createDirectWordleRoom(player('s1','u1'), botPlayer('wbot'));
  const room = wordle.getWordleRoom(roomId);
  room.word = 'CRANE';

  assert.ok(room.players.some((p) => p.socketId === 'wbot'),
    'the bot must appear in room.players, or the membership guard blocks it');

  wordle.handleWordleGuess(io, null, roomId, 's1', 'stare');
  wordle.handleWordleGuess(io, null, roomId, 'wbot', 'slate');

  assert.equal(room.pstate['s1']?.guesses?.length, 1, 'the human\'s guess must register');
  assert.equal(room.pstate['wbot']?.guesses?.length, 1, 'the bot\'s guess must register');
  wordle.deleteWordleRoom(roomId);
});

test('a human in a match against a bot is still tracked', () => {
  const { roomId } = carDash.createDirectCarDashRoom(player('h1','uh'), botPlayer('botsock'));
  const room = carDash.getCarDashRoom(roomId);
  room.state = 'active';
  room.startedAt = Date.now() - 4000;
  assert.notEqual(carDash.trackCarDashProgress(roomId, 'h1', 3000, 400), null);
  carDash.deleteCarDashRoom(roomId);
});
