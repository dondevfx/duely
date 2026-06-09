const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');

const ROUNDS_TO_WIN = 2;

const crossroadRooms = new Map();
const crossroadQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToCrossroadQueue(player) {
  const idx = crossroadQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = crossroadQueue.splice(idx, 1)[0];
    const roomId = 'crossroad_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    crossroadRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  crossroadQueue.push(player);
  return null;
}

function removeFromCrossroadQueue(socketId) {
  const idx = crossroadQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) crossroadQueue.splice(idx, 1);
}

function getCrossroadRoom(roomId)    { return crossroadRooms.get(roomId); }
function deleteCrossroadRoom(roomId) { crossroadRooms.delete(roomId); }
function getCrossroadRoomBySocket(socketId) {
  for (const [roomId, room] of crossroadRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectCrossroadRoom(p1, p2) {
  const roomId = 'crossroad_' + uuidv4();
  crossroadRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId, players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee, currency: p1.currency,
    rematches: {}, round: 1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
    crossed: {},
    botTimers: [],
  };
}

async function startCrossroadRound(io, roomId) {
  const room = getCrossroadRoom(roomId);
  if (!room) return;
  room.state   = 'countdown';
  room.crossed = {};

  for (let i = 3; i >= 1; i--) {
    if (!getCrossroadRoom(roomId)) return;
    io.to(roomId).emit('crossroad_countdown', { count: i });
    await sleep(1000);
  }

  const r = getCrossroadRoom(roomId);
  if (!r || r.state !== 'countdown') return;
  r.state = 'active';
  io.to(roomId).emit('crossroad_round_start', { round: r.round });

  for (const p of r.players) {
    if (p.isBot) _simulateBotCrossroad(io, roomId, p.socketId);
  }
}

function _simulateBotCrossroad(io, roomId, botSocketId) {
  const room = getCrossroadRoom(roomId);
  if (!room) return;
  // Bot crosses after 14-28 seconds
  const delay = 14000 + Math.random() * 14000;
  const timer = setTimeout(() => {
    const r = getCrossroadRoom(roomId);
    if (!r || r.state !== 'active') return;
    handleCrossroadGoal(io, null, roomId, botSocketId);
  }, delay);
  room.botTimers.push(timer);
}

async function handleCrossroadGoal(io, supabase, roomId, socketId) {
  const room = getCrossroadRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.crossed[socketId]) return;
  room.crossed[socketId] = true;

  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  const winner = room.players.find(p => p.socketId === socketId);
  const loser  = room.players.find(p => p.socketId !== socketId);
  if (!winner || !loser) return;

  room.state = 'between_rounds';
  io.to(roomId).emit('crossroad_player_crossed', { playerId: winner.userId });

  room.roundWins[winner.userId] = (room.roundWins[winner.userId] || 0) + 1;
  const roundsWon = room.roundWins[winner.userId];
  const scores    = { ...room.roundWins };

  if (roundsWon >= ROUNDS_TO_WIN) {
    room.state = 'finished';
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
      } catch (e) { console.error('Crossroad settle error:', e.message); }
    }
    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[crossroadEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[crossroadEngine] RPC failed:', e.message); }
    }

    io.to(roomId).emit('crossroad_result', {
      winnerId: winner.userId, loserId: loser.userId,
      winnerUsername: winner.username, loserUsername: loser.username,
      newWinnerElo, newLoserElo, balanceChange,
      currency: room.currency || 'coins', scores,
    });
  } else {
    room.round++;
    io.to(roomId).emit('crossroad_round_result', {
      round: room.round - 1, roundWinnerId: winner.userId, scores,
    });
    await sleep(3000);
    const current = getCrossroadRoom(roomId);
    if (current && current.state === 'between_rounds') await startCrossroadRound(io, roomId);
  }
}

function handleCrossroadProgress(io, roomId, socketId, row) {
  const room = getCrossroadRoom(roomId);
  if (!room || room.state !== 'active') return;
  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('crossroad_opponent_progress', { row });
}

module.exports = {
  addToCrossroadQueue, removeFromCrossroadQueue,
  getCrossroadRoom, deleteCrossroadRoom, getCrossroadRoomBySocket,
  createDirectCrossroadRoom,
  startCrossroadRound, handleCrossroadGoal, handleCrossroadProgress,
};
