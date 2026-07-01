const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');

const TARGET_COUNT  = 5;
const ROUNDS_TO_WIN = 2;

const aimRooms = new Map();
const aimQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateTargets() {
  return Array.from({ length: TARGET_COUNT }, () => ({
    id: uuidv4(),
    x:  Math.round(8  + Math.random() * 84),
    y:  Math.round(10 + Math.random() * 78),
  }));
}

// ── Queue ────────────────────────────────────────────────────────────────────
function addToAimQueue(player) {
  const idx = aimQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opponent = aimQueue.splice(idx, 1)[0];
    const roomId = 'aim_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    aimRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  aimQueue.push(player);
  return null;
}

function removeFromAimQueue(socketId) {
  const idx = aimQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) aimQueue.splice(idx, 1);
}

function getAimRoom(roomId)           { return aimRooms.get(roomId); }
function deleteAimRoom(roomId)        { aimRooms.delete(roomId); }
function getAimRoomBySocket(socketId) {
  for (const [roomId, room] of aimRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectAimRoom(p1, p2) {
  const roomId = 'aim_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  aimRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId,
    players:   [p1, p2],
    state:     'countdown',
    targets:   generateTargets(),
    progress:  { [p1.socketId]: 0, [p2.socketId]: 0 },
    entryFee:  p1.entryFee,
    currency:  p1.currency,
    rematches: {},
    round:     1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

// ── Game flow ────────────────────────────────────────────────────────────────
async function startAimCountdown(io, supabase, roomId) {
  const room = getAimRoom(roomId);
  if (!room) return;
  room.state = 'countdown';

  for (let i = 3; i >= 1; i--) {
    if (!getAimRoom(roomId)) return;
    io.to(roomId).emit('aim_countdown', { count: i });
    await sleep(1000);
  }

  const current = getAimRoom(roomId);
  if (!current) return;
  current.state = 'active';

  // Reset progress and generate fresh targets for this round
  for (const p of current.players) current.progress[p.socketId] = 0;
  current.targets = generateTargets();

  io.to(roomId).emit('aim_start', { targets: current.targets });

  for (const player of current.players) {
    if (player.isBot) {
      _scheduleBotAimClick(io, supabase, roomId, player.socketId, current.targets[0].id);
    }
  }
}

function _scheduleBotAimClick(io, supabase, roomId, botSocketId, targetId) {
  const delay = 1000 + Math.random() * 1000;
  setTimeout(async () => {
    const room = getAimRoom(roomId);
    if (!room || room.state !== 'active') return;
    await handleAimClick(io, supabase, roomId, botSocketId, targetId);
  }, delay);
}

async function handleAimClick(io, supabase, roomId, socketId, targetId) {
  const room = getAimRoom(roomId);
  if (!room || room.state !== 'active') return;

  const progress = room.progress[socketId] ?? 0;
  if (progress >= TARGET_COUNT) return;

  const expected = room.targets[progress];
  if (!expected || expected.id !== targetId) return;

  room.progress[socketId] = progress + 1;
  const newProgress = room.progress[socketId];
  const player = room.players.find(p => p.socketId === socketId);
  const opp    = room.players.find(p => p.socketId !== socketId);

  if (newProgress >= TARGET_COUNT) {
    await resolveAimRound(io, supabase, roomId, player);
    return;
  }

  const nextTarget = room.targets[newProgress];
  io.to(socketId).emit('aim_next', { target: nextTarget, progress: newProgress });

  if (opp && !opp.isBot) {
    io.to(opp.socketId).emit('aim_opponent_progress', { progress: newProgress });
  }

  if (player?.isBot) {
    _scheduleBotAimClick(io, supabase, roomId, player.socketId, nextTarget.id);
  }
}

async function resolveAimRound(io, supabase, roomId, winnerPlayer) {
  const room = getAimRoom(roomId);
  if (!room || room.state === 'finished' || room.state === 'between_rounds' || room.resolvingRound) return;
  room.resolvingRound = true;

  const loser = room.players.find(p => p.socketId !== winnerPlayer.socketId);
  if (!loser) { room.resolvingRound = false; return; }

  room.roundWins[winnerPlayer.userId] = (room.roundWins[winnerPlayer.userId] || 0) + 1;
  const roundsWon = room.roundWins[winnerPlayer.userId];
  const scores = { ...room.roundWins };

  if (roundsWon >= ROUNDS_TO_WIN) {
    // Match over
    room.state = 'finished';
    room.resolvingRound = false;

    const { newWinnerElo, newLoserElo } = calculateNewRatings(winnerPlayer.elo, loser.elo);

    let balanceChange = null;
    if (supabase && room.entryFee > 0) {
      try {
        const _hasBot = winnerPlayer.isBot || loser.isBot;
        if (_hasBot) {
          const _humanId = winnerPlayer.isBot ? loser.userId : winnerPlayer.userId;
          const _humanWon = !winnerPlayer.isBot;
          balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', _humanWon);
        } else {
          balanceChange = room.currency === 'diamonds'
            ? await settleMatchDiamonds(supabase, winnerPlayer.userId, loser.userId, room.entryFee)
            : await settleMatch(supabase, winnerPlayer.userId, loser.userId, room.entryFee);
        }
      } catch (err) { console.error('Aim settlement error:', err.message); }
    }

    if (supabase && !winnerPlayer.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winnerPlayer.userId);
        await supabase.rpc('increment_win', { uid: winnerPlayer.userId });
      } catch (e) { console.error('[aimGameEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[aimGameEngine] RPC failed:', e.message); }
    }

    const finalProgress = {};
    for (const p of room.players) finalProgress[p.userId] = room.progress[p.socketId] ?? 0;

    io.to(roomId).emit('aim_result', {
      winnerId:       winnerPlayer.userId,
      loserId:        loser.userId,
      winnerUsername: winnerPlayer.username,
      loserUsername:  loser.username,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      finalProgress,
      currency: room.currency || 'coins',
      scores,
    });
  } else {
    // Lock state immediately so no clicks bleed through
    room.state = 'between_rounds';
    room.round++;
    room.resolvingRound = false;

    io.to(roomId).emit('aim_round_result', {
      round:         room.round - 1,
      roundWinnerId: winnerPlayer.userId,
      scores,
    });

    await sleep(2500);
    const current = getAimRoom(roomId);
    if (current && current.state === 'between_rounds') {
      await startAimCountdown(io, supabase, roomId);
    }
  }
}

// backwards compat alias
const resolveAimMatch = resolveAimRound;

module.exports = {
  createDirectAimRoom,
  addToAimQueue, removeFromAimQueue,
  getAimRoom, deleteAimRoom, getAimRoomBySocket,
  startAimCountdown, handleAimClick, resolveAimMatch,
};
