const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');

const checkersRooms = new Map();
const checkersQueue = [];

// ─── Queue ────────────────────────────────────────────────────────────────────

function addToCheckersQueue(player) {
  const idx = checkersQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = checkersQueue.splice(idx, 1)[0];
    const roomId = 'checkers_' + uuidv4();
    const room = _makeCheckersRoom(roomId, opponent, player);
    checkersRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  checkersQueue.push(player);
  return null;
}

function removeFromCheckersQueue(socketId) {
  const idx = checkersQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) checkersQueue.splice(idx, 1);
}

// ─── Room helpers ─────────────────────────────────────────────────────────────

function getCheckersRoom(roomId)    { return checkersRooms.get(roomId); }
function deleteCheckersRoom(roomId) { checkersRooms.delete(roomId); }

function getCheckersRoomBySocket(socketId) {
  for (const [roomId, room] of checkersRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectCheckersRoom(p1, p2) {
  const roomId = 'checkers_' + uuidv4();
  checkersRooms.set(roomId, _makeCheckersRoom(roomId, p1, p2));
  return { roomId };
}

function _makeCheckersRoom(roomId, p1, p2) {
  return {
    roomId,
    players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee,
    currency: p1.currency,
    rematches: {},
    colors: { [p1.userId]: 'w', [p2.userId]: 'r' },
    currentTurn: 'w',
    turnTimer: null,
    consecutiveMisses: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

// ─── Game flow ────────────────────────────────────────────────────────────────

function _clearCheckersTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function startCheckersTimer(io, supabase, roomId) {
  const room = getCheckersRoom(roomId);
  if (!room || room.state !== 'active') return;
  _clearCheckersTimer(room);

  const currentPlayer = room.players.find(p => room.colors[p.userId] === room.currentTurn);
  if (!currentPlayer || currentPlayer.isBot) return;

  const endsAt = Date.now() + 60000;
  io.to(roomId).emit('checkers_timer', { endsAt, currentTurn: room.currentTurn });

  room.turnTimer = setTimeout(async () => {
    room.turnTimer = null;
    const r = getCheckersRoom(roomId);
    if (!r || r.state !== 'active') return;
    if (r.currentTurn !== room.currentTurn) return;

    r.consecutiveMisses = r.consecutiveMisses || {};
    r.consecutiveMisses[currentPlayer.userId] = (r.consecutiveMisses[currentPlayer.userId] || 0) + 1;
    const opp = r.players.find(p => p.userId !== currentPlayer.userId);

    if (r.consecutiveMisses[currentPlayer.userId] >= 3) {
      await handleCheckersGameOver(io, supabase, roomId, opp?.socketId, 'afk');
      return;
    }

    r.currentTurn = r.currentTurn === 'w' ? 'r' : 'w';
    io.to(roomId).emit('checkers_turn_skipped', { skippedUserId: currentPlayer.userId, nextTurn: r.currentTurn });
    startCheckersTimer(io, supabase, roomId);
  }, 60000);
}

function clearCheckersTimerForRoom(roomId) {
  const room = getCheckersRoom(roomId);
  if (room) _clearCheckersTimer(room);
}

function startCheckersGame(io, roomId, supabase) {
  const room = getCheckersRoom(roomId);
  if (!room) return;
  room.state = 'active';

  const colorsPayload = {};
  for (const p of room.players) {
    colorsPayload[p.userId] = room.colors[p.userId];
  }

  io.to(roomId).emit('checkers_start', { colors: colorsPayload });
  if (supabase) startCheckersTimer(io, supabase, roomId);
}

/**
 * Handle a checkers move.
 *
 * @param {object} io
 * @param {string} roomId
 * @param {string} socketId     - socket of the moving player
 * @param {*}      from         - origin square (any format the client uses)
 * @param {*}      to           - destination square
 * @param {*}      jumped       - square(s) that were captured (null/undefined for non-jump moves)
 * @param {boolean} chainDone   - true when the player signals their multi-jump chain is finished
 */
function handleCheckersMove(io, supabase, roomId, socketId, from, to, jumped, chainDone) {
  const room = getCheckersRoom(roomId);
  if (!room || room.state !== 'active') return;

  const mover = room.players.find(p => p.socketId === socketId);
  if (!mover) return;

  if (room.colors[mover.userId] !== room.currentTurn) return;

  _clearCheckersTimer(room);
  room.consecutiveMisses = room.consecutiveMisses || {};

  const isJump = jumped !== null && jumped !== undefined;

  if (isJump && chainDone === false) {
    // Same player continues multi-jump — don't flip or restart timer yet
  } else {
    room.currentTurn = room.currentTurn === 'w' ? 'r' : 'w';
    if (supabase) startCheckersTimer(io, supabase, roomId);
  }

  const senderSocket = io.sockets.sockets.get(socketId);
  if (senderSocket) {
    senderSocket.to(roomId).emit('checkers_opponent_move', { from, to, jumped, nextTurn: room.currentTurn });
  }
}

async function handleCheckersGameOver(io, supabase, roomId, winnerSocketId, reason) {
  const room = getCheckersRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  _clearCheckersTimer(room);

  // Draw
  if (winnerSocketId === null) {
    io.to(roomId).emit('checkers_result', { draw: true, reason });
    return;
  }

  const winner = room.players.find(p => p.socketId === winnerSocketId);
  const loser  = room.players.find(p => p.socketId !== winnerSocketId);
  if (!winner || !loser) return;

  const { newWinnerElo, newLoserElo } = calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      const _hasBot = winner.isBot || loser.isBot;
      if (_hasBot) {
        const _humanId = winner.isBot ? loser.userId : winner.userId;
        const _humanWon = !winner.isBot;
        balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', _humanWon);
      } else {
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee)
          : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
      }
    } catch (e) { console.error('Checkers settle error:', e.message); }
  }

  if (supabase && !winner.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
      await supabase.rpc('increment_win', { uid: winner.userId });
    } catch (e) { console.error('[checkersEngine] RPC failed:', e.message); }
  }
  if (supabase && !loser.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
      await supabase.rpc('increment_loss', { uid: loser.userId });
    } catch (e) { console.error('[checkersEngine] RPC failed:', e.message); }
  }
  if (supabase) {
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'checkers',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[checkersEngine] matches insert:', e.message); }
  }

  io.to(roomId).emit('checkers_result', {
    winnerId: winner.userId,
    loserId: loser.userId,
    winnerUsername: winner.username,
    loserUsername: loser.username,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    currency: room.currency || 'coins',
    reason,
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  addToCheckersQueue,
  removeFromCheckersQueue,
  getCheckersRoom,
  deleteCheckersRoom,
  getCheckersRoomBySocket,
  createDirectCheckersRoom,
  startCheckersGame,
  handleCheckersMove,
  handleCheckersGameOver,
  startCheckersTimer,
  clearCheckersTimerForRoom,
};
