/**
 * The latest sudden-death announcement, held outside React.
 *
 * The server reports a draw and announces sudden death in the same instant,
 * and the result card that has to show the countdown mounts in response to the
 * FIRST of those — so by the time the card exists, the announcement it needs
 * has already gone past. A listener on the card itself missed it every time.
 *
 * The game page is mounted for the whole match, so it listens and writes here;
 * the card reads whatever has already arrived and subscribes for anything
 * after. Keyed by pool, so a stale announcement from another tournament is
 * never shown.
 */
let current = null;
const subs = new Set();

export function setSudden(payload) {
  current = payload || null;
  for (const fn of subs) fn(current);
}

export function getSudden(poolId) {
  return current && current.poolId === poolId ? current : null;
}

export function subscribeSudden(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
