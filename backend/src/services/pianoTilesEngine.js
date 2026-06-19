const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, updateStreaks } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { updateHighscore } = require('./highscoreService');
const MAX_TILES = 50000; // sanity cap on tilesHit
const { creditRakeback } = require('./rakebackService');

const pianoRooms = new Map();
const pianoQueue = [];

function _makeRoom(p1, p2) {
  const roomId = uuidv4();
  const isEndless = p1.isBot || p2.isBot;
  const room = {
    players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee,
    currency: p1.currency || 'coins',
    isEndless,
    alive: { [p1.socketId]: true, [p2.socketId]: true },
    tilesHit: { [p1.socketId]: 0, [p2.socketId]: 0 },
    startTime: null,
    rematches: {},
    seed: Math.floor(Math.random() * 2147483647),
    liveScores: {},
  };
  pianoRooms.set(roomId, room);
  return roomId;
}

function createDirectPianoRoom(p1, p2) {
  const roomId = _makeRoom(p1, p2);
  return { roomId };
}

function addToPianoQueue(player) {
  pianoQueue.push(player);
  if (pianoQueue.length < 2) return null;
  pianoQueue.sort((a, b) => a.elo - b.elo);
  const p1 = pianoQueue.shift();
  const idx = pianoQueue.findIndex(p =>
    p.socketId !== p1.socketId &&
    p.entryFee === p1.entryFee &&
    p.currency === p1.currency
  );
  if (idx === -1) { pianoQueue.unshift(p1); return null; }
  const p2 = pianoQueue.splice(idx, 1)[0];
  const roomId = _makeRoom(p1, p2);
  return { roomId, p1, p2 };
}

function removeFromPianoQueue(socketId) {
  const idx = pianoQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) pianoQueue.splice(idx, 1);
}

function getPianoRoom(roomId) { return pianoRooms.get(roomId) || null; }
function deletePianoRoom(roomId) { pianoRooms.delete(roomId); }

function getPianoRoomBySocket(socketId) {
  for (const [roomId, room] of pianoRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startPianoCountdown(io, supabase, roomId) {
  const room = getPianoRoom(roomId);
  if (!room) return;
  room.state = 'countdown';

  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('piano_countdown', { count: i });
    await sleep(1000);
  }

  if (!getPianoRoom(roomId)) return;
  room.state = 'active';
  room.startTime = Date.now();
  room.supabase = supabase;
  room.alive = Object.fromEntries(room.players.map(p => [p.socketId, true]));
  room.tilesHit = Object.fromEntries(room.players.map(p => [p.socketId, 0]));
  room.botTimers = room.botTimers || [];
  io.to(roomId).emit('piano_start', { seed: room.seed, startTime: room.startTime });

  // Bot simulation: score tiles toward a beatable target, emit progress to human
  if (room.isEndless) {
    const botPlayer = room.players.find(p => p.isBot);
    const human = room.players.find(p => !p.isBot);
    if (botPlayer && human) {
      const targetTiles = Math.floor(Math.random() * 80) + 60; // 60-140 tiles
      let botTiles = 0;
      // Simulate tile hits every 1.2s (slower than human game so it's beatable)
      const botInterval = setInterval(() => {
        const r = getPianoRoom(roomId);
        if (!r || r.state !== 'active') { clearInterval(botInterval); return; }
        if (botTiles >= targetTiles) { clearInterval(botInterval); return; }
        botTiles++;
        r.liveScores = r.liveScores || {};
        r.liveScores[botPlayer.socketId] = botTiles;
        io.to(human.socketId).emit('piano_opponent_progress', { tilesHit: botTiles });
      }, 1200);
      room.botTimers.push(botInterval);
    }
  }
}

async function handlePianoDeath(io, supabase, roomId, socketId, tilesHit) {
  const room = getPianoRoom(roomId);
  if (!room || room.state === 'finished') return;

  room.tilesHit[socketId] = Math.min(Math.max(0, tilesHit || 0), MAX_TILES);
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  if (room.isEndless) {
    // Bot mode: compare human tiles vs bot's accumulated score
    room.state = 'finished';
    supabase = supabase || room.supabase;
    const botPlayer = room.players.find(p => p.isBot);
    const human = room.players.find(p => !p.isBot);
    if (!human) return;
    const botTiles = botPlayer ? ((room.liveScores || {})[botPlayer.socketId] ?? 0) : 0;
    const humanWon = tilesHit >= botTiles;
    let balanceChange = null;
    if (supabase && room.entryFee > 0) {
      try {
        balanceChange = await settleBotMatch(supabase, human.userId, room.entryFee, room.currency || 'coins', humanWon);
      } catch (e) { console.error('[pianoTilesEngine] bot settle:', e.message); }
    }
    if (supabase) {
      const BOT_ELO = 1000;
      const { newWinnerElo, newLoserElo } = humanWon
        ? calculateNewRatings(human.elo, BOT_ELO)
        : calculateNewRatings(BOT_ELO, human.elo);
      const humanNewElo = humanWon ? newWinnerElo : newLoserElo;
      try { await supabase.from('profiles').update({ elo: humanNewElo }).eq('id', human.userId); } catch (e) {}
      try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: human.userId }); } catch (e) {}
      if (humanWon) {
        try {
          await updateStreaks(supabase, human.userId, null);
        } catch { /* silent — streak is best-effort */ }
      }
      try {
        await supabase.from('matches').insert({
          player1_id: human.userId, player2_id: null,
          winner_id: humanWon ? human.userId : null, game_type: 'piano',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) {}
      await updateHighscore(supabase, human.userId, 'piano', tilesHit);
    }
    io.emit('active_game_ended', { id: roomId });
    io.to(roomId).emit('piano_result', {
      isEndless: true,
      tilesHit,
      botTiles,
      humanWon,
      balanceChange,
      currency: room.currency || 'coins',
    });
    return;
  }

  // Compare tile counts — higher score wins regardless of who died first
  room.state = 'finished';
  const dyingPlayer  = room.players.find(p => p.socketId === socketId);
  const otherPlayer  = room.players.find(p => p.socketId !== socketId);
  if (!dyingPlayer || !otherPlayer) return;

  const dyingTiles    = tilesHit;
  const opponentTiles = (room.liveScores || {})[otherPlayer.socketId] ?? room.tilesHit[otherPlayer.socketId] ?? 0;

  const actualWinner = dyingTiles >= opponentTiles ? dyingPlayer : otherPlayer;
  const actualLoser  = dyingTiles >= opponentTiles ? otherPlayer : dyingPlayer;

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
    } catch (e) { console.error('Piano settle error:', e.message); }
  }

  let winnerStreak = 0;
  let isFirstWin = false;
  if (supabase && !actualWinner.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', actualWinner.userId);
      await supabase.rpc('increment_win', { uid: actualWinner.userId });
    } catch (e) { console.error('[pianoTilesEngine] RPC failed:', e.message); }
    try {
      ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, actualWinner.userId, null));
    } catch { /* streak columns may not exist yet */ }
  }
  // Always reset human loser's streak — any game, free or paid, vs bot or human
  if (supabase && !actualLoser.isBot) {
    supabase.from('profiles').update({ current_streak: 0 }).eq('id', actualLoser.userId).then().catch(() => {});
  }
  if (supabase && !actualLoser.isBot) {
    try {
      await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', actualLoser.userId);
      await supabase.rpc('increment_loss', { uid: actualLoser.userId });
    } catch (e) { console.error('[pianoTilesEngine] RPC failed:', e.message); }
  }

  // Save personal bests
  if (supabase) {
    const winnerTiles = actualWinner.socketId === socketId ? dyingTiles : opponentTiles;
    const loserTiles  = actualLoser.socketId  === socketId ? dyingTiles : opponentTiles;
    if (!actualWinner.isBot) await updateHighscore(supabase, actualWinner.userId, 'piano', winnerTiles);
    if (!actualLoser.isBot)  await updateHighscore(supabase, actualLoser.userId,  'piano', loserTiles);
    try {
      await supabase.from('matches').insert({
        player1_id: actualWinner.isBot ? null : actualWinner.userId, player2_id: actualLoser.isBot ? null : actualLoser.userId,
        winner_id: actualWinner.isBot ? null : actualWinner.userId, game_type: 'piano',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[pianoTilesEngine] matches insert:', e.message); }
  }

  // Credit rakeback for both players (skip bots — filter(Boolean) handles null)
  if (supabase && room.entryFee > 0) {
    const prizePool = room.entryFee * 2;
    const p1Id = actualWinner.isBot ? null : actualWinner.userId;
    const p2Id = actualLoser.isBot  ? null : actualLoser.userId;
    await creditRakeback(supabase, p1Id, p2Id, prizePool, room.currency || 'coins');
  }

  io.emit('active_game_ended', { id: roomId });
  io.to(roomId).emit('piano_result', {
    winnerId: actualWinner.userId,
    loserId: actualLoser.userId,
    winnerUsername: actualWinner.username,
    loserUsername: actualLoser.username,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    currency: room.currency || 'coins',
    isEndless: false,
    winnerTiles: actualWinner.socketId === socketId ? dyingTiles : opponentTiles,
    loserTiles: actualLoser.socketId === socketId ? dyingTiles : opponentTiles,
    winnerStreak: winnerStreak ?? 0,
    isFirstWin: isFirstWin ?? false,
  });
}

function handlePianoScorePing(io, roomId, socketId, tilesHit) {
  const room = getPianoRoom(roomId);
  if (!room || room.state !== 'active') return;
  room.liveScores = room.liveScores || {};
  room.liveScores[socketId] = tilesHit;
  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('piano_opponent_progress', { tilesHit });
}

module.exports = {
  createDirectPianoRoom,
  addToPianoQueue,
  removeFromPianoQueue,
  getPianoRoom,
  deletePianoRoom,
  getPianoRoomBySocket,
  startPianoCountdown,
  handlePianoDeath,
  handlePianoScorePing,
};


