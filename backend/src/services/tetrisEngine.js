const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, updateStreaks } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch, settleDrawMatch, settleDrawMatchDiamonds } = require('./walletService');
const { updateHighscore } = require('./highscoreService');
const MAX_LINES = 20000; // sanity cap on lines cleared
const { creditRakeback } = require('./rakebackService');

const tetrisRooms = new Map();
const tetrisQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToTetrisQueue(player) {
  const idx = tetrisQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = tetrisQueue.splice(idx, 1)[0];
    const roomId = 'tetris_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    tetrisRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  tetrisQueue.push(player);
  return null;
}

function removeFromTetrisQueue(socketId) {
  const idx = tetrisQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) tetrisQueue.splice(idx, 1);
}

function getTetrisRoom(roomId)    { return tetrisRooms.get(roomId); }
function deleteTetrisRoom(roomId) { tetrisRooms.delete(roomId); }
function getTetrisRoomBySocket(socketId) {
  for (const [roomId, room] of tetrisRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectTetrisRoom(p1, p2) {
  const roomId = 'tetris_' + uuidv4();
  tetrisRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId, players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee, currency: p1.currency,
    rematches: {},
    lines: { [p1.socketId]: 0, [p2.socketId]: 0 },
    scores: { [p1.socketId]: 0, [p2.socketId]: 0 },
    toppedOut: {},
    botTimers: [],
  };
}

async function startTetrisMatch(io, roomId, supabase) {
  const room = getTetrisRoom(roomId);
  if (!room) return;
  room.state = 'countdown';
  const isSolo = room.players.some(p => p.isBot);

  for (let i = 3; i >= 1; i--) {
    if (!getTetrisRoom(roomId)) return;
    io.to(roomId).emit('tetris_countdown', { count: i });
    await sleep(1000);
  }

  const r = getTetrisRoom(roomId);
  if (!r || r.state !== 'countdown') return;
  r.state = 'active';
  r.supabase = supabase;
  r.isSolo = isSolo;
  r.lines = Object.fromEntries(r.players.map(p => [p.socketId, 0]));
  r.toppedOut = {};

  io.to(roomId).emit('tetris_round_start', { round: 1 });

  for (const p of r.players) {
    if (p.isBot) _simulateBotTetris(io, roomId, p.socketId);
  }
}

function _simulateBotTetris(io, roomId, botSocketId) {
  const room = getTetrisRoom(roomId);
  if (!room) return;

  // Real Tetris scoring table (same as frontend)
  const LINE_SCORES = [0, 100, 300, 500, 800];
  let botLines = 0;
  let botScore = 0;

  // Bot places a piece every 1100–2000ms (competitive casual pace).
  // Each placement has a 22% chance of clearing lines.
  // Line distribution: 52% single · 28% double · 13% triple · 7% tetris.
  // Expected output: ~1 200–1 800 pts/min → hard but beatable.
  function botTick() {
    const r = getTetrisRoom(roomId);
    if (!r || r.state !== 'active') return;

    if (Math.random() < 0.22) {
      const roll = Math.random();
      const lines = roll < 0.52 ? 1 : roll < 0.80 ? 2 : roll < 0.93 ? 3 : 4;
      const level = Math.floor(botLines / 10) + 1;
      botLines += lines;
      botScore += LINE_SCORES[lines] * level;
    }

    r.lines[botSocketId]  = botLines;
    r.scores[botSocketId] = botScore;

    const human = r.players.find(p => !p.isBot);
    if (human) io.to(human.socketId).emit('tetris_opponent_lines', { linesCleared: botLines });

    const delay = 1100 + Math.random() * 900;
    const t = setTimeout(botTick, delay);
    room.botTimers.push(t);
  }

  // Small startup delay so the bot doesn't instantly score
  const t = setTimeout(botTick, 1500 + Math.random() * 500);
  room.botTimers.push(t);
}

async function handleTetrisToppedOut(io, supabase, roomId, socketId, linesCleared, score) {
  const room = getTetrisRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.toppedOut[socketId] !== undefined) return;

  room.toppedOut[socketId] = true;
  room.lines[socketId] = linesCleared;
  if (score !== undefined) room.scores[socketId] = score;
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  io.to(roomId).emit('tetris_player_topped_out', { playerId: room.players.find(p => p.socketId === socketId)?.userId });

  // Solo mode: end immediately when human tops out
  const isHuman = !room.players.find(p => p.socketId === socketId)?.isBot;
  if (room.isSolo && isHuman) {
    await _resolveByScore(io, supabase || room.supabase, roomId);
    return;
  }

  // PvP: first player to top out loses — resolve immediately
  if (!room.isSolo) {
    await _resolveByScore(io, supabase || room.supabase, roomId);
    return;
  }
}

async function _resolveByScore(io, supabase, roomId) {
  const room = getTetrisRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  const [p1, p2] = room.players;
  // Compare by score (actual points); fall back to lines if scores not tracked
  const sc1 = (room.scores[p1.socketId] ?? 0) > 0 ? room.scores[p1.socketId] : room.lines[p1.socketId] ?? 0;
  const sc2 = (room.scores[p2.socketId] ?? 0) > 0 ? room.scores[p2.socketId] : room.lines[p2.socketId] ?? 0;
  const l1 = room.lines[p1.socketId] ?? 0;
  const l2 = room.lines[p2.socketId] ?? 0;

  const isDraw  = !room.isSolo && !p1.isBot && !p2.isBot && sc1 === sc2;
  const winner  = isDraw ? p1 : (sc1 >= sc2 ? p1 : p2);
  const loser   = isDraw ? p2 : (sc1 >= sc2 ? p2 : p1);
  const winnerScore = Math.max(sc1, sc2);
  const loserScore  = Math.min(sc1, sc2);
  const winnerLines = sc1 >= sc2 ? l1 : l2;
  const loserLines  = sc1 >= sc2 ? l2 : l1;

  const { newWinnerElo, newLoserElo } = isDraw
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo } // no ELO change on draw
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      if (isDraw) {
        balanceChange = room.currency === 'diamonds'
          ? await settleDrawMatchDiamonds(supabase, p1.userId, p2.userId, room.entryFee)
          : await settleDrawMatch(supabase, p1.userId, p2.userId, room.entryFee);
      } else if (winner.isBot || loser.isBot) {
        const _humanId = winner.isBot ? loser.userId : winner.userId;
        balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', !winner.isBot);
      } else {
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee)
          : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
      }
    } catch (e) { console.error('[tetrisEngine] settle error:', e.message); }
  }
  let winnerStreak = 0;
  let isFirstWin = false;
  if (!isDraw) {
    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[tetrisEngine] RPC failed:', e.message); }
      try {
        ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null));
      } catch { /* streak columns may not exist yet */ }
    }
    // Always reset human loser's streak — any game, free or paid, vs bot or human
    if (supabase && !loser.isBot) {
      supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId).then().catch(() => {});
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[tetrisEngine] RPC failed:', e.message); }
    }
  }

  if (supabase) {
    if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'tetris', winnerScore);
    if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'tetris', loserScore);
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'tetris',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[tetrisEngine] matches insert:', e.message); }
  }

  // Credit rakeback for both players (skip bots — filter(Boolean) handles null)
  if (supabase && room.entryFee > 0) {
    const prizePool = room.entryFee * 2;
    const p1Id = winner.isBot ? null : winner.userId;
    const p2Id = loser.isBot  ? null : loser.userId;
    await creditRakeback(supabase, p1Id, p2Id, prizePool, room.currency || 'coins');
  }

  io.emit('active_game_ended', { id: roomId });
  io.to(roomId).emit('tetris_result', {
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange, isDraw,
    currency: room.currency || 'coins',
    winnerScore, loserScore, winnerLines, loserLines,
    winnerStreak: winnerStreak ?? 0,
    isFirstWin: isFirstWin ?? false,
  });
}

function handleTetrisBoardUpdate(io, roomId, socketId, board) {
  const room = getTetrisRoom(roomId);
  if (!room || room.state !== 'active') return;
  // Store latest board so spectators can get current state on join
  if (!room.boards) room.boards = {};
  room.boards[socketId] = board;
  // Send to opponent
  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('tetris_opponent_board', { board });
  // Broadcast to spectators in the room
  const playerIdx = room.players.findIndex(p => p.socketId === socketId);
  io.to(roomId + '_spectators').emit('tetris_spectator_board', { playerIdx, board });
}

module.exports = {
  addToTetrisQueue, removeFromTetrisQueue,
  getTetrisRoom, deleteTetrisRoom, getTetrisRoomBySocket,
  createDirectTetrisRoom,
  startTetrisMatch, handleTetrisToppedOut, handleTetrisBoardUpdate,
};


