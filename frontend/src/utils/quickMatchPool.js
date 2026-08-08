// Choosing which game Quick Match drops you into.
//
// It used to pick uniformly at random, so it would happily put you in an empty
// queue while someone sat waiting one game over at the same bet. These helpers
// pick from the games that actually have someone queued, and fall back to a
// plain random pick when nobody is waiting anywhere — which at low traffic is
// the common case, and behaves exactly as before.
//
// Kept free of imports and JSX so it can be tested directly.

/**
 * Games from `pool` that already have someone queued at this exact bet.
 *
 * `counts` is the server's bet_counts map, keyed `gameId:entryFee:currency`.
 * The server drops a player's count the moment they are matched, so a non-zero
 * count means someone is genuinely still waiting rather than mid-game.
 */
export function gamesWithSomeoneWaiting(pool, counts, entryFee, currency) {
  if (!counts) return [];
  return pool.filter(
    (g) => (counts[`${g.queueKey}:${entryFee}:${currency}`] || 0) > 0
  );
}

/**
 * Where Quick Match should send this player.
 *
 * @param rng injectable for tests; defaults to Math.random
 * @returns a game from `pool`, or null if the pool is empty
 */
export function chooseGame(pool, counts, entryFee, currency, rng = Math.random) {
  if (!pool || pool.length === 0) return null;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const waiting = gamesWithSomeoneWaiting(pool, counts, entryFee, currency);
  return waiting.length ? pick(waiting) : pick(pool);
}
