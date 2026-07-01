const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');

const ROUNDS_TO_WIN = 2;

const tttRooms = new Map();
const tttQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const WIN_CONDITIONS = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

function checkWin(board, mark) {
  return WIN_CONDITIONS.some(([a,b,c]) => board[a]===mark && board[b]===mark && board[c]===mark);
}

function addToTTTQueue(player) {
  const idx = tttQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opponent = tttQueue.splice(idx, 1)[0];
    const roomId = 'ttt_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    tttRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  tttQueue.push(player);
  return null;
}

function removeFromTTTQueue(socketId) {
  const idx = tttQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) tttQueue.splice(idx, 1);
}

function getTTTRoom(roomId)    { return tttRooms.get(roomId); }
function deleteTTTRoom(roomId) { tttRooms.delete(roomId); }
function getTTTRoomBySocket(socketId) {
  for (const [roomId, room] of tttRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectTTTRoom(p1, p2) {
  const roomId = 'ttt_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  tttRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId,
    players:   [p1, p2],
    board:     Array(9).fill(null),
    marks:     { [p1.socketId]: 'X', [p2.socketId]: 'O' },
    turnIndex: 0,
    state:     'active',
    entryFee:  p1.entryFee,
    currency:  p1.currency,
    rematches: {},
    round:     1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
    turnTimer: null,
    consecutiveMisses: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

function _clearTTTTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function startTTTTimer(io, supabase, roomId) {
  const room = getTTTRoom(roomId);
  if (!room || room.state !== 'active') return;
  _clearTTTTimer(room);
  const current = room.players[room.turnIndex];
  if (current.isBot) return;

  const endsAt = Date.now() + 20000;
  io.to(roomId).emit('ttt_timer', { endsAt, currentTurn: current.userId });

  room.turnTimer = setTimeout(async () => {
    room.turnTimer = null;
    const r = getTTTRoom(roomId);
    if (!r || r.state !== 'active') return;
    if (r.players[r.turnIndex].userId !== current.userId) return;

    // Skip turn
    r.consecutiveMisses = r.consecutiveMisses || {};
    r.consecutiveMisses[current.userId] = (r.consecutiveMisses[current.userId] || 0) + 1;
    const opp = r.players.find(p => p.userId !== current.userId);

    if (r.consecutiveMisses[current.userId] >= 3) {
      await _resolveRound(io, supabase, roomId, opp?.socketId, 'win');
      return;
    }

    r.turnIndex = 1 - r.turnIndex;
    const next = r.players[r.turnIndex];
    io.to(roomId).emit('ttt_move', {
      cell: null, mark: null, board: r.board,
      turnUserId: next.userId, skipped: current.userId,
    });
    if (next.isBot) _scheduleBotMove(io, supabase, roomId, next.socketId);
    else startTTTTimer(io, supabase, roomId);
  }, 20000);
}

function clearTTTTimerForRoom(roomId) {
  const room = getTTTRoom(roomId);
  if (room) _clearTTTTimer(room);
}

async function startTTTRound(io, supabase, roomId) {
  const room = getTTTRoom(roomId);
  if (!room) return;
  _clearTTTTimer(room);
  room.board     = Array(9).fill(null);
  room.turnIndex = (room.round - 1) % 2;
  room.state     = 'active';
  // Reset per-round miss counters so misses don't accumulate across rounds
  room.consecutiveMisses = { [room.players[0].userId]: 0, [room.players[1].userId]: 0 };

  io.to(roomId).emit('ttt_round_start', {
    round:      room.round,
    board:      room.board,
    turnUserId: room.players[room.turnIndex].userId,
    marks:      Object.fromEntries(room.players.map(p => [p.userId, room.marks[p.socketId]])),
  });

  const first = room.players[room.turnIndex];
  if (first.isBot) _scheduleBotMove(io, supabase, roomId, first.socketId);
  else startTTTTimer(io, supabase, roomId);
}

function handleTTTMove(io, supabase, roomId, socketId, cellIndex) {
  const room = getTTTRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.players[room.turnIndex].socketId !== socketId) return;
  if (cellIndex < 0 || cellIndex > 8) return;
  if (room.board[cellIndex] !== null) return;

  _clearTTTTimer(room);
  room.consecutiveMisses = room.consecutiveMisses || {};

  const mark = room.marks[socketId];
  room.board[cellIndex] = mark;

  if (checkWin(room.board, mark)) {
    _resolveRound(io, supabase, roomId, socketId, 'win');
    return;
  }

  if (room.board.every(c => c !== null)) {
    _resolveRound(io, supabase, roomId, socketId, 'draw');
    return;
  }

  room.turnIndex = 1 - room.turnIndex;
  const next = room.players[room.turnIndex];
  io.to(roomId).emit('ttt_move', {
    cell:       cellIndex,
    mark,
    board:      room.board,
    turnUserId: next.userId,
  });

  if (next.isBot) _scheduleBotMove(io, supabase, roomId, next.socketId);
  else startTTTTimer(io, supabase, roomId);
}

async function _resolveRound(io, supabase, roomId, winnerSocketId, outcome) {
  const room = getTTTRoom(roomId);
  if (!room || room.state !== 'active') return;
  _clearTTTTimer(room);
  room.state = 'between_rounds';

  if (outcome === 'draw') {
    io.to(roomId).emit('ttt_round_draw', { board: room.board, round: room.round });
    await sleep(2500);
    const r = getTTTRoom(roomId);
    if (r && r.state === 'between_rounds') await startTTTRound(io, supabase, roomId);
    return;
  }

  const winner = room.players.find(p => p.socketId === winnerSocketId);
  const loser  = room.players.find(p => p.socketId !== winnerSocketId);

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
      } catch (e) { console.error('TTT settle error:', e.message); }
    }

    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[ticTacToeEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[ticTacToeEngine] RPC failed:', e.message); }
    }
    if (supabase) {
      try {
        await supabase.from('matches').insert({
          player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
          winner_id: winner.isBot ? null : winner.userId, game_type: 'tictactoe',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[ticTacToeEngine] matches insert:', e.message); }
    }

    io.to(roomId).emit('ttt_result', {
      board:          room.board,
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
    room.round++;
    io.to(roomId).emit('ttt_round_result', {
      board:         room.board,
      round:         room.round - 1,
      roundWinnerId: winner.userId,
      scores,
    });
    await sleep(2500);
    const r = getTTTRoom(roomId);
    if (r && r.state === 'between_rounds') await startTTTRound(io, supabase, roomId);
  }
}

function _scheduleBotMove(io, supabase, roomId, botSocketId) {
  setTimeout(() => {
    const room = getTTTRoom(roomId);
    if (!room || room.state !== 'active') return;
    if (room.players[room.turnIndex].socketId !== botSocketId) return;

    const mark    = room.marks[botSocketId];
    const oppMark = mark === 'X' ? 'O' : 'X';
    const empty   = room.board.map((v,i) => v===null ? i : -1).filter(i => i !== -1);
    if (!empty.length) return;

    let move = _findWinMove(room.board, mark);
    if (move === -1) move = _findWinMove(room.board, oppMark);
    if (move === -1) {
      // Prefer center, then corners
      const pref = [4, 0, 2, 6, 8, 1, 3, 5, 7];
      move = pref.find(i => empty.includes(i)) ?? empty[0];
    }

    handleTTTMove(io, supabase, roomId, botSocketId, move);
  }, 500 + Math.random() * 700);
}

function _findWinMove(board, mark) {
  for (const [a,b,c] of WIN_CONDITIONS) {
    const cells = [a,b,c];
    const vals  = cells.map(i => board[i]);
    if (vals.filter(v => v===mark).length === 2 && vals.includes(null)) {
      return cells[vals.indexOf(null)];
    }
  }
  return -1;
}

module.exports = {
  addToTTTQueue, removeFromTTTQueue,
  getTTTRoom, deleteTTTRoom, getTTTRoomBySocket,
  createDirectTTTRoom,
  startTTTRound, handleTTTMove,
  startTTTTimer, clearTTTTimerForRoom,
};
