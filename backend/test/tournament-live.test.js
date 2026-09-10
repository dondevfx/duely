const test = require('node:test');
const assert = require('node:assert');

const { createStore } = require('../src/services/tournamentPools');
const { createRunner } = require('../src/services/tournamentRunner');
const hook = require('../src/services/tournamentHook');
const bb = require('../src/services/blockBlastEngine');
const ENGINES = require('../src/services/tournamentEngines');

/**
 * The same path production takes, with a real engine on the end of it.
 *
 * tournament-runner.test.js drives the orchestration against a fake engine,
 * which is the right way to test a bracket. This drives one match on the REAL
 * Block Burst engine instead, because the join between the two is where the
 * whole thing failed before: the runner can be correct and the engines can be
 * correct and a tournament still never finishes a round if the result does not
 * make it from one to the other.
 */

function fakeIo() {
  const sockets = new Map();
  const sent = [];
  return {
    sockets: { sockets },
    emit: (event, payload) => sent.push({ to: '*', event, payload }),
    to: (room) => ({ emit: (event, payload) => sent.push({ to: room, event, payload }) }),
    _sent: sent,
    _connect(userId) {
      const s = {
        id: `sock_${userId}`,
        _authenticatedUserId: userId,
        join: () => {},
        emit: (event, payload) => sent.push({ to: userId, event, payload }),
      };
      sockets.set(s.id, s);
      return s;
    },
    _for: (userId, event) => sent.filter(x => x.to === userId && x.event === event),
  };
}

function boot({ bots = 0 } = {}) {
  hook._reset();
  const pools = createStore();
  const io = fakeIo();
  const runner = createRunner({ io, supabase: null, pools, engines: ENGINES, log: { error() {} } });
  const now = Date.now();
  const { pool } = pools.join({ userId: 'p0', username: 'p0', entryFee: 1, now });
  for (let i = 1; i < 16; i++) {
    const isBot = bots > 0 && i % 2 === 1 && i < bots * 2;
    pools.seat(pool, { userId: `p${i}`, username: `p${i}`, isBot, now });
  }
  for (const p of pool.players) if (!p.isBot) io._connect(p.userId);
  return { pools, io, runner, pool };
}

test('a real Block Burst room reports its winner back into the bracket', async () => {
  const { runner, pool, io } = boot();
  // Round one of this pool is whatever it drew; force the game so the test is
  // about the join and not about which game came up.
  pool.roundGames = pool.roundGames.map(() => 'block-blast');

  runner.startRound(pool);

  const match = pool.bracket[0][0];
  const roomId = [...hook._rooms.keys()].find(id => hook._rooms.get(id).match === 0);
  assert.ok(roomId, 'no room was created for the first match');
  assert.ok(roomId.startsWith('bb_'), `not a Block Burst room: ${roomId}`);

  const room = bb.getBlockBlastRoom(roomId);
  assert.ok(room, 'the engine does not have the room the runner made');
  assert.equal(room.entryFee, 0, 'a bracket round staked real coins');

  // Play it the way the socket handlers do: the room goes active, both players
  // ping a score, both submit.
  room.state = 'active';
  room.startTime = Date.now() - 60_000;
  const [s1, s2] = room.players.map(p => p.socketId);
  room.pingScores[s1] = 900;
  room.pingScores[s2] = 400;

  await bb.handleBlockBlastComplete(io, null, roomId, s1, 900);
  await bb.handleBlockBlastComplete(io, null, roomId, s2, 400);

  assert.equal(match.winner, room.players[0].userId, 'the higher score did not win the match');
  assert.equal(pool.bracket[1][0].a, match.winner, 'the winner was not advanced');
});

test('a real drawn room sends the round to sudden death rather than stalling', async () => {
  const { runner, pool, io } = boot();
  pool.roundGames = pool.roundGames.map(() => 'block-blast');
  runner.startRound(pool);

  const roomId = [...hook._rooms.keys()].find(id => hook._rooms.get(id).match === 0);
  const room = bb.getBlockBlastRoom(roomId);
  room.state = 'active';
  room.startTime = Date.now() - 60_000;
  const [s1, s2] = room.players.map(p => p.socketId);
  room.pingScores[s1] = 500;
  room.pingScores[s2] = 500;

  await bb.handleBlockBlastComplete(io, null, roomId, s1, 500);
  await bb.handleBlockBlastComplete(io, null, roomId, s2, 500);

  assert.ok(!pool.bracket[0][0].winner, 'a tie decided the match');
  const replay = [...hook._rooms.values()].filter(r => r.match === 0 && r.sudden);
  assert.equal(replay.length, 1, 'no sudden-death replay was created');
  assert.equal(io._for('p0', 'tournament_sudden_death').length, 1);
});

test('every game a tournament can draw has an engine behind it', () => {
  // The rotation is drawn from tournamentFormat and played through this table.
  // A game in one and not the other is a round that cannot start, discovered
  // by the players rather than here.
  const F = require('../src/services/tournamentFormat');
  for (const g of F.TOURNAMENT_GAMES) {
    const e = ENGINES[g];
    assert.ok(e, `no engine for ${g}`);
    for (const fn of ['create', 'room', 'begin']) {
      assert.equal(typeof e[fn], 'function', `${g}.${fn}`);
    }
    assert.match(e.event, /_match_found$/, `${g} announces itself as ${e.event}`);
  }
});

test('a real room against a bot is a match, not a practice run', () => {
  // Rush Hour and Colour Rush turn a free game against a bot into a solo run:
  // it reports a time and names no winner, which is the one thing a bracket
  // cannot use. A bracket room is staked at zero, so without clearing the flag
  // every bot match in a tournament would run out its three minutes and be
  // decided on the deadline.
  const cd = require('../src/services/carDashEngine');
  const { runner, pool } = boot({ bots: 8 });
  pool.roundGames = pool.roundGames.map(() => 'car-dash');
  runner.startRound(pool);

  const mixed = [...hook._rooms.keys()]
    .map(id => ({ id, room: cd.getCarDashRoom(id) }))
    .filter(({ room }) => room?.isSolo);
  assert.ok(mixed.length > 0, 'no human was drawn against a bot');
  for (const { room } of mixed) {
    assert.equal(room.soloRun, false, 'played as a practice run');
    assert.equal(room.demoWin, true, 'a bot could knock a real player out');
  }
});

test('the bracket carries a live score for every match being played', async () => {
  // The complaint behind this: between rounds you are looking at a bracket
  // where nothing moves for three minutes, and the person most likely to be
  // looking at it is someone who has just been knocked out of it.
  //
  // Every engine already tracks a running score — it needs one for its own
  // catch-up and anti-cheat — but each keeps it somewhere different, which is
  // why reading it is the adapter's job and not the runner's.
  const { runner, pool, io } = boot();
  pool.roundGames = pool.roundGames.map(() => 'block-blast');
  runner.startRound(pool);

  const roomId = [...hook._rooms.keys()].find(id => hook._rooms.get(id).match === 0);
  const room = bb.getBlockBlastRoom(roomId);
  room.state = 'active';
  room.startTime = Date.now() - 30_000;
  const [s1, s2] = room.players.map(p => p.socketId);
  room.pingScores[s1] = 640;
  room.pingScores[s2] = 310;

  const sampled = runner.sampleScores(pool);
  assert.ok(sampled, 'nothing was sampled while a round was being played');

  const first = sampled.find(x => x.match === 0);
  assert.ok(first, 'the live match is not in the sample');
  assert.equal(first.game, 'block-blast');
  assert.equal(first.a, 640);
  assert.equal(first.b, 310);

  // Every match in the round, not just the one being watched.
  assert.equal(sampled.length, pool.bracket[0].length,
    'only some of the round was reported');
});

test('every game a tournament can draw can be read while it is played', () => {
  // A missing reader is not an error, it is a zero — the bracket would sit at
  // 0-0 for three minutes and look broken rather than look empty.
  const F = require('../src/services/tournamentFormat');
  for (const g of F.TOURNAMENT_GAMES) {
    assert.equal(typeof ENGINES[g].score, 'function', `${g} has no live score`);
  }
});
