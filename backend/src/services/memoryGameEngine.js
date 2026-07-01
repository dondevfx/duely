const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');

const GRID_SIZE     = 9;
const SEQ_LEN       = 5;
const ROUNDS_TO_WIN = 2;

function makeSequence() {
  return Array.from({ length: SEQ_LEN }, () => Math.floor(Math.random() * GRID_SIZE));
}

const memoryRooms = new Map();
const memoryQueue = [];

function _makeRoomData(p1, p2, entryFee, currency) {
  return {
    players:   [p1, p2],
    sequence:  makeSequence(),
    state:     'waiting',
    progress:  { [p1.socketId]: 0, [p2.socketId]: 0 },
    entryFee:  entryFee || 0,
    currency:  currency || 'coins',
    rematches: {},
    round:     1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

function createDirectMemoryRoom(p1, p2) {
  const roomId = uuidv4();
  memoryRooms.set(roomId, _makeRoomData(p1, p2, 0, 'none'));
  return { roomId };
}

function addToMemoryQueue(player) {
  if (memoryQueue.some(p => p.socketId === player.socketId)) return null;
  memoryQueue.push(player);
  return tryMemoryMatch();
}

function removeFromMemoryQueue(socketId) {
  const idx = memoryQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) memoryQueue.splice(idx, 1);
}

function tryMemoryMatch() {
  if (memoryQueue.length < 2) return null;
  memoryQueue.sort((a, b) => a.elo - b.elo);
  const p1 = memoryQueue.shift();
  const idx = memoryQueue.findIndex(p => p.entryFee === p1.entryFee && p.currency === p1.currency && !!p.isDemo === !!p1.isDemo);
  if (idx === -1) { memoryQueue.unshift(p1); return null; }
  const p2 = memoryQueue.splice(idx, 1)[0];
  const roomId = uuidv4();
  memoryRooms.set(roomId, _makeRoomData(p1, p2, p1.entryFee, p1.currency || 'coins'));
  return { roomId, p1, p2 };
}

function getMemoryRoom(roomId)    { return memoryRooms.get(roomId); }
function deleteMemoryRoom(roomId) { memoryRooms.delete(roomId); }

function getMemoryRoomBySocket(socketId) {
  for (const [roomId, room] of memoryRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

// ─── Countdown + sequence playback ──────────────────────────────────────────
async function startMemoryCountdown(io, supabase, roomId) {
  const room = getMemoryRoom(roomId);
  if (!room) return;
  room.state = 'countdown';

  for (let i = 3; i >= 1; i--) {
    if (!getMemoryRoom(roomId)) return;
    io.to(roomId).emit('memory_countdown', { count: i });
    await sleep(1000);
  }

  const r = getMemoryRoom(roomId);
  if (!r || r.state !== 'countdown') return;

  // Fresh sequence for each round
  r.sequence = makeSequence();
  for (const p of r.players) r.progress[p.socketId] = 0;

  r.state = 'watch';
  io.to(roomId).emit('memory_sequence_start', { sequence: r.sequence });
  await sleep(600);

  for (const tile of r.sequence) {
    if (getMemoryRoom(roomId)?.state !== 'watch') return;
    io.to(roomId).emit('memory_show', { tile });
    await sleep(700);
    io.to(roomId).emit('memory_hide');
    await sleep(250);
  }

  const afterWatch = getMemoryRoom(roomId);
  if (!afterWatch || afterWatch.state !== 'watch') return;

  afterWatch.state = 'active';
  io.to(roomId).emit('memory_go');

  for (const p of afterWatch.players) {
    if (p.isBot) simulateBotMemory(io, supabase, roomId, p.socketId, afterWatch.sequence);
  }
}

// ─── Player clicks a tile ───────────────────────────────────────────────────
function handleMemoryClick(io, supabase, roomId, socketId, tileIndex) {
  const room = getMemoryRoom(roomId);
  if (!room || room.state !== 'active') return;

  const pos = room.progress[socketId];
  if (pos === undefined) return;

  if (tileIndex === room.sequence[pos]) {
    room.progress[socketId] = pos + 1;
    io.to(socketId).emit('memory_correct', { pos: room.progress[socketId] });
    for (const p of room.players) {
      if (p.socketId !== socketId) {
        io.to(p.socketId).emit('memory_opponent_progress', {
          progress: room.progress[socketId] / room.sequence.length,
        });
      }
    }
    if (room.progress[socketId] >= room.sequence.length) {
      resolveMemoryRound(io, supabase, roomId, socketId);
    }
  } else {
    room.progress[socketId] = 0;
    io.to(socketId).emit('memory_wrong');
    for (const p of room.players) {
      if (p.socketId !== socketId) {
        io.to(p.socketId).emit('memory_opponent_progress', { progress: 0 });
      }
    }
  }
}

// ─── Resolve a round ─────────────────────────────────────────────────────────
async function resolveMemoryRound(io, supabase, roomId, winnerSocketId) {
  const room = getMemoryRoom(roomId);
  if (!room || room.state === 'finished' || room.state === 'between_rounds' || room.resolvingRound) return;
  room.resolvingRound = true;

  const winner = room.players.find(p => p.socketId === winnerSocketId);
  const loser  = room.players.find(p => p.socketId !== winnerSocketId);
  if (!winner || !loser) { room.resolvingRound = false; return; }

  room.roundWins[winner.userId] = (room.roundWins[winner.userId] || 0) + 1;
  const roundsWon = room.roundWins[winner.userId];
  const scores = { ...room.roundWins };

  if (roundsWon >= ROUNDS_TO_WIN) {
    // Match over
    room.state = 'finished';
    room.resolvingRound = false;

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
      } catch (e) { console.error('Memory settle error:', e.message); }
    }

    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[memoryGameEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[memoryGameEngine] RPC failed:', e.message); }
    }

    io.to(roomId).emit('memory_result', {
      winnerId:       winner.userId,
      loserId:        loser.userId,
      winnerUsername: winner.username,
      loserUsername:  loser.username,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      currency: room.currency || 'coins',
      scores,
    });
  } else {
    // Lock state immediately so no clicks bleed through
    room.state = 'between_rounds';
    room.round++;
    room.resolvingRound = false;

    io.to(roomId).emit('memory_round_result', {
      round:         room.round - 1,
      roundWinnerId: winner.userId,
      scores,
    });

    await sleep(2500);
    const current = getMemoryRoom(roomId);
    if (current && current.state === 'between_rounds') {
      await startMemoryCountdown(io, supabase, roomId);
    }
  }
}

// backwards compat alias
const resolveMemoryMatch = resolveMemoryRound;

// ─── Bot simulation ──────────────────────────────────────────────────────────
function simulateBotMemory(io, supabase, roomId, botSocketId, sequence) {
  let localPos = 0;

  function clickNext() {
    const room = getMemoryRoom(roomId);
    if (!room || room.state !== 'active') return;

    setTimeout(() => {
      const r = getMemoryRoom(roomId);
      if (!r || r.state !== 'active') return;

      let tile;
      if (Math.random() < 0.15) {
        do { tile = Math.floor(Math.random() * GRID_SIZE); } while (tile === sequence[localPos]);
        handleMemoryClick(io, supabase, roomId, botSocketId, tile);
        localPos = 0;
      } else {
        tile = sequence[localPos];
        handleMemoryClick(io, supabase, roomId, botSocketId, tile);
        localPos++;
      }

      const rAfter = getMemoryRoom(roomId);
      if (rAfter && rAfter.state === 'active' && localPos < sequence.length) clickNext();
    }, 900 + Math.random() * 700);
  }

  setTimeout(clickNext, 1200 + Math.random() * 600);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  makeSequence,
  createDirectMemoryRoom,
  addToMemoryQueue,
  removeFromMemoryQueue,
  getMemoryRoom,
  deleteMemoryRoom,
  getMemoryRoomBySocket,
  startMemoryCountdown,
  handleMemoryClick,
  resolveMemoryMatch,
};
