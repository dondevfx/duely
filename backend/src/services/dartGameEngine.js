const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');

const ROUNDS = 3;

const dartRooms = new Map();
const dartQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// xAim, yPower: 0–100, 50 = perfect center; dist 0–50 = board edge
function scoreShot(xAim, yPower) {
  const dist = Math.sqrt((xAim - 50) ** 2 + (yPower - 50) ** 2);
  if (dist <  4) return { score: 100, ring: 'bullseye' };
  if (dist < 10) return { score: 75,  ring: 'bull'     };
  if (dist < 20) return { score: 60,  ring: 'treble'   };
  if (dist < 30) return { score: 45,  ring: 'inner'    };
  if (dist < 40) return { score: 30,  ring: 'double'   };
  if (dist < 50) return { score: 15,  ring: 'outer'    };
  return           { score: 0,   ring: 'miss'     };
}

// ── Queue ─────────────────────────────────────────────────────────────────────
function addToDartQueue(player) {
  const idx = dartQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opp = dartQueue.splice(idx, 1)[0];
    const roomId = 'dart_' + uuidv4();
    const room = _makeRoom(roomId, opp, player);
    dartRooms.set(roomId, room);
    return { roomId, p1: opp, p2: player };
  }
  dartQueue.push(player);
  return null;
}

function removeFromDartQueue(socketId) {
  const idx = dartQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) dartQueue.splice(idx, 1);
}

function getDartRoom(roomId)           { return dartRooms.get(roomId); }
function deleteDartRoom(roomId)        { dartRooms.delete(roomId); }
function getDartRoomBySocket(socketId) {
  for (const [roomId, room] of dartRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectDartRoom(p1, p2) {
  const roomId = 'dart_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  dartRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId,
    players:    [p1, p2],
    state:      'countdown',
    round:      0,
    scores:     { [p1.socketId]: 0, [p2.socketId]: 0 },
    roundShots: {},
    roundTimer: null,
    entryFee:   p1.entryFee,
    currency:   p1.currency,
    rematches:  {},
  };
}

// ── Game flow ─────────────────────────────────────────────────────────────────
async function startDartCountdown(io, supabase, roomId) {
  const room = getDartRoom(roomId);
  if (!room) return;

  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('dart_countdown', { count: i });
    await sleep(1000);
  }

  const current = getDartRoom(roomId);
  if (!current) return;
  current.state = 'active';
  _startRound(io, supabase, roomId);
}

function _startRound(io, supabase, roomId) {
  const room = getDartRoom(roomId);
  if (!room || room.state !== 'active') return;
  room.round++;
  room.roundShots = {};

  // Speed increases each round
  const speed = 90 + (room.round - 1) * 20; // 90, 110, 130 units/sec

  io.to(roomId).emit('dart_round_start', {
    round: room.round,
    totalRounds: ROUNDS,
    speed,
  });

  // Bot shoots after 1.5–3.5s with decent-but-beatable accuracy
  for (const p of room.players) {
    if (p.isBot) _scheduleBotShot(io, supabase, roomId, p.socketId);
  }

  // 25s timeout — auto-submit if player doesn't shoot
  room.roundTimer = setTimeout(() => {
    for (const p of room.players) {
      if (!room.roundShots[p.socketId]) {
        room.roundShots[p.socketId] = { xAim: Math.random() * 100, yPower: Math.random() * 100 };
      }
    }
    _resolveRound(io, supabase, roomId);
  }, 25000);
}

function _scheduleBotShot(io, supabase, roomId, botSocketId) {
  const delay = 1500 + Math.random() * 2000;
  setTimeout(async () => {
    const room = getDartRoom(roomId);
    if (!room || room.state !== 'active') return;
    // Bot aims within ±22 of center on both axes
    const xAim   = 50 + (Math.random() - 0.5) * 44;
    const yPower = 50 + (Math.random() - 0.5) * 44;
    await handleDartShoot(io, supabase, roomId, botSocketId, xAim, yPower);
  }, delay);
}

async function handleDartShoot(io, supabase, roomId, socketId, xAim, yPower) {
  const room = getDartRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.roundShots[socketId] !== undefined) return;

  xAim   = Math.max(0, Math.min(100, xAim));
  yPower = Math.max(0, Math.min(100, yPower));
  room.roundShots[socketId] = { xAim, yPower };

  const player = room.players.find(p => p.socketId === socketId);
  io.to(roomId).emit('dart_player_threw', { userId: player.userId });

  if (room.players.every(p => room.roundShots[p.socketId] !== undefined)) {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    await _resolveRound(io, supabase, roomId);
  }
}

async function _resolveRound(io, supabase, roomId) {
  const room = getDartRoom(roomId);
  if (!room) return;

  const results = {};
  for (const p of room.players) {
    const shot = room.roundShots[p.socketId] || { xAim: 0, yPower: 0 };
    const scored = scoreShot(shot.xAim, shot.yPower);
    results[p.userId] = { xAim: shot.xAim, yPower: shot.yPower, ...scored };
    room.scores[p.socketId] = (room.scores[p.socketId] || 0) + scored.score;
  }

  const totals = {};
  for (const p of room.players) totals[p.userId] = room.scores[p.socketId] || 0;

  io.to(roomId).emit('dart_round_result', {
    round: room.round,
    totalRounds: ROUNDS,
    results,
    totals,
  });

  await sleep(3500);

  if (room.round >= ROUNDS) {
    await _resolveDartMatch(io, supabase, roomId);
  } else {
    _startRound(io, supabase, roomId);
  }
}

async function _resolveDartMatch(io, supabase, roomId) {
  const room = getDartRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  const sorted = room.players.slice().sort(
    (a, b) => (room.scores[b.socketId] || 0) - (room.scores[a.socketId] || 0)
  );

  const isDraw = (room.scores[sorted[0].socketId] || 0) === (room.scores[sorted[1].socketId] || 0);
  const winner = sorted[0];
  const loser  = sorted[1];

  const { newWinnerElo, newLoserElo } = isDraw
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (!isDraw && supabase && room.entryFee > 0) {
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
    } catch (err) { console.error('Dart settlement error:', err.message); }
  }

  if (!isDraw) {
    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[dartGameEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[dartGameEngine] RPC failed:', e.message); }
    }
  }

  const finalScores = {};
  for (const p of room.players) finalScores[p.userId] = room.scores[p.socketId] || 0;

  io.to(roomId).emit('dart_result', {
    isDraw,
    winnerId:       winner.userId,
    loserId:        loser.userId,
    winnerUsername: winner.username,
    loserUsername:  loser.username,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    finalScores,
    currency: room.currency || 'coins',
  });
}

module.exports = {
  createDirectDartRoom,
  addToDartQueue, removeFromDartQueue,
  getDartRoom, deleteDartRoom, getDartRoomBySocket,
  startDartCountdown, handleDartShoot,
};
