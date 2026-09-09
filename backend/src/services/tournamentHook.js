/**
 * The one thing a game engine needs to know about tournaments: nothing.
 *
 * A tournament match is an ordinary match. It is created with the same
 * createDirect<Game>Room every other match uses, played on the same screens,
 * and resolved by the same code. The only difference is that somebody is
 * waiting to hear who won.
 *
 * Rather than teach five engines what a bracket is, each engine reports its
 * outcome here — one line, next to the result it was already emitting — and
 * this hands it to whoever registered. When no tournament is running, or the
 * room is an ordinary match, `settled` returns immediately and nothing else
 * in the engine changes.
 *
 * It exists separately from tournamentRunner because the runner reaches back
 * into the engines to create rooms, and a module cannot require the module
 * that requires it. gameEvents solves the same problem for game-end sweeps;
 * this is deliberately not that bus, because a result needs a reply — the
 * runner has to be able to say "that room was mine" — and an EventEmitter
 * with a dozen unrelated listeners is the wrong shape for it.
 */

/** roomId → { poolId, round, match, a, b } */
const rooms = new Map();

let listener = null;

function onSettled(fn) { listener = fn; }

/** Claim a room as part of a bracket. */
function register(roomId, info) { rooms.set(roomId, info); }

function isTournamentRoom(roomId) { return rooms.has(roomId); }

function forget(roomId) { rooms.delete(roomId); }

/**
 * An engine reporting an outcome.
 *
 * `winnerId`/`loserId` are user ids, null on a draw. Safe to call for every
 * room: ordinary matches are not registered and fall straight through.
 */
function settled(roomId, { winnerId = null, loserId = null, isDraw = false, scores = null } = {}) {
  const info = rooms.get(roomId);
  if (!info) return false;
  rooms.delete(roomId);
  if (!listener) return false;
  try {
    listener({ ...info, roomId, winnerId, loserId, isDraw, scores });
  } catch (e) {
    console.error('[tournamentHook] listener threw:', e.message);
  }
  return true;
}

function _reset() { rooms.clear(); listener = null; }

module.exports = { onSettled, register, settled, isTournamentRoom, forget, _reset, _rooms: rooms };
