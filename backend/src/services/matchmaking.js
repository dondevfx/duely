const { v4: uuidv4 } = require('uuid');

// queue: [{ socketId, userId, username, elo, entryFee, currency }]
const queue = [];
// rooms: Map<roomId, { players:[], state, goTime, clicks, entryFee, currency }>
const rooms = new Map();
// privateRooms: Map<inviteCode, roomId>
const privateRooms = new Map();

function addToQueue(player) {
  if (queue.some(p => p.socketId === player.socketId)) return null;
  queue.push(player);
  return tryMatch();
}

function removeFromQueue(socketId) {
  const idx = queue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

function tryMatch() {
  if (queue.length < 2) return null;

  // Sort by ELO and pair closest
  queue.sort((a, b) => a.elo - b.elo);
  const p1 = queue.shift();

  // Find closest entry fee match
  const matchIdx = queue.findIndex(p => p.entryFee === p1.entryFee && p.currency === p1.currency);
  if (matchIdx === -1) {
    queue.unshift(p1);
    return null;
  }
  const p2 = queue.splice(matchIdx, 1)[0];

  const roomId = uuidv4();
  rooms.set(roomId, {
    players: [p1, p2],
    state: 'waiting',
    goTime: null,
    clicks: {},
    entryFee: p1.entryFee,
    currency: p1.currency || 'coins',
    rematches: {},
  });

  return { roomId, p1, p2 };
}

// Bypass queue — create room directly (used for bot matches)
function createDirectRoom(p1, p2) {
  const roomId = uuidv4();
  rooms.set(roomId, {
    players: [p1, p2],
    state: 'waiting',
    goTime: null,
    clicks: {},
    entryFee: 0,
    currency: 'none',
    rematches: {},
  });
  return roomId;
}

function createPrivateRoom(player, entryFee) {
  const roomId = uuidv4();
  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  rooms.set(roomId, {
    players: [player],
    state: 'waiting',
    goTime: null,
    clicks: {},
    entryFee,
    currency: 'coins',
    inviteCode,
    rematches: {},
  });
  privateRooms.set(inviteCode, roomId);
  return { roomId, inviteCode };
}

function joinPrivateRoom(player, inviteCode) {
  const roomId = privateRooms.get(inviteCode);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (!room || room.players.length >= 2) return null;
  if (room.players[0].userId === player.userId) return null;
  room.players.push(player);
  privateRooms.delete(inviteCode);
  return { roomId, room };
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (room?.inviteCode) privateRooms.delete(room.inviteCode);
  rooms.delete(roomId);
}

function getRoomBySocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.some(p => p.socketId === socketId)) {
      return { roomId, room };
    }
  }
  return null;
}

module.exports = {
  addToQueue,
  removeFromQueue,
  createDirectRoom,
  createPrivateRoom,
  joinPrivateRoom,
  getRoom,
  deleteRoom,
  getRoomBySocket,
};
