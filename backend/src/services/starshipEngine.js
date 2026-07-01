const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');

const starshipRooms = new Map();
const starshipQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Queue ─────────────────────────────────────────────────────────────────────

function addToStarshipQueue(player) {
  const idx = starshipQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opp = starshipQueue.splice(idx, 1)[0];
    const roomId = 'ssp_' + uuidv4();
    const room = _makeRoom(roomId, opp, player);
    starshipRooms.set(roomId, room);
    return { roomId, p1: opp, p2: player };
  }
  starshipQueue.push(player);
  return null;
}

function removeFromStarshipQueue(socketId) {
  const idx = starshipQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) starshipQueue.splice(idx, 1);
}

function getStarshipRoom(roomId)           { return starshipRooms.get(roomId); }
function deleteStarshipRoom(roomId)        { starshipRooms.delete(roomId); }
function getStarshipRoomBySocket(socketId) {
  for (const [roomId, room] of starshipRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectStarshipRoom(p1, p2) {
  const roomId = 'ssp_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  starshipRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isEndless = p1.isBot || p2.isBot;
  return {
    roomId,
    players:   [p1, p2],
    state:     'countdown',
    startTime: null,
    entryFee:  p1.entryFee,
    currency:  p1.currency,
    rematches: {},
    scores:    {},
    isEndless,
  };
}

// ── Game flow ─────────────────────────────────────────────────────────────────

async function startStarshipCountdown(io, supabase, roomId) {
  const room = getStarshipRoom(roomId);
  if (!room) return;

  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('starship_countdown', { count: i });
    await sleep(1000);
  }

  const current = getStarshipRoom(roomId);
  if (!current) return;
  current.state = 'active';
  current.startTime = Date.now();

  const seed = Math.floor(Math.random() * 999999);
  io.to(roomId).emit('starship_start', { seed });
}

async function handleStarshipDeath(io, supabase, roomId, deadSocketId, score = 0) {
  const room = getStarshipRoom(roomId);
  if (!room || room.state !== 'active') return;

  room.scores[deadSocketId] = score;

  const loser  = room.players.find(p => p.socketId === deadSocketId);
  const winner = room.players.find(p => p.socketId !== deadSocketId);
  if (!loser || !winner) return;

  await _resolve(io, supabase, roomId, winner, loser, score);
}

async function _resolve(io, supabase, roomId, winner, loser, loserScore) {
  const room = getStarshipRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  const { newWinnerElo, newLoserElo } = room.isEndless
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (!room.isEndless && supabase && room.entryFee > 0) {
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
    } catch (e) { console.error('Starship settle:', e.message); }
  }

  if (!room.isEndless) {
    if (supabase && !winner.isBot) {
      try { await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId); } catch (e) { console.error('[starshipEngine] RPC failed:', e.message); }
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch (e) { console.error('[starshipEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try { await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId); } catch (e) { console.error('[starshipEngine] RPC failed:', e.message); }
      try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch (e) { console.error('[starshipEngine] RPC failed:', e.message); }
    }
  }

  io.to(roomId).emit('starship_result', {
    isEndless:      room.isEndless,
    winnerId:       winner.userId,
    loserId:        loser.userId,
    winnerUsername: winner.username,
    loserUsername:  loser.username,
    newWinnerElo,   newLoserElo,
    balanceChange,
    loserScore,
    currency:       room.currency || 'coins',
    survivalMs:     room.startTime ? Date.now() - room.startTime : 0,
  });
}

module.exports = {
  createDirectStarshipRoom,
  addToStarshipQueue, removeFromStarshipQueue,
  getStarshipRoom, deleteStarshipRoom, getStarshipRoomBySocket,
  startStarshipCountdown, handleStarshipDeath,
};
