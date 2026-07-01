const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, updateStreaks } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { creditRakeback } = require('./rakebackService');

const chessRooms = new Map();
const chessQueue = [];

// ─── Queue ────────────────────────────────────────────────────────────────────

function addToChessQueue(player) {
  const idx = chessQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opponent = chessQueue.splice(idx, 1)[0];
    const roomId = 'chess_' + uuidv4();
    const room = _makeChessRoom(roomId, opponent, player);
    chessRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  chessQueue.push(player);
  return null;
}

function removeFromChessQueue(socketId) {
  const idx = chessQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) chessQueue.splice(idx, 1);
}

// ─── Room helpers ─────────────────────────────────────────────────────────────

function getChessRoom(roomId)    { return chessRooms.get(roomId); }
function deleteChessRoom(roomId) { chessRooms.delete(roomId); }

function getChessRoomBySocket(socketId) {
  for (const [roomId, room] of chessRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectChessRoom(p1, p2) {
  const roomId = 'chess_' + uuidv4();
  chessRooms.set(roomId, _makeChessRoom(roomId, p1, p2));
  return { roomId };
}

function _makeChessRoom(roomId, p1, p2) {
  return {
    roomId,
    players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee,
    currency: p1.currency,
    rematches: {},
    colors: { [p1.userId]: 'w', [p2.userId]: 'b' },
    currentTurn: 'w',
    turnTimer: null,
    consecutiveMisses: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

// ─── Game flow ────────────────────────────────────────────────────────────────

function _clearChessTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function startChessTimer(io, supabase, roomId) {
  const room = getChessRoom(roomId);
  if (!room || room.state !== 'active') return;
  _clearChessTimer(room);

  const currentPlayer = room.players.find(p => room.colors[p.userId] === room.currentTurn);
  if (!currentPlayer || currentPlayer.isBot) return;

  const endsAt = Date.now() + 30000;
  io.to(roomId).emit('chess_timer', { endsAt, currentTurn: room.currentTurn });

  room.turnTimer = setTimeout(async () => {
    room.turnTimer = null;
    const r = getChessRoom(roomId);
    if (!r || r.state !== 'active') return;
    if (r.currentTurn !== room.currentTurn) return;

    r.consecutiveMisses = r.consecutiveMisses || {};
    r.consecutiveMisses[currentPlayer.userId] = (r.consecutiveMisses[currentPlayer.userId] || 0) + 1;
    const opp = r.players.find(p => p.userId !== currentPlayer.userId);

    if (r.consecutiveMisses[currentPlayer.userId] >= 3) {
      await handleChessGameOver(io, supabase, roomId, opp?.socketId, 'afk');
      return;
    }

    r.currentTurn = r.currentTurn === 'w' ? 'b' : 'w';
    io.to(roomId).emit('chess_turn_skipped', { skippedUserId: currentPlayer.userId, nextTurn: r.currentTurn });
    startChessTimer(io, supabase, roomId);
  }, 30000);
}

function clearChessTimerForRoom(roomId) {
  const room = getChessRoom(roomId);
  if (room) _clearChessTimer(room);
}

function startChessGame(io, roomId, supabase) {
  const room = getChessRoom(roomId);
  if (!room) return;
  room.state = 'active';

  const colorsPayload = {};
  for (const p of room.players) {
    colorsPayload[p.userId] = room.colors[p.userId];
  }

  io.to(roomId).emit('chess_start', { colors: colorsPayload });
  if (supabase) startChessTimer(io, supabase, roomId);
}

function handleChessMove(io, supabase, roomId, socketId, from, to) {
  const room = getChessRoom(roomId);
  if (!room || room.state !== 'active') return;

  const mover = room.players.find(p => p.socketId === socketId);
  if (!mover) return;

  if (room.colors[mover.userId] !== room.currentTurn) return;

  _clearChessTimer(room);
  room.consecutiveMisses = room.consecutiveMisses || {};

  room.currentTurn = room.currentTurn === 'w' ? 'b' : 'w';
  if (supabase) startChessTimer(io, supabase, roomId);

  const senderSocket = io.sockets.sockets.get(socketId);
  if (senderSocket) {
    senderSocket.to(roomId).emit('chess_opponent_move', { from, to, nextTurn: room.currentTurn });
  }
}

async function handleChessGameOver(io, supabase, roomId, winnerSocketId, reason) {
  const room = getChessRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  _clearChessTimer(room);

  // Draw / stalemate
  if (winnerSocketId === null) {
    io.emit('active_game_ended', { id: roomId });
    io.to(roomId).emit('chess_result', { draw: true, reason });
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
    } catch (e) { console.error('Chess settle error:', e.message); }
  }

  let winnerStreak = 0;
  let isFirstWin = false;
  if (supabase && !winner.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
      await supabase.rpc('increment_win', { uid: winner.userId });
    } catch (e) { console.error('[chessEngine] RPC failed:', e.message); }
    try {
      ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null));
    } catch { /* streak columns may not exist yet */ }
  }
  // Always reset human loser's streak — any game, free or paid, vs bot or human
  if (supabase && !loser.isBot) {
    supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId).then().catch(() => {});
  }
  if (supabase && !loser.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
      await supabase.rpc('increment_loss', { uid: loser.userId });
    } catch (e) { console.error('[chessEngine] RPC failed:', e.message); }
  }
  if (supabase) {
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'chess',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[chessEngine] matches insert:', e.message); }
  }

  // Credit rakeback for both players (skip bots — filter(Boolean) handles null)
  if (supabase && room.entryFee > 0 && !(winner.isBot && loser.isBot)) {
    const prizePool = room.entryFee * 2;
    const p1Id = winner.isBot ? null : winner.userId;
    const p2Id = loser.isBot  ? null : loser.userId;
    await creditRakeback(supabase, p1Id, p2Id, prizePool, room.currency || 'coins');
  }

  io.emit('active_game_ended', { id: roomId });
  io.to(roomId).emit('chess_result', {
    winnerId: winner.userId,
    loserId: loser.userId,
    winnerUsername: winner.username,
    loserUsername: loser.username,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    currency: room.currency || 'coins',
    reason,
    winnerStreak: winnerStreak ?? 0,
    isFirstWin: isFirstWin ?? false,
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  addToChessQueue,
  removeFromChessQueue,
  getChessRoom,
  deleteChessRoom,
  getChessRoomBySocket,
  createDirectChessRoom,
  startChessGame,
  handleChessMove,
  handleChessGameOver,
  startChessTimer,
  clearChessTimerForRoom,
};

