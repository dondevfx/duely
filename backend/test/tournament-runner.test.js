const test = require('node:test');
const assert = require('node:assert');

const { createStore } = require('../src/services/tournamentPools');
const { createRunner } = require('../src/services/tournamentRunner');
const hook = require('../src/services/tournamentHook');
const F = require('../src/services/tournamentFormat');

/**
 * These drive a whole tournament — sixteen entrants, four rounds, prizes paid —
 * against a fake engine and a fake socket server, because the thing worth
 * testing is the orchestration and not Block Burst.
 *
 * The fake engine is deliberately dumb: it records the room it was asked to
 * make and does nothing else. Every result in these tests is delivered the way
 * a real engine delivers one, through tournamentHook, so what is being
 * exercised is exactly the path production uses.
 */

function fakeIo() {
  const sockets = new Map();
  const sent = [];
  const io = {
    sockets: { sockets },
    emit: (event, payload) => sent.push({ to: '*', event, payload }),
    to: () => ({ emit: (event, payload) => sent.push({ to: 'room', event, payload }) }),
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
    _disconnect(userId) {
      for (const [id, s] of sockets) if (s._authenticatedUserId === userId) sockets.delete(id);
    },
    _for: (userId, event) => sent.filter(x => x.to === userId && x.event === event),
  };
  return io;
}

function fakeEngines() {
  const rooms = new Map();
  const made = [];
  const one = {
    event: 'fake_match_found',
    create: (p1, p2) => {
      const roomId = `room_${made.length}`;
      rooms.set(roomId, { roomId, players: [p1, p2], isSolo: !!(p1.isBot || p2.isBot), scores: {}, pingScores: {} });
      made.push({ roomId, p1, p2 });
      return roomId;
    },
    room: (id) => rooms.get(id),
    // Every real adapter reads its own running score; the fake has to as
    // well, or the deadline path is tested against a game with no scores.
    score: (room, sid) => room.scores?.[sid] ?? room.pingScores?.[sid] ?? 0,
    del: (id) => rooms.delete(id),
    begin: () => { one.begun++; },
    begun: 0,
  };
  const table = {};
  for (const g of F.TOURNAMENT_GAMES) table[g] = one;
  table._made = made;
  table._rooms = rooms;
  table._one = one;
  return table;
}

function fakeSupabase(captured = []) {
  const api = {
    from(tableName) {
      return {
        insert(rows) {
          captured.push({ table: tableName, rows: Array.isArray(rows) ? rows : [rows] });
          const built = {
            select: () => Promise.resolve({
              data: (Array.isArray(rows) ? rows : [rows]).map((r, i) => ({ id: `row${i}`, player1_id: r.player1_id })),
              error: null,
            }),
            then: (fn) => fn({ data: null, error: null }),
          };
          return built;
        },
        update(patch) {
          return { eq: (col, val) => { captured.push({ table: tableName, update: patch, [col]: val }); return Promise.resolve({ error: null }); } };
        },
      };
    },
    rpc(name, args) { captured.push({ rpc: name, args }); return Promise.resolve({ error: null }); },
    _captured: captured,
  };
  return api;
}

function fill(pools, n, { entryFee = 5, bots = 0 } = {}) {
  const now = Date.now();
  const { pool } = pools.join({ userId: 'u0', username: 'u0', entryFee, now });
  for (let i = 1; i < n; i++) {
    // Bots are INTERLEAVED. Putting them all at the end pairs bot against
    // bot in the first round and human against human, so a test about what
    // happens when the two meet would never see them meet.
    pools.seat(pool, { userId: `u${i}`, username: `u${i}`, isBot: bots > 0 && i % 2 === 1 && i < bots * 2, now });
  }
  return pool;
}

/** Play the whole thing out: whoever is `a` in a match wins it. */
function playOut(runner, pool, { winner = (m) => m.a } = {}) {
  for (let guard = 0; guard < 200 && pool.state === 'running'; guard++) {
    runner.startRound(pool);
    const pending = [...(pool.bracket[pool.round] || []).entries()].filter(([, m]) => !m.winner && m.a && m.b);
    if (!pending.length) break;
    for (const [i, m] of pending) {
      runner.onResult({ poolId: pool.id, round: pool.round, match: i, winnerId: winner(m), isDraw: false });
    }
  }
}

test.beforeEach(() => hook._reset());

test('a full bracket plays out and pays the top three', async () => {
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const captured = [];
  const supabase = fakeSupabase(captured);
  const runner = createRunner({ io, supabase, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 5 });
  assert.equal(pool.state, 'running', 'sixteen entrants starts it');

  await runner.beginPool(pool);

  // One wager row per entrant, and only one. It is what makes the entry count
  // towards playthrough; the rounds themselves are staked at zero.
  const wagers = captured.filter(c => c.table === 'matches');
  assert.equal(wagers.length, 1);
  assert.equal(wagers[0].rows.length, 16);
  assert.ok(wagers[0].rows.every(r => r.entry_fee_c === 5 && r.game_type === 'tournament'));

  playOut(runner, pool);
  assert.equal(pool.state, 'complete');

  await runner.settle(pool);

  const { prizes } = F.prizesFor(5, 16);
  const credits = captured.filter(c => c.rpc === 'credit_coins');
  assert.equal(credits.length, 3, 'exactly three places are paid');
  assert.deepEqual(credits.map(c => c.args.amount), prizes);

  // And the losers each get a row, so the P&L is not one-sided.
  const losses = captured.filter(c => c.table === 'transactions')
    .flatMap(c => c.rows).filter(r => r.type === 'match_loss');
  assert.equal(losses.length, 13);
});

test('the prize pool is what was actually entered, not a full sixteen', async () => {
  // A pool that closes short still pays out — from four entries, not sixteen.
  // Paying the sixteen-player table out of a four-player pot would hand out
  // four times what was taken, every time a tournament failed to fill.
  const pools = createStore();
  const io = fakeIo();
  const captured = [];
  const runner = createRunner({ io, supabase: fakeSupabase(captured), pools, engines: fakeEngines(), log: { error() {} } });

  const pool = fill(pools, 4, { entryFee: 10 });
  pools.startPool(pool, Date.now());
  await runner.beginPool(pool);
  playOut(runner, pool);
  await runner.settle(pool);

  const paid = captured.filter(c => c.rpc === 'credit_coins').reduce((s, c) => s + c.args.amount, 0);
  const taken = 4 * 10;
  assert.ok(paid < taken, 'paid out more than was taken');
  assert.ok(Math.abs(paid - taken * (1 - F.FEE_RATE)) < 0.001, `paid ${paid} of ${taken}`);
});

test('a free bracket pays nobody', async () => {
  const pools = createStore();
  const captured = [];
  const runner = createRunner({ io: fakeIo(), supabase: fakeSupabase(captured), pools, engines: fakeEngines(), log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 5 });
  pool.free = true;
  await runner.beginPool(pool);
  playOut(runner, pool);
  await runner.settle(pool);

  assert.equal(captured.filter(c => c.rpc === 'credit_coins').length, 0);
  assert.equal(captured.filter(c => c.table === 'matches').length, 0, 'a free entry is not a wager');
});

test('a draw goes to sudden death rather than stopping the round', () => {
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({ io, supabase: null, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 1 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);

  const before = engines._made.length;
  runner.onResult({ poolId: pool.id, round: 0, match: 0, winnerId: null, isDraw: true });

  assert.ok(!pool.bracket[0][0].winner, 'a draw decided the match');
  assert.equal(engines._made.length, before + 1, 'no replay was created');
  assert.equal(io._for(pool.players[0].userId, 'tournament_sudden_death').length, 1);
});

test('a drawn sudden death is settled rather than replayed forever', () => {
  const pools = createStore();
  const io = fakeIo();
  const runner = createRunner({ io, supabase: null, pools, engines: fakeEngines(), log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 1 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);

  runner.onResult({ poolId: pool.id, round: 0, match: 0, winnerId: null, isDraw: true });
  runner.onResult({ poolId: pool.id, round: 0, match: 0, winnerId: null, isDraw: true, sudden: true });

  const m = pool.bracket[0][0];
  assert.ok(m.winner === m.a || m.winner === m.b, 'sudden death did not end it');
});

test('a result for a round already finished is ignored', () => {
  // Two clients reporting, a forced deadline landing late, an engine settling
  // twice: all of it arrives after the bracket has moved on, and none of it
  // may write into the round it is now on.
  const pools = createStore();
  const runner = createRunner({ io: fakeIo(), supabase: null, pools, engines: fakeEngines(), log: { error() {} } });
  const pool = fill(pools, 16, { entryFee: 1 });

  runner.startRound(pool);
  for (let i = 0; i < 8; i++) {
    runner.onResult({ poolId: pool.id, round: 0, match: i, winnerId: pool.bracket[0][i].a, isDraw: false });
  }
  assert.equal(pool.round, 1);

  const snapshot = JSON.stringify(pool.bracket[1]);
  runner.onResult({ poolId: pool.id, round: 0, match: 3, winnerId: pool.bracket[0][3].b, isDraw: false });
  assert.equal(JSON.stringify(pool.bracket[1]), snapshot, 'a stale result changed the next round');
});

test('a timeout from a finished round cannot decide the round after it', async () => {
  // The dangerous case, and the reason both startMatch and onResult carry a
  // round rather than reading the current one. A deadline set in round one
  // fires three minutes later, by which time the tournament is in round two —
  // and the match at that index in round two has not been played.
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({ io, supabase: null, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 1 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);
  for (let i = 0; i < 8; i++) {
    runner.onResult({ poolId: pool.id, round: 0, match: i, winnerId: pool.bracket[0][i].a, isDraw: false });
  }
  assert.equal(pool.round, 1, 'the bracket did not move on');

  // The straggler lands now, naming the round it belonged to.
  runner.onResult({ poolId: pool.id, round: 0, match: 2, winnerId: pool.bracket[0][2].b, isDraw: false, forced: true });

  assert.ok(!pool.bracket[1][2].winner, 'a stale timeout decided an unplayed match');
});

test('a deadline decides the match it was set for, not whichever round is current', async () => {
  // The dangerous case. A deadline set in round one fires three minutes later,
  // by which time the tournament is in round two — and reading the round at
  // that moment would decide a round-two match nobody had played. The round is
  // fixed when the match starts, which is why startMatch captures it.
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({
    io, supabase: null, pools, engines, log: { error() {} },
    // Short enough to actually reach, which is the whole point.
    timings: { match: 40, overrun: 10, ready: 5, intermission: 5, pick: 5 },
  });

  const pool = fill(pools, 16, { entryFee: 1 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);

  // Every match but one is reported at once, so the round is one result away
  // from advancing when the straggler's deadline lands.
  for (let i = 1; i < 8; i++) {
    runner.onResult({ poolId: pool.id, round: 0, match: i, winnerId: pool.bracket[0][i].a, isDraw: false });
  }
  assert.equal(pool.round, 0, 'the round advanced with a match still open');

  // The open match has a score on it but no result, which is exactly what a
  // player who freezes or closes the tab leaves behind. The deadline decides
  // it on what the room knows.
  const open = engines._made[0];
  const room = engines._rooms.get(open.roomId);
  room.pingScores[open.p1.socketId] = 700;
  room.pingScores[open.p2.socketId] = 200;

  await new Promise(r => setTimeout(r, 150));

  assert.equal(pool.bracket[0][0].winner, open.p1.userId, 'the deadline did not decide it on the score');
  assert.equal(pool.round, 1, 'the round did not move on once it was complete');
  // And nothing in round two was decided by it.
  assert.equal(pool.bracket[1].filter(m => m.winner).length, 0, 'a deadline decided an unplayed match');
});

test('the engines are told to start only once both screens have reported in', () => {
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({ io, supabase: null, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 1 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);

  const first = engines._made[0];
  assert.equal(engines._one.begun, 0, 'the game started before anyone had loaded it');

  runner.ready(pool.id, first.roomId, first.p1.userId);
  assert.equal(engines._one.begun, 0, 'started with only one player present');
  runner.ready(pool.id, first.roomId, first.p2.userId);
  assert.equal(engines._one.begun, 1);
});

test('a bracket room is staked at zero and never settles a second wager', () => {
  // The entry fee is taken once, on the way in. If the rooms carried it too,
  // four rounds would cost a player five entries and pay four extra pots.
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({ io, supabase: null, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 10 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);

  assert.ok(engines._made.length > 0);
  for (const { p1, p2 } of engines._made) {
    assert.equal(p1.entryFee, 0);
    assert.equal(p2.entryFee, 0);
  }
});

test('a tournament bot never knocks a real player out', () => {
  // Bots exist to fill a bracket nobody else entered. They pay nothing in, so
  // they must never take a place — which is what demoWin does, and why it is
  // set on every bracket room that has a bot in it.
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({ io, supabase: null, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 1, bots: 8 });
  for (const p of pool.players) if (!p.isBot) io._connect(p.userId);
  runner.startRound(pool);

  const mixed = engines._made.filter(({ p1, p2 }) => p1.isBot !== p2.isBot);
  assert.ok(mixed.length > 0, 'no human faced a bot, so this proves nothing');
  for (const { roomId } of mixed) {
    const room = engines._rooms.get(roomId);
    assert.equal(room.demoWin, true, 'a bot could beat a paying entrant');
    assert.equal(room.soloRun, false, 'a bracket match was played as a practice run');
  }
});

test('an engine result reaches the bracket through the hook', () => {
  // The engines call tournamentHook.settled and know nothing else about
  // tournaments. This is that path, end to end.
  const pools = createStore();
  const io = fakeIo();
  const engines = fakeEngines();
  const runner = createRunner({ io, supabase: null, pools, engines, log: { error() {} } });

  const pool = fill(pools, 16, { entryFee: 1 });
  for (const p of pool.players) io._connect(p.userId);
  runner.startRound(pool);

  const { roomId, p1 } = engines._made[0];
  assert.ok(hook.isTournamentRoom(roomId));
  hook.settled(roomId, { winnerId: p1.userId, loserId: 'someone', isDraw: false });

  assert.equal(pool.bracket[0][0].winner, p1.userId);
  assert.equal(hook.isTournamentRoom(roomId), false, 'the room was left registered');
});

test('an ordinary match is not a tournament match', () => {
  // settled() is called by every engine on every result, most of which have
  // nothing to do with a bracket. Those must fall straight through.
  const pools = createStore();
  createRunner({ io: fakeIo(), supabase: null, pools, engines: fakeEngines(), log: { error() {} } });
  assert.equal(hook.settled('bb_some_ordinary_room', { winnerId: 'u1' }), false);
});

test('a tournament that is dropped by a restart gives every entry back', async () => {
  // Its bracket and its rooms are in this process, so a restart loses them
  // however carefully it is handled. Losing the tournament is acceptable;
  // keeping the money is not. Bots are not owed anything and a free bracket
  // took nothing, so neither is refunded.
  const { refundPool } = require('../src/routes/tournaments');
  const pools = createStore();
  const captured = [];
  const supabase = fakeSupabase(captured);

  const pool = fill(pools, 16, { entryFee: 5, bots: 4 });
  const owing = pools.drainForShutdown();
  assert.equal(owing.length, 1, 'the live pool was not drained');
  assert.equal(owing[0].state, 'abandoned');

  await refundPool(supabase, owing[0]);

  const refunds = captured.filter(c => c.rpc === 'credit_coins');
  const humans = pool.players.filter(p => !p.isBot).length;
  assert.equal(refunds.length, humans, 'not everyone who paid was refunded');
  assert.ok(refunds.every(r => r.args.amount === 5));

  // And a free bracket has nothing to give back.
  captured.length = 0;
  await refundPool(supabase, { ...pool, free: true });
  assert.equal(captured.length, 0);
});
