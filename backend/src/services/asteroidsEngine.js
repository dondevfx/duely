const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');
const { updateHighscore } = require('./highscoreService');

const asteroidRooms = new Map();
const asteroidQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Queue ─────────────────────────────────────────────────────────────────────
function addToAsteroidQueue(player) {
  const idx = asteroidQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opp = asteroidQueue.splice(idx, 1)[0];
    const roomId = 'ast_' + uuidv4();
    const room = _makeRoom(roomId, opp, player);
    asteroidRooms.set(roomId, room);
    return { roomId, p1: opp, p2: player };
  }
  asteroidQueue.push(player);
  return null;
}

function removeFromAsteroidQueue(socketId) {
  const idx = asteroidQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) asteroidQueue.splice(idx, 1);
}

function getAsteroidRoom(roomId)           { return asteroidRooms.get(roomId); }
function deleteAsteroidRoom(roomId)        { asteroidRooms.delete(roomId); }
function getAsteroidRoomBySocket(socketId) {
  for (const [roomId, room] of asteroidRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectAsteroidRoom(p1, p2) {
  const roomId = 'ast_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  asteroidRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isBotMode = p1.isBot || p2.isBot;
  return {
    roomId,
    players:      [p1, p2],
    state:        'countdown',
    startTime:    null,
    entryFee:     p1.entryFee,
    currency:     p1.currency,
    rematches:    {},
    scores:       {},
    isBotMode,
    botTargetScore: isBotMode ? Math.floor(Math.random() * 10000) + 3000 : 0,
  };
}

// ── Game flow ─────────────────────────────────────────────────────────────────
async function startAsteroidCountdown(io, supabase, roomId) {
  const room = getAsteroidRoom(roomId);
  if (!room) return;

  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('asteroid_countdown', { count: i });
    await sleep(1000);
  }

  const current = getAsteroidRoom(roomId);
  if (!current) return;
  current.state = 'active';
  current.startTime = Date.now();
  current.scores = {};
  current.supabase = supabase;

  const seed = Math.floor(Math.random() * 999999);
  io.to(roomId).emit('asteroid_start', { seed });
}

async function handleAsteroidDeath(io, supabase, roomId, deadSocketId) {
  const room = getAsteroidRoom(roomId);
  if (!room || room.state !== 'active') return;

  const deadPlayer  = room.players.find(p => p.socketId === deadSocketId);
  const otherPlayer = room.players.find(p => p.socketId !== deadSocketId);
  if (!deadPlayer || !otherPlayer) return;

  if (room.isBotMode) {
    // Bot mode: compare human score vs botTargetScore
    const human = deadPlayer.isBot ? otherPlayer : deadPlayer;
    const humanScore = room.scores[human.socketId] ?? 0;
    const humanWon = humanScore > room.botTargetScore;
    await _resolveBotMode(io, supabase || room.supabase, roomId, human, humanScore, humanWon);
  } else {
    // PvP: compare scores — higher score wins regardless of who died
    const deadScore     = room.scores[deadSocketId] ?? 0;
    const survivorScore = room.scores[otherPlayer.socketId] ?? 0;
    const actualWinner  = deadScore >= survivorScore ? deadPlayer : otherPlayer;
    const actualLoser   = deadScore >= survivorScore ? otherPlayer : deadPlayer;
    await resolveAsteroidMatch(io, supabase || room.supabase, roomId, actualWinner, actualLoser);
  }
}

async function _resolveBotMode(io, supabase, roomId, human, humanScore, humanWon) {
  const room = getAsteroidRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      balanceChange = await settleBotMatch(supabase, human.userId, room.entryFee, room.currency || 'coins', humanWon);
    } catch (err) { console.error('Asteroids bot settle:', err.message); }
  }
  if (supabase && !human.isBot) {
    const BOT_ELO = 1000;
    const { newWinnerElo, newLoserElo } = humanWon
      ? calculateNewRatings(human.elo, BOT_ELO)
      : calculateNewRatings(BOT_ELO, human.elo);
    const humanNewElo = humanWon ? newWinnerElo : newLoserElo;
    try { await supabase.from('profiles').update({ elo: humanNewElo }).eq('id', human.userId); } catch (e) { console.error('[asteroidsEngine] elo update:', e.message); }
    if (humanWon) {
      try { await supabase.rpc('increment_win', { uid: human.userId }); } catch (e) { console.error('[asteroidsEngine] RPC failed:', e.message); }
    } else {
      try { await supabase.rpc('increment_loss', { uid: human.userId }); } catch (e) { console.error('[asteroidsEngine] RPC failed:', e.message); }
    }
    try {
      await supabase.from('matches').insert({
        player1_id: human.userId, player2_id: null, winner_id: humanWon ? human.userId : null,
        game_type: 'asteroids', entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[asteroidsEngine] matches insert:', e.message); }
    await updateHighscore(supabase, human.userId, 'asteroids', humanScore);
  }

  io.to(roomId).emit('asteroid_result', {
    isBotMode:      true,
    humanWon,
    playerScore:    humanScore,
    botTargetScore: room.botTargetScore,
    balanceChange,
    currency:       room.currency || 'coins',
    entryFee:       room.entryFee || 0,
  });
}

async function resolveAsteroidMatch(io, supabase, roomId, winner, loser) {
  const room = getAsteroidRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  const survivalMs = room.startTime ? Date.now() - room.startTime : 0;
  const { newWinnerElo, newLoserElo } = calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      balanceChange = room.currency === 'diamonds'
        ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee)
        : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
    } catch (err) { console.error('Asteroids settlement error:', err.message); }
  }

  if (supabase && !winner.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
      await supabase.rpc('increment_win', { uid: winner.userId });
    } catch (e) { console.error('[asteroidsEngine] RPC failed:', e.message); }
    await updateHighscore(supabase, winner.userId, 'asteroids', room.scores[winner.socketId] ?? 0);
  }
  if (supabase && !loser.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
      await supabase.rpc('increment_loss', { uid: loser.userId });
    } catch (e) { console.error('[asteroidsEngine] RPC failed:', e.message); }
    await updateHighscore(supabase, loser.userId, 'asteroids', room.scores[loser.socketId] ?? 0);
  }
  if (supabase) {
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'asteroids',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[asteroidsEngine] matches insert:', e.message); }
  }

  io.to(roomId).emit('asteroid_result', {
    isBotMode:      false,
    winnerId:       winner.userId,
    loserId:        loser.userId,
    winnerUsername: winner.username,
    loserUsername:  loser.username,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    survivalMs,
    currency: room.currency || 'coins',
  });
}

module.exports = {
  createDirectAsteroidRoom,
  addToAsteroidQueue, removeFromAsteroidQueue,
  getAsteroidRoom, deleteAsteroidRoom, getAsteroidRoomBySocket,
  startAsteroidCountdown, handleAsteroidDeath, resolveAsteroidMatch,
};
