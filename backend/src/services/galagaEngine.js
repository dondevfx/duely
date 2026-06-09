const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');
const { updateHighscore } = require('./highscoreService');

const galagaRooms = new Map();
const galagaQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToGalagaQueue(player) {
  const idx = galagaQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opp = galagaQueue.splice(idx, 1)[0];
    const roomId = 'glg_' + uuidv4();
    const room = _makeRoom(roomId, opp, player);
    galagaRooms.set(roomId, room);
    return { roomId, p1: opp, p2: player };
  }
  galagaQueue.push(player);
  return null;
}

function removeFromGalagaQueue(socketId) {
  const idx = galagaQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) galagaQueue.splice(idx, 1);
}

function getGalagaRoom(roomId)           { return galagaRooms.get(roomId); }
function deleteGalagaRoom(roomId)        { galagaRooms.delete(roomId); }
function getGalagaRoomBySocket(socketId) {
  for (const [roomId, room] of galagaRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectGalagaRoom(p1, p2) {
  const roomId = 'glg_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  galagaRooms.set(roomId, room);
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
    botTargetScore: isBotMode ? Math.floor(Math.random() * 8000) + 2000 : 0,
  };
}

async function startGalagaCountdown(io, supabase, roomId) {
  const room = getGalagaRoom(roomId);
  if (!room) return;
  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('galaga_countdown', { count: i });
    await sleep(1000);
  }
  const current = getGalagaRoom(roomId);
  if (!current) return;
  current.state = 'active';
  current.startTime = Date.now();
  current.scores = {};
  current.supabase = supabase;
  current.botTimers = current.botTimers || [];
  const seed = Math.floor(Math.random() * 999999);
  io.to(roomId).emit('galaga_start', { seed });

  // If bot mode, simulate bot scoring toward its target
  if (current.isBotMode) {
    const human = current.players.find(p => !p.isBot);
    if (human) {
      let botCurrentScore = 0;
      const target = current.botTargetScore;
      const pingInterval = setInterval(() => {
        const r = getGalagaRoom(roomId);
        if (!r || r.state !== 'active') { clearInterval(pingInterval); return; }
        botCurrentScore = Math.min(target, botCurrentScore + Math.floor(Math.random() * 300) + 100);
        io.to(human.socketId).emit('galaga_opponent_score', { score: botCurrentScore });
      }, 4000);
      current.botTimers.push(pingInterval);
    }
  }
}

async function handleGalagaDeath(io, supabase, roomId, deadSocketId, score = 0) {
  const room = getGalagaRoom(roomId);
  if (!room || room.state !== 'active') return;
  room.scores[deadSocketId] = score;

  const deadPlayer  = room.players.find(p => p.socketId === deadSocketId);
  const otherPlayer = room.players.find(p => p.socketId !== deadSocketId);
  if (!deadPlayer || !otherPlayer) return;

  if (room.isBotMode) {
    // Bot mode: compare human score vs botTargetScore
    const human = deadPlayer.isBot ? otherPlayer : deadPlayer;
    const humanScore = room.scores[human.socketId] ?? score;
    const humanWon = humanScore > room.botTargetScore;
    await _resolveBotMode(io, supabase || room.supabase, roomId, human, humanScore, humanWon);
  } else {
    // PvP: compare scores — higher score wins regardless of who died
    const deadScore     = score;
    const survivorScore = room.scores[otherPlayer.socketId] ?? 0;
    const actualWinner  = deadScore >= survivorScore ? deadPlayer : otherPlayer;
    const actualLoser   = deadScore >= survivorScore ? otherPlayer : deadPlayer;
    await _resolve(io, supabase || room.supabase, roomId, actualWinner, actualLoser, deadScore, survivorScore);
  }
}

async function _resolveBotMode(io, supabase, roomId, human, humanScore, humanWon) {
  const room = getGalagaRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      balanceChange = await settleBotMatch(supabase, human.userId, room.entryFee, room.currency || 'coins', humanWon);
    } catch (e) { console.error('Galaga bot settle:', e.message); }
  }
  if (supabase && !human.isBot) {
    const BOT_ELO = 1000;
    const { newWinnerElo, newLoserElo } = humanWon
      ? calculateNewRatings(human.elo, BOT_ELO)
      : calculateNewRatings(BOT_ELO, human.elo);
    const humanNewElo = humanWon ? newWinnerElo : newLoserElo;
    try { await supabase.from('profiles').update({ elo: humanNewElo }).eq('id', human.userId); } catch (e) { console.error('[galagaEngine] elo update:', e.message); }
    try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: human.userId }); } catch (e) { console.error('[galagaEngine] RPC failed:', e.message); }
    try {
      await supabase.from('matches').insert({
        player1_id: human.userId, player2_id: null, winner_id: humanWon ? human.userId : null,
        game_type: 'galaga', entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[galagaEngine] matches insert:', e.message); }
    await updateHighscore(supabase, human.userId, 'galaga', humanScore);
  }

  io.to(roomId).emit('galaga_result', {
    isBotMode:      true,
    humanWon,
    playerScore:    humanScore,
    botTargetScore: room.botTargetScore,
    balanceChange,
    currency:       room.currency || 'coins',
    entryFee:       room.entryFee || 0,
  });
}

async function _resolve(io, supabase, roomId, winner, loser, winnerScore, loserScore) {
  const room = getGalagaRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  const { newWinnerElo, newLoserElo } = calculateNewRatings(winner.elo, loser.elo);
  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      balanceChange = room.currency === 'diamonds'
        ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee)
        : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
    } catch (e) { console.error('Galaga settle:', e.message); }
  }
  if (supabase && !winner.isBot) {
    try { await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId); } catch (e) { console.error('[galagaEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch (e) { console.error('[galagaEngine] RPC failed:', e.message); }
    await updateHighscore(supabase, winner.userId, 'galaga', winnerScore ?? 0);
  }
  if (supabase && !loser.isBot) {
    try { await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId); } catch (e) { console.error('[galagaEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch (e) { console.error('[galagaEngine] RPC failed:', e.message); }
    await updateHighscore(supabase, loser.userId, 'galaga', loserScore ?? 0);
  }
  if (supabase) {
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'galaga',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[galagaEngine] matches insert:', e.message); }
  }
  io.to(roomId).emit('galaga_result', {
    isBotMode:      false,
    winnerId:       winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange, loserScore,
    currency: room.currency || 'coins',
  });
}

module.exports = {
  createDirectGalagaRoom,
  addToGalagaQueue, removeFromGalagaQueue,
  getGalagaRoom, deleteGalagaRoom, getGalagaRoomBySocket,
  startGalagaCountdown, handleGalagaDeath,
};
