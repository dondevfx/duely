/**
 * Shared "which room is this socket in?" lookup.
 *
 * A socket can legitimately be in two rooms at once. Rooms are not deleted the
 * instant they settle — Rush Hour holds one for 5s, and the others live until a
 * sweep collects them — while the result screen appears immediately. So a player
 * who hits Play Again lands in a new room while the old one is still in the map.
 *
 * Every engine used to return whichever room the Map happened to yield first,
 * which could be the dead one. That shadowed the live match:
 *
 *   - the leave/forfeit sweep found the finished room, cleaned it up, and moved
 *     on to the next game type without ever forfeiting the real match
 *   - a crash or progress event resolved against a room that was already over,
 *     so the new run never ended
 *   - _inLiveRoom saw a stale room and refused to start the next game
 *
 * Live always wins. A finished room is still returned when it is the only match,
 * because the cleanup paths need to be able to find it.
 */
function findRoomBySocket(rooms, socketId) {
  let finished = null;
  for (const [roomId, room] of rooms) {
    if (!room?.players?.some(p => p.socketId === socketId)) continue;
    // Engines disagree on how a finished room is marked: most set
    // state === 'finished', Word VS flips `settled` and has no state field.
    const done = room.state === 'finished' || room.settled === true;
    if (!done) return { roomId, room };
    if (!finished) finished = { roomId, room };
  }
  return finished;
}

module.exports = { findRoomBySocket };
