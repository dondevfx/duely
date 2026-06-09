const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { updateHighscore } = require('./highscoreService');

const ROUNDS_TO_WIN = 1;

const rooms2048 = new Map();
const queue2048  = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addTo2048Queue(player) {
  const idx = queue2048.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = queue2048.splice(idx, 1)[0];
    const roomId = 'g2048_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    rooms2048.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  queue2048.push(player);
  return null;
}

function removeFrom2048Queue(socketId) {
  const idx = queue2048.findIndex(p => p.socketId === socketId);
  if (idx !== -1) queue2048.splice(idx, 1);
}

function get2048Room(roomId)    { return rooms2048.get(roomId); }
function delete2048Room(roomId) { rooms2048.delete(roomId); }
function get2048RoomBySocket(socketId) {
  for (const [roomId, room] of rooms2048) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirect2048Room(p1, p2) {
  const roomId = 'g2048_' + uuidv4();
  rooms2048.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId, players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee, currency: p1.currency,
    rematches: {}, round: 1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
    done: {},
    botTimers: [],
    liveScores: {},
  };
}

async function start2048Round(io, roomId, supabase) {
  const room = get2048Room(roomId);
  if (!room) return;
  room.state = 'countdown';
  room.done  = {};
  if (supabase) room.supabase = supabase;

  for (let i = 3; i >= 1; i--) {
    if (!get2048Room(roomId)) return;
    io.to(roomId).emit('g2048_countdown', { count: i });
    await sleep(1000);
  }

  const r = get2048Room(roomId);
  if (!r || r.state !== 'countdown') return;
  r.state = 'active';
  io.to(roomId).emit('g2048_round_start', { round: r.round });

  for (const p of r.players) {
    if (p.isBot) _simulateBot2048(io, roomId, p.socketId);
  }
}

function _simulateBot2048(io, roomId, botSocketId) {
  const room = get2048Room(roomId);
  if (!room) return;
  // Bot builds a beatable score (400-1200) — game ends when human gets game over, no death timer
  const targetScore = Math.floor(Math.random() * 800) + 400;
  let currentScore = 0;
  const pingInterval = setInterval(() => {
    const r = get2048Room(roomId);
    if (!r || r.state !== 'active') { clearInterval(pingInterval); return; }
    if (currentScore >= targetScore) return; // bot stops at target
    currentScore = Math.min(targetScore, currentScore + Math.floor(Math.random() * 150) + 40);
    r.liveScores = r.liveScores || {};
    r.liveScores[botSocketId] = currentScore;
    const human = r.players.find(p => !p.isBot);
    if (human) io.to(human.socketId).emit('g2048_opponent_score', { score: currentScore });
  }, 5000);
  room.botTimers.push(pingInterval);
}

async function _resolveRound(io, supabase, roomId, winnerSocketId, loserSocketId) {
  const room = get2048Room(roomId);
  if (!room) return;
  supabase = supabase || room.supabase;

  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  const winner = room.players.find(p => p.socketId === winnerSocketId);
  const loser  = room.players.find(p => p.socketId === loserSocketId);
  if (!winner || !loser) return;

  room.state = 'between_rounds';
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
      } catch (e) { console.error('2048 settle error:', e.message); }
    }
    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[game2048Engine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[game2048Engine] RPC failed:', e.message); }
    }

    // Save personal bests
    if (supabase) {
      const winnerScore = (room.liveScores || {})[winner.socketId] ?? (room.done[winner.socketId] ?? 0);
      const loserScore  = (room.liveScores || {})[loser.socketId]  ?? (room.done[loser.socketId]  ?? 0);
      if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'twoFortyEight', winnerScore);
      if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'twoFortyEight', loserScore);
      try {
        await supabase.from('matches').insert({
          player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
          winner_id: winner.isBot ? null : winner.userId, game_type: 'twoFortyEight',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[game2048Engine] matches insert:', e.message); }
    }

    io.to(roomId).emit('g2048_result', {
      winnerId: winner.userId, loserId: loser.userId,
      winnerUsername: winner.username, loserUsername: loser.username,
      newWinnerElo, newLoserElo, balanceChange,
      currency: room.currency || 'coins', scores,
    });
  } else {
    room.round++;
    io.to(roomId).emit('g2048_round_result', {
      round: room.round - 1, roundWinnerId: winner.userId, scores,
    });
    await sleep(3000);
    const current = get2048Room(roomId);
    if (current && current.state === 'between_rounds') await start2048Round(io, roomId);
  }
}

async function handle2048GameOver(io, supabase, roomId, socketId, score) {
  const room = get2048Room(roomId);
  if (!room || room.state !== 'active') return;
  if (room.done[socketId] !== undefined) return;
  room.done[socketId] = score;

  const dyingPlayer  = room.players.find(p => p.socketId === socketId);
  const otherPlayer  = room.players.find(p => p.socketId !== socketId);
  if (!dyingPlayer || !otherPlayer) return;

  // Compare scores — higher score wins regardless of who got game-over first
  const dyingScore    = score;
  const opponentScore = (room.liveScores || {})[otherPlayer.socketId] ?? 0;
  const winnerPlayer  = dyingScore >= opponentScore ? dyingPlayer : otherPlayer;
  const loserPlayer   = dyingScore >= opponentScore ? otherPlayer : dyingPlayer;

  io.to(roomId).emit('g2048_player_done', { playerId: dyingPlayer.userId, score, reason: 'gameover' });
  await _resolveRound(io, supabase || room.supabase, roomId, winnerPlayer.socketId, loserPlayer.socketId);
}

async function handle2048Reached(io, supabase, roomId, socketId, score) {
  const room = get2048Room(roomId);
  if (!room || room.state !== 'active') return;
  if (room.done[socketId] !== undefined) return;
  room.done[socketId] = score;

  const winner = room.players.find(p => p.socketId === socketId);
  const loser  = room.players.find(p => p.socketId !== socketId);
  if (!winner || !loser) return;

  io.to(roomId).emit('g2048_player_done', { playerId: winner.userId, score, reason: 'reached2048' });
  await _resolveRound(io, supabase || room.supabase, roomId, winner.socketId, loser.socketId);
}

function handle2048ScorePing(io, roomId, socketId, score) {
  const room = get2048Room(roomId);
  if (!room || room.state !== 'active') return;
  room.liveScores = room.liveScores || {};
  room.liveScores[socketId] = score;
  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('g2048_opponent_score', { score });
}

module.exports = {
  addTo2048Queue, removeFrom2048Queue,
  get2048Room, delete2048Room, get2048RoomBySocket,
  createDirect2048Room,
  start2048Round, handle2048GameOver, handle2048Reached, handle2048ScorePing,
};
