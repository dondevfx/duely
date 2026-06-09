const { calculateNewRatings, updateStreaks } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');
const { updateHighscore } = require('./highscoreService');
const MAX_SCORE = 15_000_000; // sanity cap — prevents score spoofing
const { creditRakeback } = require('./rakebackService');
const gameEvents = require('./gameEvents');

const blockBlastRooms = new Map();
const blockBlastQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToBlockBlastQueue(player) {
  const idx = blockBlastQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opp = blockBlastQueue.splice(idx, 1)[0];
    const roomId = 'bb_' + uuidv4();
    const room = _makeRoom(roomId, opp, player);
    blockBlastRooms.set(roomId, room);
    return { roomId, p1: opp, p2: player };
  }
  blockBlastQueue.push(player);
  return null;
}

function removeFromBlockBlastQueue(socketId) {
  const idx = blockBlastQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) blockBlastQueue.splice(idx, 1);
}

function getBlockBlastRoom(roomId)           { return blockBlastRooms.get(roomId); }
function deleteBlockBlastRoom(roomId)        { blockBlastRooms.delete(roomId); }
function getBlockBlastRoomBySocket(socketId) {
  for (const [roomId, room] of blockBlastRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectBlockBlastRoom(p1, p2) {
  const roomId = 'bb_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  blockBlastRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isSolo = p1.isBot || p2.isBot;
  return {
    roomId,
    players:        [p1, p2],
    state:          'countdown',
    startTime:      null,
    entryFee:       p1.entryFee,
    currency:       p1.currency,
    rematches:      {},
    scores:         {},
    stuck:          new Set(),
    isSolo,
    botTargetScore: isSolo ? Math.floor(Math.random() * 1800) + 400 : 0,
  };
}

async function startBlockBlastCountdown(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room) return;
  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('block_blast_countdown', { count: i });
    await sleep(1000);
  }
  const current = getBlockBlastRoom(roomId);
  if (!current) return;
  current.state = 'active';
  current.startTime = Date.now();
  current.supabase = supabase;
  current.botTimers = current.botTimers || [];
  const seed = Math.floor(Math.random() * 999999);
  io.to(roomId).emit('block_blast_start', { seed });

  // If bot mode, simulate bot scoring toward its target over 2 minutes
  if (current.isSolo) {
    const human = current.players.find(p => !p.isBot);
    if (human) {
      let botCurrentScore = 0;
      const target = current.botTargetScore;
      const pingInterval = setInterval(() => {
        const r = getBlockBlastRoom(roomId);
        if (!r || r.state !== 'active') { clearInterval(pingInterval); return; }
        botCurrentScore = Math.min(target, botCurrentScore + Math.floor(Math.random() * 80) + 20);
        io.to(human.socketId).emit('block_blast_opponent_score', { score: botCurrentScore });
      }, 6000);
      current.botTimers.push(pingInterval);
    }
  }
}

// Player got stuck (no valid placements left) — PvP only
async function handleBlockBlastStuck(io, supabase, roomId, socketId, score = 0) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active' || room.isSolo) return;
  if (room.stuck.has(socketId)) return; // already stuck

  room.stuck.add(socketId);
  room.scores[socketId] = Math.min(Math.max(0, score || 0), MAX_SCORE);

  const stuckPlayer = room.players.find(p => p.socketId === socketId);
  const otherPlayer = room.players.find(p => p.socketId !== socketId && !p.isBot);

  if (stuckPlayer) {
    io.to(roomId).emit('block_blast_player_stuck', { stuckUserId: stuckPlayer.userId });
  }

  // If opponent already has a higher score → instant resolve
  const otherScore = otherPlayer ? (room.scores[otherPlayer.socketId] ?? -1) : -1;
  if (otherScore > score) {
    await _resolveFromScores(io, supabase, roomId);
    return;
  }

  // Otherwise give the other player 30 seconds to beat the stuck player's score
  if (otherPlayer) {
    io.to(otherPlayer.socketId).emit('block_blast_keep_playing', { seconds: 30 });
    room.stuckTimer = setTimeout(async () => {
      const r = getBlockBlastRoom(roomId);
      if (!r || r.state !== 'active') return;
      await _resolveFromScores(io, supabase, roomId);
    }, 30000);
  } else {
    await _resolveFromScores(io, supabase, roomId);
  }
}

// Player submitted their final score (timer ran out)
async function handleBlockBlastComplete(io, supabase, roomId, socketId, score = 0) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
  room.scores[socketId] = Math.min(Math.max(0, score || 0), MAX_SCORE);
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  if (room.isSolo) {
    const player = room.players.find(p => !p.isBot);
    if (player) {
      room.state = 'finished';
      const botScore = room.botTargetScore || 0;
      const humanWon = score > botScore;
      let balanceChange = null;
      if (room.entryFee > 0) {
        try {
          balanceChange = await settleBotMatch(supabase, player.userId, room.entryFee, room.currency || 'coins', humanWon);
        } catch (e) { console.error('[blockBlastEngine] solo settle:', e.message); }
      }
      if (supabase) {
        const BOT_ELO = 1000;
        const { newWinnerElo, newLoserElo } = humanWon
          ? calculateNewRatings(player.elo, BOT_ELO)
          : calculateNewRatings(BOT_ELO, player.elo);
        const humanNewElo = humanWon ? newWinnerElo : newLoserElo;
        try { await supabase.from('profiles').update({ elo: humanNewElo }).eq('id', player.userId); } catch (e) { console.error('[blockBlastEngine] elo update:', e.message); }
        try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: player.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
        if (humanWon) {
          try {
            await updateStreaks(supabase, player.userId, null);
          } catch { /* silent — streak is best-effort */ }
        }
        try {
          await supabase.from('matches').insert({
            player1_id: player.userId, player2_id: null, winner_id: humanWon ? player.userId : null,
            game_type: 'blockBlast', entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
          });
        } catch (e) { console.error('[blockBlastEngine] matches insert:', e.message); }
        await updateHighscore(supabase, player.userId, 'blockBlast', score);
      }
      io.emit('active_game_ended', { id: roomId });
      gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
      io.to(roomId).emit('block_blast_result', {
        isSolo:      true,
        playerId:    player.userId,
        playerScore: score,
        botScore,
        humanWon,
        balanceChange,
        currency:    room.currency || 'coins',
        entryFee:    room.entryFee || 0,
      });
    }
    return;
  }

  // PvP: check if all players have submitted
  const allDone = room.players.every(p => p.isBot || room.scores[p.socketId] != null);
  if (allDone) {
    await _resolveFromScores(io, supabase, roomId);
  }
}

async function _forceResolve(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
  const [p1, p2] = room.players;
  const s1 = room.scores[p1.socketId];
  const s2 = room.scores[p2.socketId];
  if (s1 == null && s2 == null) {
    room.state = 'finished';
    io.emit('active_game_ended', { id: roomId });
    gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
    io.to(roomId).emit('block_blast_result', { draw: true, reason: 'timeout' });
    return;
  }
  await _resolveFromScores(io, supabase, roomId);
}

async function _resolveFromScores(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room) return;
  const [p1, p2] = room.players;
  const s1 = room.scores[p1.socketId] ?? 0;
  const s2 = room.scores[p2.socketId] ?? 0;
  const winner = s1 >= s2 ? p1 : p2;
  const loser  = s1 >= s2 ? p2 : p1;
  await _resolve(io, supabase, roomId, winner, loser, Math.max(s1, s2), Math.min(s1, s2));
}

async function _resolve(io, supabase, roomId, winner, loser, winnerScore, loserScore) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }

  const isFree = (room.entryFee || 0) === 0;
  const { newWinnerElo, newLoserElo } = isFree
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

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
    } catch (e) { console.error('BlockBlast settle:', e.message); }
  }
  let winnerStreak = 0;
  let isFirstWin = false;
  if (supabase && !isFree && !winner.isBot) {
    try { await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
    try {
      // Human won: increment their streak, reset loser streak if loser is human
      ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, loser.isBot ? null : loser.userId));
    } catch { /* streak columns may not exist yet */ }
  } else if (supabase && !isFree && winner.isBot && !loser.isBot) {
    // Bot won a paid game: reset human loser's streak
    try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId); } catch {}
  }
  if (supabase && !isFree && !loser.isBot) {
    try { await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
  }
  if (supabase) {
    if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'blockBlast', winnerScore);
    if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'blockBlast', loserScore);
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'blockBlast',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[blockBlastEngine] matches insert:', e.message); }
  }
  // Credit rakeback for both players (skip bots — filter(Boolean) handles null)
  if (supabase && room.entryFee > 0) {
    const prizePool = room.entryFee * 2;
    const p1Id = winner.isBot ? null : winner.userId;
    const p2Id = loser.isBot  ? null : loser.userId;
    await creditRakeback(supabase, p1Id, p2Id, prizePool, room.currency || 'coins');
  }

  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
  io.to(roomId).emit('block_blast_result', {
    isSolo: false,
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange,
    winnerScore, loserScore,
    currency: room.currency || 'coins',
    winnerStreak: winnerStreak ?? 0,
    isFirstWin: isFirstWin ?? false,
  });
}

module.exports = {
  createDirectBlockBlastRoom,
  addToBlockBlastQueue, removeFromBlockBlastQueue,
  getBlockBlastRoom, deleteBlockBlastRoom, getBlockBlastRoomBySocket,
  startBlockBlastCountdown, handleBlockBlastComplete, handleBlockBlastStuck,
};


