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

/**
 * Move a reconnected player's room state from their old socket id to the new one.
 *
 * Every engine keys per-player state by socket id: Blackjack's hands, stood
 * and busted; the scores, progress and ping maps in the others. A phone that
 * drops and comes back gets a NEW socket id. The resume handler updated
 * player.socketId but left all of that behind under the old id, so the
 * returning player had no hand, no score and no turn: actions were ignored,
 * the turn timer never finished the round, and the match hung until they left
 * and forfeited.
 *
 * Shallow and generic on purpose: any plain-object or Map property of the room
 * holding the old id as a key is moved, so an engine that adds a new map is
 * covered without anyone remembering to list it here.
 */
function rekeyRoomSocket(room, oldId, newId) {
  if (!room || !oldId || !newId || oldId === newId) return;
  for (const [key, val] of Object.entries(room)) {
    if (key === 'players' || val === null || typeof val !== 'object') continue;
    if (val instanceof Map) {
      if (val.has(oldId)) { val.set(newId, val.get(oldId)); val.delete(oldId); }
    } else if (!Array.isArray(val) && Object.getPrototypeOf(val) === Object.prototype
      && Object.prototype.hasOwnProperty.call(val, oldId)) {
      val[newId] = val[oldId];
      delete val[oldId];
    }
  }
}

/**
 * Emit a match result to the room AND keep it on the room.
 *
 * A player whose connection dropped at the moment of the result is not in the
 * socket.io room, so the event never reaches them and their screen waits
 * forever. Keeping the last result lets the resume handler hand it over when
 * they come back.
 */
function emitRoomResult(io, room, roomId, event, payload) {
  if (room) room.lastResult = { event, payload };
  io.to(roomId).emit(event, payload);
}

/** Per-player variant, for engines that send each player their own result. */
function emitPlayerResult(io, room, player, event, payload) {
  if (room && player?.userId) {
    room.lastResultByUser = room.lastResultByUser || {};
    room.lastResultByUser[player.userId] = { event, payload };
  }
  io.to(player.socketId).emit(event, payload);
}

/** What a returning player missed, if the match ended while they were away. */
function missedResultFor(room, userId) {
  return room?.lastResultByUser?.[userId] || room?.lastResult || null;
}

module.exports = { findRoomBySocket, rekeyRoomSocket, emitRoomResult, emitPlayerResult, missedResultFor };
