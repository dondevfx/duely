// Quick Match picked a game uniformly at random, so it would drop a player into
// an empty queue while someone sat waiting one game over at the same bet. It now
// picks from the games that actually have someone queued.
//
// The thing that must not regress: when nobody is waiting it has to behave
// exactly as before, because that is the common case on a quiet site.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'quickMatchPool.js'), 'utf8');

// ESM in the frontend; evaluate it here without a bundler.
const { gamesWithSomeoneWaiting, chooseGame } = new Function(
  `${src.replace(/export /g, '')}; return { gamesWithSomeoneWaiting, chooseGame };`)();

const POOL = [
  { route: '/game/block-blast', queueKey: 'block-blast' },
  { route: '/game/coin-flip',   queueKey: 'coin-flip', coinsOnly: true },
  { route: '/game/blackjack',   queueKey: 'blackjack' },
  { route: '/game/word-vs',     queueKey: 'scrabble' },
];
const first = () => 0;   // deterministic rng: always take the first candidate

test('it lands on the game where someone is waiting', () => {
  const counts = { 'blackjack:50:coins': 1 };
  assert.equal(chooseGame(POOL, counts, 50, 'coins', first).queueKey, 'blackjack');
});

test('a different bet size does not count as waiting', () => {
  // Someone queued at 100 is no help to a player betting 50.
  const counts = { 'blackjack:100:coins': 3 };
  assert.deepEqual(gamesWithSomeoneWaiting(POOL, counts, 50, 'coins'), []);
});

test('a different currency does not count as waiting', () => {
  const counts = { 'blackjack:50:diamonds': 2 };
  assert.deepEqual(gamesWithSomeoneWaiting(POOL, counts, 50, 'coins'), []);
});

test('with nobody waiting it still returns a game', () => {
  // The fallback is the old behaviour, and it must never return nothing —
  // that would leave the player staring at a spinner.
  const g = chooseGame(POOL, {}, 50, 'coins', first);
  assert.ok(g && POOL.includes(g));
});

test('the fallback really is uniform over the whole pool', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(chooseGame(POOL, {}, 50, 'coins').queueKey);
  assert.equal(seen.size, POOL.length,
    'every game must still be reachable when no one is queued');
});

test('it only ever picks from games that have someone waiting', () => {
  const counts = { 'scrabble:50:coins': 1, 'coin-flip:50:coins': 2 };
  for (let i = 0; i < 400; i++) {
    const g = chooseGame(POOL, counts, 50, 'coins');
    assert.ok(['scrabble', 'coin-flip'].includes(g.queueKey),
      `picked ${g.queueKey}, which has an empty queue`);
  }
});

test('a pool filtered for diamonds is respected', () => {
  // Coin Flip is coins-only, so a diamond match must never land there even if
  // that is where the waiting player is.
  const pool = POOL.filter((g) => !g.coinsOnly);
  const counts = { 'coin-flip:50:diamonds': 5 };
  for (let i = 0; i < 100; i++) {
    assert.notEqual(chooseGame(pool, counts, 50, 'diamonds').queueKey, 'coin-flip');
  }
});

test('a zero count is not treated as waiting', () => {
  // The server leaves a 0 behind when the last player leaves a queue.
  const counts = { 'blackjack:50:coins': 0 };
  assert.deepEqual(gamesWithSomeoneWaiting(POOL, counts, 50, 'coins'), []);
});

test('missing counts do not throw', () => {
  assert.deepEqual(gamesWithSomeoneWaiting(POOL, null, 50, 'coins'), []);
  assert.ok(chooseGame(POOL, undefined, 50, 'coins', first));
});

test('an empty pool returns null rather than undefined', () => {
  assert.equal(chooseGame([], {}, 50, 'coins', first), null);
});

test('the queue keys match what the server actually broadcasts', () => {
  // POOL routes are frontend paths; the counts map is keyed by the server's
  // game ids. If these drift, every lookup silently misses and Quick Match goes
  // back to being random with no error anywhere.
  const handlers = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'socket', 'handlers.js'), 'utf8');
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'QuickMatch.jsx'), 'utf8');
  const keys = [...page.matchAll(/queueKey:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(keys.length, 4, 'every pool entry needs a queueKey');
  for (const k of keys) {
    assert.ok(new RegExp(`incrementCount\\('${k}'`).test(handlers),
      `no server queue is counted under '${k}'`);
  }
});
