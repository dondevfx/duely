const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { updateHighscore } = require('./highscoreService');

const ROUNDS_TO_WIN = 1;

const snakeRooms = new Map();
const snakeQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToSnakeQueue(player) {
  const idx = snakeQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = snakeQueue.splice(idx, 1)[0];
    const roomId = 'snake_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    snakeRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  snakeQueue.push(player);
  return null;
}

function removeFromSnakeQueue(socketId) {
  const idx = snakeQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) snakeQueue.splice(idx, 1);
}

function getSnakeRoom(roomId)    { return snakeRooms.get(roomId); }
function deleteSnakeRoom(roomId) { snakeRooms.delete(roomId); }
function getSnakeRoomBySocket(socketId) {
  for (const [roomId, room] of snakeRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectSnakeRoom(p1, p2) {
  const roomId = 'snake_' + uuidv4();
  snakeRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function createSoloSnakeRoom(player) {
  const roomId = 'snake_' + uuidv4();
  const room = {
    roomId, players: [player],
    state: 'countdown', deaths: {},
    isSolo: true,
    entryFee: player.entryFee || 0,
    currency: player.currency || 'coins',
    rematches: {}, round: 1,
    roundWins: { [player.userId]: 0 },
    botTimers: [],
    liveScores: {},
  };
  snakeRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId, players: [p1, p2],
    state: 'waiting', deaths: {},
    entryFee: p1.entryFee, currency: p1.currency,
    rematches: {}, round: 1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
    botTimers: [],
    liveScores: {},
  };
}

async function startSnakeRound(io, roomId) {
  const room = getSnakeRoom(roomId);
  if (!room) return;
  room.state = 'countdown';
  room.deaths = {};

  for (let i = 3; i >= 1; i--) {
    if (!getSnakeRoom(roomId)) return;
    io.to(roomId).emit('snake_countdown', { count: i });
    await sleep(1000);
  }

  const r = getSnakeRoom(roomId);
  if (!r || r.state !== 'countdown') return;
  r.state = 'active';
  io.to(roomId).emit('snake_round_start', { round: r.round });

  // Bot simulation
  for (const p of r.players) {
    if (p.isBot) _simulateBotSnake(io, roomId, p.socketId);
  }
}

function _simulateBotSnake(io, roomId, botSocketId) {
  const room = getSnakeRoom(roomId);
  if (!room) return;
  let apples = 0;

  // Bot "eats" apples slowly
  const eatInterval = setInterval(() => {
    const r = getSnakeRoom(roomId);
    if (!r || r.state !== 'active') { clearInterval(eatInterval); return; }
    apples++;
    const realPlayer = r.players.find(p => !p.isBot);
    if (realPlayer) io.to(realPlayer.socketId).emit('snake_opponent_score', { score: apples });
  }, 3000 + Math.random() * 2000);

  // Bot dies after 10-20 seconds (easy to beat)
  const deathDelay = 10000 + Math.random() * 10000;
  const deathTimer = setTimeout(() => {
    clearInterval(eatInterval);
    const r = getSnakeRoom(roomId);
    if (!r || r.state !== 'active') return;
    handleSnakeDeath(io, null, roomId, botSocketId, apples);
  }, deathDelay);

  room.botTimers.push(eatInterval, deathTimer);
}

async function handleSnakeDeath(io, supabase, roomId, socketId, applesEaten, botScore = null) {
  const room = getSnakeRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.deaths[socketId] !== undefined) return;

  room.deaths[socketId] = applesEaten;

  // Clear any pending bot timers
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  // Solo / vs-bot — report score and settle if wagered
  if (room.isSolo) {
    room.state = 'finished';
    const player = room.players[0];
    let balanceChange = null;
    const humanWon = botScore !== null ? applesEaten >= botScore : null;
    if (supabase && room.entryFee > 0 && humanWon !== null) {
      try {
        balanceChange = await settleBotMatch(supabase, player.userId, room.entryFee, room.currency || 'coins', humanWon);
      } catch (e) { console.error('[snakeEngine] solo settle error:', e.message); }
    }
    if (supabase && !player.isBot && humanWon !== null) {
      const BOT_ELO = 1000;
      const { newWinnerElo, newLoserElo } = humanWon
        ? calculateNewRatings(player.elo, BOT_ELO)
        : calculateNewRatings(BOT_ELO, player.elo);
      const humanNewElo = humanWon ? newWinnerElo : newLoserElo;
      try { await supabase.from('profiles').update({ elo: humanNewElo }).eq('id', player.userId); } catch (e) { console.error('[snakeEngine] elo update:', e.message); }
      try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: player.userId }); } catch (e) { console.error('[snakeEngine] RPC failed:', e.message); }
      try {
        await supabase.from('matches').insert({
          player1_id: player.userId, player2_id: null, winner_id: humanWon ? player.userId : null,
          game_type: 'snake', entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[snakeEngine] matches insert:', e.message); }
      await updateHighscore(supabase, player.userId, 'snake', applesEaten);
    }
    io.to(roomId).emit('snake_result', {
      isSolo: true,
      playerId: player.userId,
      playerScore: applesEaten,
      botScore,
      humanWon,
      balanceChange,
      currency: room.currency,
      entryFee: room.entryFee,
    });
    return;
  }

  // PvP: compare apple counts — higher score wins regardless of who died
  const dyingPlayer  = room.players.find(p => p.socketId === socketId);
  const otherPlayer  = room.players.find(p => p.socketId !== socketId);
  if (!dyingPlayer || !otherPlayer) return;

  const dyingScore    = applesEaten;
  const opponentScore = (room.liveScores || {})[otherPlayer.socketId] ?? 0;

  // Winner = whoever has more apples (dying player can still win!)
  const actualWinner = dyingScore >= opponentScore ? dyingPlayer : otherPlayer;
  const actualLoser  = dyingScore >= opponentScore ? otherPlayer : dyingPlayer;

  room.state = 'between_rounds';
  io.to(roomId).emit('snake_player_died', { playerId: dyingPlayer.userId, applesEaten });

  room.roundWins[actualWinner.userId] = (room.roundWins[actualWinner.userId] || 0) + 1;
  const roundsWon = room.roundWins[actualWinner.userId];
  const scores    = { ...room.roundWins };

  if (roundsWon >= ROUNDS_TO_WIN) {
    room.state = 'finished';
    const { newWinnerElo, newLoserElo } = calculateNewRatings(actualWinner.elo, actualLoser.elo);

    let balanceChange = null;
    if (supabase && room.entryFee > 0) {
      try {
        const _hasBot = actualWinner.isBot || actualLoser.isBot;
        if (_hasBot) {
          const _humanId = actualWinner.isBot ? actualLoser.userId : actualWinner.userId;
          const _humanWon = !actualWinner.isBot;
          balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', _humanWon);
        } else {
          balanceChange = room.currency === 'diamonds'
            ? await settleMatchDiamonds(supabase, actualWinner.userId, actualLoser.userId, room.entryFee)
            : await settleMatch(supabase, actualWinner.userId, actualLoser.userId, room.entryFee);
        }
      } catch (e) { console.error('Snake settle error:', e.message); }
    }
    if (supabase && !actualWinner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', actualWinner.userId);
        await supabase.rpc('increment_win', { uid: actualWinner.userId });
      } catch (e) { console.error('[snakeEngine] RPC failed:', e.message); }
    }
    if (supabase && !actualLoser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', actualLoser.userId);
        await supabase.rpc('increment_loss', { uid: actualLoser.userId });
      } catch (e) { console.error('[snakeEngine] RPC failed:', e.message); }
    }

    // Save personal bests
    if (supabase) {
      const winnerApples = actualWinner.socketId === socketId ? dyingScore : opponentScore;
      const loserApples  = actualLoser.socketId  === socketId ? dyingScore : opponentScore;
      if (!actualWinner.isBot) await updateHighscore(supabase, actualWinner.userId, 'snake', winnerApples);
      if (!actualLoser.isBot)  await updateHighscore(supabase, actualLoser.userId,  'snake', loserApples);
      try {
        await supabase.from('matches').insert({
          player1_id: actualWinner.isBot ? null : actualWinner.userId, player2_id: actualLoser.isBot ? null : actualLoser.userId,
          winner_id: actualWinner.isBot ? null : actualWinner.userId, game_type: 'snake',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[snakeEngine] matches insert:', e.message); }
    }

    io.to(roomId).emit('snake_result', {
      winnerId: actualWinner.userId, loserId: actualLoser.userId,
      winnerUsername: actualWinner.username, loserUsername: actualLoser.username,
      newWinnerElo, newLoserElo, balanceChange,
      currency: room.currency || 'coins', scores,
    });
  } else {
    room.round++;
    io.to(roomId).emit('snake_round_result', {
      round: room.round - 1, roundWinnerId: actualWinner.userId, scores,
    });
    await sleep(3000);
    const current = getSnakeRoom(roomId);
    if (current && current.state === 'between_rounds') await startSnakeRound(io, roomId);
  }
}

function handleSnakeScorePing(io, roomId, socketId, applesEaten) {
  const room = getSnakeRoom(roomId);
  if (!room || room.state !== 'active') return;
  room.liveScores = room.liveScores || {};
  room.liveScores[socketId] = applesEaten;
  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('snake_opponent_score', { score: applesEaten });
}

module.exports = {
  addToSnakeQueue, removeFromSnakeQueue,
  getSnakeRoom, deleteSnakeRoom, getSnakeRoomBySocket,
  createDirectSnakeRoom, createSoloSnakeRoom,
  startSnakeRound, handleSnakeDeath, handleSnakeScorePing,
};
