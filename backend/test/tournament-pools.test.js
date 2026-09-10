// Pools: who is in which tournament.
//
// Every function takes `now`, so the whole twenty-minute lifecycle — fill,
// close, play, settle — runs here in milliseconds instead of being something
// nobody can test without waiting for the clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, seededRng, nextPowerOfTwo } = require('../src/services/tournamentPools');
const F = require('../src/services/tournamentFormat');

const at = (h, m, s = 0) => Date.UTC(2026, 0, 1, h, m, s);
const OPEN = at(9, 1);          // inside the join window
const CLOSED = at(9, 6);        // after it

const fill = (store, n, { entryFee = 1, now = OPEN, from = 0 } = {}) => {
  const out = [];
  for (let i = from; i < from + n; i++) {
    out.push(store.join({ userId: `u${i}`, username: `p${i}`, entryFee, now }));
  }
  return out;
};

// ── Joining ────────────────────────────────────────────────────────────────

test('the first player to queue opens a pool', () => {
  const s = createStore();
  const { pool, already } = s.join({ userId: 'u1', username: 'a', entryFee: 1, now: OPEN });
  assert.equal(already, false);
  assert.equal(pool.state, 'filling');
  assert.equal(pool.players.length, 1);
  assert.equal(pool.entryFee, 1);
});

test('the next player joins the same pool, not a second one', () => {
  const s = createStore();
  fill(s, 2);
  assert.equal(s.pools.size, 1, 'two players made two pools');
  assert.equal([...s.pools.values()][0].players.length, 2);
});

test('a seventeenth player opens a second pool', () => {
  // As many pools as needed, sixteen to a bracket.
  const s = createStore();
  fill(s, 17);
  assert.equal(s.pools.size, 2);
  const sizes = [...s.pools.values()].map(p => p.players.length).sort((a, b) => b - a);
  assert.deepEqual(sizes, [16, 1]);
});

test('only one pool at a stake is ever taking entries', () => {
  // A pool starts the instant it reaches sixteen, so it stops being a
  // candidate the moment it is full. That is what keeps everyone funnelling
  // into one bracket rather than spreading across a dozen half-empty ones —
  // and it is why there is no "pick the fullest" rule to get wrong.
  const s = createStore();
  fill(s, 16);                                  // fills and starts
  fill(s, 3, { from: 100 });                    // the next pool opens
  const filling = [...s.pools.values()].filter(p => p.state === 'filling');
  assert.equal(filling.length, 1, 'two pools were taking entries at once');
  assert.equal(filling[0].players.length, 3);

  s.join({ userId: 'u200', username: 'x', entryFee: 1, now: OPEN });
  assert.equal(filling[0].players.length, 4, 'a new pool was opened beside a half-full one');
});

test('the rotation a pool actually gets comes from its own id', () => {
  // Not Math.random. Every client has to be told the same game for the same
  // round; drawn per process, a reconnecting player is handed a different
  // tournament from the one still being played.
  const s = createStore();
  const pool = fill(s, 2)[0].pool;
  assert.deepEqual(pool.roundGames, F.pickRoundGames(F.ROUNDS, seededRng(pool.id)),
    "a pool's rotation is not reproducible from its id");
});

test('the three stakes never share a pool', () => {
  const s = createStore();
  s.join({ userId: 'a', username: 'a', entryFee: 1,  now: OPEN });
  s.join({ userId: 'b', username: 'b', entryFee: 5,  now: OPEN });
  s.join({ userId: 'c', username: 'c', entryFee: 10, now: OPEN });
  assert.equal(s.pools.size, 3);
  assert.deepEqual([...s.pools.values()].map(p => p.entryFee).sort((x, y) => x - y), [1, 5, 10]);
});

test('an unknown stake is refused', () => {
  const s = createStore();
  assert.throws(() => s.join({ userId: 'a', username: 'a', entryFee: 3, now: OPEN }),
    /entry fee must be one of/);
});

test('a player cannot enter the same slot twice', () => {
  // Two seats in one slot means being asked to play two games in the same
  // three minutes — and one of those seats belonged to a real entrant.
  const s = createStore();
  const first = s.join({ userId: 'u1', username: 'a', entryFee: 1, now: OPEN });
  const again = s.join({ userId: 'u1', username: 'a', entryFee: 1, now: OPEN });
  assert.equal(again.already, true);
  assert.equal(again.pool.id, first.pool.id, 'a second click made a second entry');
  assert.equal(again.pool.players.length, 1);
});

test('nor at a different stake in the same slot', () => {
  const s = createStore();
  s.join({ userId: 'u1', username: 'a', entryFee: 1, now: OPEN });
  const other = s.join({ userId: 'u1', username: 'a', entryFee: 10, now: OPEN });
  assert.equal(other.already, true, 'entering twice was allowed by changing stake');
  assert.equal(other.pool.entryFee, 1, 'and it moved them to the other bracket');
});

test('queueing after the window puts you in the next slot', () => {
  const s = createStore();
  const { pool } = s.join({ userId: 'u1', username: 'a', entryFee: 1, now: CLOSED });
  assert.equal(new Date(pool.slotStart).getUTCMinutes(), 20,
    'a late player joined a tournament that had already started');
});

// ── Starting ───────────────────────────────────────────────────────────────

test('a pool starts the moment it is full, without waiting for the clock', () => {
  const s = createStore();
  const joins = fill(s, 16);
  const pool = joins[0].pool;
  assert.equal(pool.state, 'running');
  assert.equal(pool.bracket.length, F.ROUNDS);
  assert.equal(pool.bracket[0].length, 8);
});

test('everyone is seated, and the pairs are adjacent', () => {
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  const seated = pool.bracket[0].flatMap(m => [m.a, m.b]);
  assert.equal(new Set(seated).size, 16, 'someone was seated twice or not at all');
  assert.equal(pool.bracket[0][0].a, 'u0');
  assert.equal(pool.bracket[0][0].b, 'u1');
});

test('a pool that never fills is refunded, not started short', () => {
  // A tournament starts when the bracket is full. That is the only thing that
  // starts one — the window is when a seat can be taken and when it can no
  // longer be.
  //
  // This used to start whatever had turned up, padded out with byes. It made
  // the clock look like a start time, and it paid three places out of five
  // entries.
  const s = createStore();
  fill(s, 5);
  const { refunded } = s.closeWindow(CLOSED);
  assert.equal(refunded.length, 1);
  assert.equal(refunded[0].state, 'refunded');
  assert.equal(refunded[0].bracket, null, 'a bracket was drawn for a tournament that never ran');
});

test('a bracket that fills starts there and then, whenever that is', () => {
  // Not at the close, and not at the top of the slot. The sixteenth seat is
  // what starts it.
  const s = createStore();
  fill(s, 15);
  const pool = [...s.pools.values()][0];
  assert.equal(pool.state, 'filling', 'fifteen was enough to start it');

  fill(s, 1, { from: 15 });
  assert.equal(pool.state, 'running', 'the sixteenth seat did not start it');
  assert.ok(pool.bracket, 'no bracket was drawn');
  assert.equal(pool.startedAt, OPEN, 'it started at the window rather than when it filled');

  // And the close has nothing left to do with it.
  const { refunded } = s.closeWindow(CLOSED);
  assert.equal(refunded.length, 0, 'a running tournament was refunded');
  assert.equal(pool.state, 'running');
});

test('the window does not close early', () => {
  const s = createStore();
  fill(s, 5);
  const { refunded } = s.closeWindow(at(9, 4, 59));
  assert.equal(refunded.length, 0, 'entry closed before the five minutes were up');
  assert.equal([...s.pools.values()][0].state, 'filling');
});

test('closing twice refunds a pool once', () => {
  const s = createStore();
  fill(s, 5);
  s.closeWindow(CLOSED);
  const second = s.closeWindow(CLOSED + 1000);
  assert.equal(second.refunded.length, 0, 'the same entry would be paid back twice');
});

// ── The rotation ───────────────────────────────────────────────────────────

test('a pool draws four different games, fixed when it opens', () => {
  const s = createStore();
  const pool = fill(s, 2)[0].pool;
  assert.equal(pool.roundGames.length, F.ROUNDS);
  assert.equal(new Set(pool.roundGames).size, F.ROUNDS);
});

test('the rotation is the same every time it is derived', () => {
  // Every client is told the same game for the same round. Drawn from
  // Math.random on each server, that is two different tournaments.
  const a = F.pickRoundGames(4, seededRng('pool-abc'));
  const b = F.pickRoundGames(4, seededRng('pool-abc'));
  assert.deepEqual(a, b);
  const c = F.pickRoundGames(4, seededRng('pool-xyz'));
  assert.notDeepEqual(a, c, 'every pool got the same rotation');
});

// ── Playing it out ─────────────────────────────────────────────────────────

function playToTheEnd(store, pool, winnerOf = (a) => a) {
  for (let guard = 0; guard < 10 && pool.state === 'running'; guard++) {
    for (const { m, i } of store.pendingMatches(pool)) {
      store.reportResult(pool.id, pool.round, i, winnerOf(m.a, m.b));
    }
    if (!store.advanceRound(pool)) break;
  }
  return pool;
}

test('a winner advances, and the bracket resolves to one champion', () => {
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  playToTheEnd(s, pool);
  assert.equal(pool.state, 'complete');
  const places = F.placings(pool.bracket);
  assert.equal(places.first, 'u0', 'the always-winning first seat did not win');
  assert.ok(places.second && places.third);
  assert.notEqual(places.second, places.third);
});

test('a result for a decided match is ignored, not applied twice', () => {
  // Two clients reporting the same finish is the normal case.
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  const first = s.reportResult(pool.id, 0, 0, 'u0');
  assert.equal(first.already, false);
  const dup = s.reportResult(pool.id, 0, 0, 'u1');
  assert.equal(dup.already, true);
  assert.equal(pool.bracket[0][0].winner, 'u0', 'a duplicate report changed the winner');
  assert.equal(pool.bracket[1][0].a, 'u0');
});

test('a result naming someone not in the match is refused', () => {
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  assert.equal(s.reportResult(pool.id, 0, 0, 'u9'), null,
    'a player from another match was declared the winner');
  assert.equal(pool.bracket[0][0].winner, null);
});

test('the round does not advance until every match in it is done', () => {
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  s.reportResult(pool.id, 0, 0, 'u0');
  assert.equal(s.advanceRound(pool), false, 'the round moved on with matches unplayed');
  assert.equal(pool.round, 0);
  for (const { i, m } of s.pendingMatches(pool)) s.reportResult(pool.id, 0, i, m.a);
  assert.equal(s.advanceRound(pool), true);
  assert.equal(pool.round, 1);
});

test('a bye does not need reporting to let the round finish', () => {
  // Byes cannot arise from ordinary play any more — sixteen is a power of two,
  // and sixteen is the only size that starts. startPool still has to handle a
  // short bracket correctly, because it is the one thing standing between a
  // partial pool and a round that can never complete.
  const s = createStore();
  fill(s, 5);
  const pool = [...s.pools.values()][0];
  s.startPool(pool, OPEN);
  // One real match, three byes already decided.
  const pending = s.pendingMatches(pool);
  assert.equal(pending.length, 1);
  s.reportResult(pool.id, 0, pending[0].i, pending[0].m.a);
  assert.equal(s.advanceRound(pool), true, 'byes blocked the round from advancing');
});

// ── Shutdown ───────────────────────────────────────────────────────────────

test('a restart hands back every pool that owes money', () => {
  // A tournament does not survive a deploy. Losing it is acceptable; keeping
  // the entry fees is not.
  const s = createStore();
  fill(s, 16);                       // running
  fill(s, 2, { from: 500 });         // still filling
  const owing = s.drainForShutdown();
  assert.equal(owing.length, 2, 'a pool holding entry fees was not handed back');
  assert.ok(owing.every(p => p.state === 'abandoned'));
});

test('a finished tournament owes nothing on restart', () => {
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  playToTheEnd(s, pool);
  assert.equal(s.drainForShutdown().length, 0,
    'a settled tournament was refunded a second time');
});

// ── Shape ──────────────────────────────────────────────────────────────────

test('any number of entrants makes a real bracket', () => {
  for (const n of [4, 5, 7, 8, 9, 11, 16]) {
    const s = createStore();
    fill(s, n);
    const pool = [...s.pools.values()][0];
    s.startPool(pool, OPEN);
    const size = nextPowerOfTwo(n);
    assert.equal(pool.bracket[0].length, size / 2, `${n} players made a broken first round`);
    const seated = pool.bracket[0].flatMap(m => [m.a, m.b]).filter(Boolean);
    assert.equal(seated.length, n, `${n} players, ${seated.length} seated`);
    playToTheEnd(s, pool);
    assert.equal(pool.state, 'complete', `${n} players never reached a champion`);
  }
});

// ── Leaving ────────────────────────────────────────────────────────────────

test('leaving before it starts frees the seat and owes a refund', () => {
  const s = createStore();
  fill(s, 3);
  const pool = [...s.pools.values()][0];
  const r = s.leave(pool.id, 'u1');
  assert.equal(r.ok, true);
  assert.equal(r.refund, true, 'the entry fee is owed back');
  assert.equal(r.entryFee, 1);
  assert.equal(pool.players.length, 2, 'the seat was not freed');
  assert.ok(!pool.players.some(p => p.userId === 'u1'));
});

test('the freed seat is the next one somebody takes', () => {
  // A full pool that loses someone before it begins goes back to taking
  // entries rather than starting a player short.
  const s = createStore();
  fill(s, 16);
  const pool = [...s.pools.values()][0];
  assert.equal(pool.state, 'running');

  // One leaves a pool that has not started.
  const s2 = createStore();
  fill(s2, 15);
  const p2 = [...s2.pools.values()][0];
  s2.leave(p2.id, 'u0');
  assert.equal(p2.state, 'filling');
  assert.equal(p2.players.length, 14);
  s2.join({ userId: 'newcomer', username: 'n', entryFee: 1, now: OPEN });
  assert.equal(p2.players.length, 15, 'the newcomer opened a second pool instead');
});

test('the last player leaving takes the pool with them', () => {
  // Otherwise it sits empty until the window closes and is "refunded" a
  // second time, to nobody.
  const s = createStore();
  const { pool } = s.join({ userId: 'solo', username: 'a', entryFee: 1, now: OPEN });
  s.leave(pool.id, 'solo');
  assert.equal(s.pools.size, 0);
});

test('leaving a running tournament is a forfeit, not a refund', () => {
  // Refunding here would make quitting a losing bracket free, and the opponent
  // has already spent their round waiting for a game that will not happen.
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  const opponent = pool.bracket[0][0].b;
  const r = s.leave(pool.id, pool.bracket[0][0].a);
  assert.equal(r.ok, true);
  assert.equal(r.refund, false, 'a forfeit was refunded');
  assert.equal(pool.bracket[0][0].winner, opponent, 'the opponent did not go through');
  assert.equal(pool.bracket[1][0].a, opponent, 'and was not advanced');
});

test('a forfeit is recorded as one, not as a played result', () => {
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  const quitter = pool.bracket[0][0].a;
  s.leave(pool.id, quitter);
  assert.deepEqual(pool.bracket[0][0].scores, { forfeit: quitter });
});

test('leaving a tournament you are not in changes nothing', () => {
  const s = createStore();
  const pool = fill(s, 3)[0].pool;
  assert.equal(s.leave(pool.id, 'someone-else').ok, false);
  assert.equal(pool.players.length, 3);
});

test('leaving a pool that does not exist is not a crash', () => {
  const s = createStore();
  assert.equal(s.leave('nope', 'u1').ok, false);
});

test('a free bracket owes nothing when someone leaves it', () => {
  // Nothing was taken, so nothing goes back.
  const s = createStore();
  const { pool } = s.join({ userId: 'u1', username: 'a', entryFee: 1, now: OPEN });
  pool.free = true;
  assert.equal(s.leave(pool.id, 'u1').refund, false);
});

test('a tournament that is over cannot be left', () => {
  // Not filling and not running: there is no seat to give back and no match to
  // forfeit. Answering "ok" would tell the client it had done something.
  const s = createStore();
  const pool = fill(s, 16)[0].pool;
  playToTheEnd(s, pool);
  assert.equal(pool.state, 'complete');
  assert.equal(s.leave(pool.id, 'u0').ok, false, 'a finished tournament was left');

  // Same for one that never ran.
  const s2 = createStore();
  fill(s2, 2);
  const p2 = [...s2.pools.values()][0];
  s2.closeWindow(CLOSED);
  assert.equal(p2.state, 'refunded');
  assert.equal(s2.leave(p2.id, 'u0').ok, false, 'an already-refunded pool was left again');
});

// ── Tickets ────────────────────────────────────────────────────────────────

test('two goes per tournament, spent when the bracket starts', () => {
  // Spent on STARTING, not on joining. A pool that never fills is refunded and
  // nothing was played; charging a go for it would take away a turn at a
  // tournament that did not happen.
  const s = createStore();
  const { pool } = s.join({ userId: 'u0', username: 'a', entryFee: 1, now: OPEN });
  assert.equal(s.ticketsLeft(pool.slotStart, 'u0'), 2, 'a fresh slot does not start with two');

  for (let i = 1; i < 15; i++) s.seat(pool, { userId: `u${i}`, username: 'x', now: OPEN });
  assert.equal(pool.state, 'filling');
  assert.equal(s.ticketsLeft(pool.slotStart, 'u0'), 2, 'joining alone spent a ticket');

  s.seat(pool, { userId: 'u15', username: 'x', now: OPEN });
  assert.equal(pool.state, 'running');
  assert.equal(s.ticketsLeft(pool.slotStart, 'u0'), 1, 'starting did not spend one');
  assert.equal(s.ticketsLeft(pool.slotStart, 'u15'), 1);
});

test('a bracket that is refunded costs nobody a go', () => {
  const s = createStore();
  const { pool } = s.join({ userId: 'u0', username: 'a', entryFee: 1, now: OPEN });
  s.closeWindow(CLOSED);
  assert.equal(pool.state, 'refunded');
  assert.equal(s.ticketsLeft(pool.slotStart, 'u0'), 2, 'a tournament that never ran cost a ticket');
});

test('the bots in a bracket are not charged a go', () => {
  // They have no account to charge, and counting them would fill the map with
  // an entry per bot per tournament forever.
  const s = createStore();
  const { pool } = s.join({ userId: 'u0', username: 'a', entryFee: 1, now: OPEN });
  for (let i = 1; i < 16; i++) s.seat(pool, { userId: `bot:${i}`, username: 'b', isBot: true, now: OPEN });
  assert.equal(pool.state, 'running');
  assert.equal(s.spentIn(pool.slotStart, 'bot:1'), 0);
});

test('tickets come back with the next tournament', () => {
  // Keyed by slot, so they reset every twenty minutes rather than by the day.
  const s = createStore();
  const { pool } = s.join({ userId: 'u0', username: 'a', entryFee: 1, now: OPEN });
  for (let i = 1; i < 16; i++) s.seat(pool, { userId: `b${i}`, username: 'b', isBot: true, now: OPEN });
  assert.equal(s.ticketsLeft(pool.slotStart, 'u0'), 1);

  const nextSlot = F.slotAt(at(9, 25)).startsAt;
  assert.notEqual(nextSlot, pool.slotStart, 'the test is looking at the same slot');
  assert.equal(s.ticketsLeft(nextSlot, 'u0'), 2, 'the next tournament did not reset them');
});

test('a bot bracket seats a face, not an empty chair', () => {
  // The colour is what the avatar falls back to when nobody has uploaded a
  // picture. Without it every bot drew as the same dark circle, which is what
  // made a filling bracket look like a list of empty seats.
  const s = createStore();
  const { pool } = s.join({ userId: 'u0', username: 'a', entryFee: 1, now: OPEN, profileColor: '#123456' });
  s.seat(pool, { userId: 'b1', username: 'Bot', isBot: true, profileColor: '#abcdef', now: OPEN });
  assert.equal(pool.players[0].profileColor, '#123456');
  assert.equal(pool.players[1].profileColor, '#abcdef');
});
