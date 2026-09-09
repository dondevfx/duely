const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');

const { createStore } = require('../src/services/tournamentPools');
const { createRunner } = require('../src/services/tournamentRunner');
const hook = require('../src/services/tournamentHook');
const ENGINES = require('../src/services/tournamentEngines');

/**
 * A real socket server, a real socket client, and a real bracket.
 *
 * Everything else about tournaments is tested in-process, which proves the
 * rules and proves the engines report back. It does not prove the one thing
 * the player actually experiences: that the events which move them off the
 * bracket screen and into a game are emitted, addressed to them, and shaped
 * the way the screen reads them. A tournament that never leaves the bracket
 * page looks identical from the inside to one that works.
 *
 * So this connects over a socket the way the app does, joins a bot bracket the
 * way "Play vs Bot" does, and follows one player from entering to being handed
 * a game to play.
 */

function boot() {
  hook._reset();
  const server = http.createServer();
  const io = new Server(server, { cors: { origin: '*' } });
  const pools = createStore();
  const runner = createRunner({
    io, supabase: null, pools, engines: ENGINES, log: { error() {} },
    // The real values with the waiting taken out. What is being tested is the
    // sequence, not how long the pauses are.
    timings: { pick: 60, intermission: 40, ready: 200, match: 4000, overrun: 200, grace: 300 },
  });
  return { server, io, pools, runner };
}

/** Connect, and tell the server who this socket is — see the note in the test. */
function connect(port, userId) {
  return new Promise((resolve, reject) => {
    const c = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    c.on('connect_error', reject);
    c.on('connect', () => resolve(c));
  });
}

/**
 * Listen from the moment the client connects, not from the moment the test
 * gets round to it.
 *
 * The events come in a burst — a bot bracket's update, draw and match all land
 * within a few seconds — so awaiting one and then subscribing to the next
 * misses whatever arrived in between. That is not a testing detail: it is the
 * same race the bracket screen loses when it is still navigating, and the
 * reason the pool carries its phase as well as announcing it.
 */
function record(client, events) {
  const got = new Map();
  const waiters = new Map();
  for (const ev of events) {
    client.on(ev, (payload) => {
      if (!got.has(ev)) got.set(ev, payload);
      waiters.get(ev)?.(payload);
    });
  }
  return (event, ms = 4000) => {
    if (got.has(event)) return Promise.resolve(got.get(event));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`never received ${event}`)), ms);
      waiters.set(event, (p) => { clearTimeout(t); resolve(p); });
    });
  };
}

test('a player entering a bot bracket is carried from the bracket into a game', async (t) => {
  const { server, io, pools, runner } = boot();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const client = await connect(port);

  t.after(() => { client.close(); io.close(); server.close(); });

  // The socket layer stamps this on `authenticate`; the runner is what reads
  // it, and it is the only thing about the socket the runner cares about.
  // Driving the real auth handler would mean a real Supabase token, which is
  // not what this test is about.
  const serverSide = [...io.sockets.sockets.values()][0];
  serverSide._authenticatedUserId = 'me';

  const waitFor = record(client, ['tournament_update', 'tournament_round_starting', 'tournament_match']);

  const now = Date.now();
  const { pool } = pools.join({ userId: 'me', username: 'Me', entryFee: 1, now });
  pool.free = true;
  for (let i = 1; i < 16; i++) {
    pools.seat(pool, { userId: `bot:${i}`, username: `Bot ${i}`, isBot: true, now });
  }
  assert.equal(pool.state, 'running', 'a full bracket did not start');

  // The clock. Nothing else nudges a pool along, deliberately — see tick().
  const clock = setInterval(() => runner.tick(), 20);
  t.after(() => clearInterval(clock));

  // What the bracket screen waits for, in the order it waits for it.
  const update = await waitFor('tournament_update');
  assert.equal(update.pool.id, pool.id);
  assert.equal(update.started, true);
  assert.ok(Array.isArray(update.pool.bracket), 'the bracket was not sent');
  assert.ok(update.pool.players.every(p => !('isBot' in p)), 'the bots are identifiable');

  const starting = await waitFor('tournament_round_starting');
  assert.equal(starting.round, 0);
  assert.ok(starting.game, 'no game to draw');
  assert.ok(starting.at > Date.now() - 1000, 'the draw has no deadline to run to');

  // And the one that moves them off the screen.
  const match = await waitFor('tournament_match');
  assert.equal(match.poolId, pool.id);
  assert.equal(match.round, 0);
  assert.ok(match.roomId, 'no room to join');
  assert.equal(match.game, starting.game, 'sent into a different game than was drawn');
  assert.ok(match.opponent?.username, 'no opponent to show');
  assert.ok(match.deadline > Date.now(), 'the match has already expired');

  // The game screen mounts and says so; the engine counts them in.
  const countdown = new Promise(r => {
    for (const ev of ['block_blast_countdown', 'tower_countdown', 'car_dash_countdown',
                      'color_rush_countdown', 'scrabble_countdown']) {
      client.once(ev, (p) => r({ ev, p }));
    }
  });
  runner.ready(pool.id, match.roomId, 'me');

  const counted = await Promise.race([
    countdown,
    new Promise((_, rej) => setTimeout(() => rej(new Error('the game never started')), 4000)),
  ]);
  assert.ok(counted.ev.endsWith('_countdown'), `unexpected ${counted.ev}`);
});

test('the bracket screen is told the game only when the round is drawn', async (t) => {
  // The complaint this fixes: the bracket named the game before anything had
  // been drawn, so the reveal had nothing left to reveal. The pool carries the
  // whole rotation — it has to, so every client agrees — but the screen is not
  // allowed to read ahead of the round it is on, and the round is only drawn
  // when it starts.
  const { server, io, pools, runner } = boot();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const client = await connect(port);
  t.after(() => { client.close(); io.close(); server.close(); });

  [...io.sockets.sockets.values()][0]._authenticatedUserId = 'me';
  const waitFor = record(client, ['tournament_round_starting']);

  const now = Date.now();
  const { pool } = pools.join({ userId: 'me', username: 'Me', entryFee: 1, now });
  pool.free = true;
  for (let i = 1; i < 16; i++) {
    pools.seat(pool, { userId: `bot:${i}`, username: `Bot ${i}`, isBot: true, now });
  }

  const clock = setInterval(() => runner.tick(), 20);
  t.after(() => clearInterval(clock));

  const starting = await waitFor('tournament_round_starting');
  // The draw names one game for THIS round. The rotation is on the pool for
  // the bracket to plan against, but the round the screen is on is the only
  // one it may name.
  assert.equal(typeof starting.game, 'string');
  assert.equal(starting.game, pool.roundGames[0]);
  assert.notEqual(starting.at, undefined, 'nothing says when the draw lands');
});

test('a game is not sent to the client before its round is reached', () => {
  // The rotation is decided when the pool is created — it has to be, so that
  // every client is told the same thing and nobody can be shown one game and
  // handed another. But sending all four meant the bracket could name round
  // three's game during round one, and the draw had nothing left to reveal.
  const { publicPool } = require('../src/routes/tournaments');
  const pools = createStore();
  const now = Date.now();
  const { pool } = pools.join({ userId: 'me', username: 'Me', entryFee: 1, now });

  assert.deepEqual(publicPool(pool).roundGames, [], 'a game was named while still filling');

  for (let i = 1; i < 16; i++) {
    pools.seat(pool, { userId: `bot:${i}`, username: `Bot ${i}`, isBot: true, now });
  }
  assert.equal(publicPool(pool).roundGames.length, 1, 'round one saw more than round one');
  assert.equal(publicPool(pool).roundGames[0], pool.roundGames[0]);

  // And each round adds exactly one as it is reached.
  for (const { m, i } of pools.pendingMatches(pool)) pools.reportResult(pool.id, 0, i, m.a);
  pools.advanceRound(pool);
  assert.equal(publicPool(pool).roundGames.length, 2);
  assert.deepEqual(publicPool(pool).roundGames, pool.roundGames.slice(0, 2));
});
