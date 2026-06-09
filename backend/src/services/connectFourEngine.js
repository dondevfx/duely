const { calculateNewRatings, updateStreaks } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { v4: uuidv4 } = require('uuid');
const { creditRakeback } = require('./rakebackService');

const ROWS = 6;
const COLS = 7;

const c4Rooms = new Map();
const c4Queue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function dropPiece(board, col, piece) {
  for (let row = ROWS - 1; row >= 0; row--) {
    if (board[row][col] === 0) {
      board[row][col] = piece;
      return row;
    }
  }
  return -1; // column full
}

function checkWin(board, row, col) {
  const piece = board[row][col];
  if (!piece) return false;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let d = 1; d <= 3; d++) {
      const r = row + dr * d, c = col + dc * d;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== piece) break;
      count++;
    }
    for (let d = 1; d <= 3; d++) {
      const r = row - dr * d, c = col - dc * d;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== piece) break;
      count++;
    }
    if (count >= 4) return true;
  }
  return false;
}

function isBoardFull(board) {
  return board[0].every(cell => cell !== 0);
}

// Simple bot: win > block > center preference > random
function chooseBotColumn(board, botPiece) {
  const opponentPiece = botPiece === 1 ? 2 : 1;

  // Try to win
  for (let col = 0; col < COLS; col++) {
    const copy = board.map(r => [...r]);
    const row = dropPiece(copy, col, botPiece);
    if (row !== -1 && checkWin(copy, row, col)) return col;
  }

  // Block opponent win
  for (let col = 0; col < COLS; col++) {
    const copy = board.map(r => [...r]);
    const row = dropPiece(copy, col, opponentPiece);
    if (row !== -1 && checkWin(copy, row, col)) return col;
  }

  // Prefer center columns
  const centerOrder = [3, 2, 4, 1, 5, 0, 6];
  const available = centerOrder.filter(col => board[0][col] === 0);
  if (available.length === 0) return -1;
  return available[Math.floor(Math.random() * Math.min(3, available.length))];
}

// ── Queue ─────────────────────────────────────────────────────────────────────
function addToC4Queue(player) {
  const idx = c4Queue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = c4Queue.splice(idx, 1)[0];
    const roomId = 'c4_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    c4Rooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  c4Queue.push(player);
  return null;
}

function removeFromC4Queue(socketId) {
  const idx = c4Queue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) c4Queue.splice(idx, 1);
}

function getC4Room(roomId)           { return c4Rooms.get(roomId); }
function deleteC4Room(roomId)        { c4Rooms.delete(roomId); }
function getC4RoomBySocket(socketId) {
  for (const [roomId, room] of c4Rooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectC4Room(p1, p2) {
  const roomId = 'c4_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  c4Rooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId,
    players:    [p1, p2],
    state:      'countdown',
    board:      emptyBoard(),
    turnIndex:  0,
    entryFee:   p1.entryFee,
    currency:   p1.currency,
    rematches:  {},
    turnTimer:  null,
    consecutiveMisses: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

// ── Turn timer ────────────────────────────────────────────────────────────────
function _clearC4Timer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function startC4Timer(io, supabase, roomId) {
  const room = getC4Room(roomId);
  if (!room || room.state !== 'active') return;
  _clearC4Timer(room);
  const current = room.players[room.turnIndex];
  if (current.isBot) return;

  const endsAt = Date.now() + 60000;
  io.to(roomId).emit('c4_timer', { endsAt, currentTurn: current.userId });

  room.turnTimer = setTimeout(async () => {
    room.turnTimer = null;
    const r = getC4Room(roomId);
    if (!r || r.state !== 'active') return;
    if (r.players[r.turnIndex].userId !== current.userId) return;

    r.consecutiveMisses = r.consecutiveMisses || {};
    r.consecutiveMisses[current.userId] = (r.consecutiveMisses[current.userId] || 0) + 1;
    const opp = r.players.find(p => p.userId !== current.userId);

    if (r.consecutiveMisses[current.userId] >= 3) {
      await resolveC4Match(io, supabase, roomId, opp, current, false);
      return;
    }

    r.turnIndex = 1 - r.turnIndex;
    const next = r.players[r.turnIndex];
    io.to(roomId).emit('c4_update', {
      board: r.board, lastMove: null, turn: next.userId, skipped: current.userId,
    });
    if (next.isBot) _scheduleBotMove(io, supabase, roomId);
    else startC4Timer(io, supabase, roomId);
  }, 60000);
}

function clearC4TimerForRoom(roomId) {
  const room = getC4Room(roomId);
  if (room) _clearC4Timer(room);
}

// ── Game flow ─────────────────────────────────────────────────────────────────
async function startC4Countdown(io, supabase, roomId) {
  const room = getC4Room(roomId);
  if (!room) return;
  room.state = 'countdown';

  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('c4_countdown', { count: i });
    await sleep(1000);
  }

  const current = getC4Room(roomId);
  if (!current) return;
  current.state = 'active';

  io.to(roomId).emit('c4_start', {
    board:       current.board,
    turn:        current.players[current.turnIndex].userId,
    piece:       { [current.players[0].userId]: 1, [current.players[1].userId]: 2 },
  });

  const firstPlayer = current.players[current.turnIndex];
  if (firstPlayer.isBot) {
    _scheduleBotMove(io, supabase, roomId);
  } else {
    startC4Timer(io, supabase, roomId);
  }
}

async function handleC4Drop(io, supabase, roomId, socketId, col) {
  const room = getC4Room(roomId);
  if (!room || room.state !== 'active') return;

  const playerIndex = room.players.findIndex(p => p.socketId === socketId);
  if (playerIndex === -1) return;
  if (playerIndex !== room.turnIndex) return;

  _clearC4Timer(room);
  room.consecutiveMisses = room.consecutiveMisses || {};

  const piece = playerIndex + 1;
  const row = dropPiece(room.board, col, piece);
  if (row === -1) return;

  const won  = checkWin(room.board, row, col);
  const draw = !won && isBoardFull(room.board);

  if (won) {
    const winner = room.players[playerIndex];
    const loser  = room.players[1 - playerIndex];
    io.to(roomId).emit('c4_update', { board: room.board, lastMove: { row, col, piece }, turn: null });
    await resolveC4Match(io, supabase, roomId, winner, loser, false);
  } else if (draw) {
    io.to(roomId).emit('c4_update', { board: room.board, lastMove: { row, col, piece }, turn: null });
    await resolveC4Match(io, supabase, roomId, null, null, true);
  } else {
    room.turnIndex = 1 - room.turnIndex;
    const nextPlayer = room.players[room.turnIndex];
    io.to(roomId).emit('c4_update', {
      board:    room.board,
      lastMove: { row, col, piece },
      turn:     nextPlayer.userId,
    });

    if (nextPlayer.isBot) {
      _scheduleBotMove(io, supabase, roomId);
    } else {
      startC4Timer(io, supabase, roomId);
    }
  }
}

function _scheduleBotMove(io, supabase, roomId) {
  const delay = 600 + Math.random() * 700; // 600–1300ms
  setTimeout(async () => {
    const room = getC4Room(roomId);
    if (!room || room.state !== 'active') return;
    const bot = room.players[room.turnIndex];
    if (!bot.isBot) return;
    const botPiece = room.turnIndex + 1;
    const col = chooseBotColumn(room.board, botPiece);
    if (col === -1) return;
    await handleC4Drop(io, supabase, roomId, bot.socketId, col);
  }, delay);
}

async function resolveC4Match(io, supabase, roomId, winner, loser, isDraw) {
  const room = getC4Room(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  _clearC4Timer(room);

  let newWinnerElo = winner?.elo;
  let newLoserElo  = loser?.elo;
  let balanceChange = null;

  if (!isDraw && winner && loser) {
    const ratings = calculateNewRatings(winner.elo, loser.elo);
    newWinnerElo = ratings.newWinnerElo;
    newLoserElo  = ratings.newLoserElo;

    if (supabase && room.entryFee > 0) {
      try {
        const _hasBot = winner.isBot || loser.isBot;
        if (_hasBot) {
          const _humanId = winner.isBot ? loser.userId : winner.userId;
          const _humanWon = !winner.isBot;
          balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', _humanWon);
        } else {
          if (room.currency === 'diamonds') {
            balanceChange = await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee);
          } else {
            balanceChange = await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
          }
        }
      } catch (err) { console.error('C4 settlement error:', err.message); }
    }

    let winnerStreak = 0;
    let isFirstWin = false;
    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[connectFourEngine] RPC failed:', e.message); }
      try {
        ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, loser.isBot ? null : loser.userId));
      } catch { /* streak columns may not exist yet */ }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[connectFourEngine] RPC failed:', e.message); }
    }
    if (supabase && !isDraw) {
      try {
        await supabase.from('matches').insert({
          player1_id: winner?.isBot ? null : winner?.userId, player2_id: loser?.isBot ? null : loser?.userId,
          winner_id: winner?.isBot ? null : winner?.userId, game_type: 'connectFour',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[connectFourEngine] matches insert:', e.message); }
    }

    // Credit rakeback for both players (skip bots — filter(Boolean) handles null)
    if (supabase && room.entryFee > 0) {
      const prizePool = room.entryFee * 2;
      const p1Id = winner?.isBot ? null : winner?.userId;
      const p2Id = loser?.isBot  ? null : loser?.userId;
      await creditRakeback(supabase, p1Id, p2Id, prizePool, room.currency || 'coins');
    }

    io.emit('active_game_ended', { id: roomId });
    io.to(roomId).emit('c4_result', {
      isDraw,
      winnerId:       winner?.userId ?? null,
      loserId:        loser?.userId ?? null,
      winnerUsername: winner?.username ?? null,
      loserUsername:  loser?.username ?? null,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      currency:       room.currency || 'coins',
      winnerStreak: winnerStreak ?? 0,
      isFirstWin: isFirstWin ?? false,
    });
    return;
  }

  io.emit('active_game_ended', { id: roomId });
  io.to(roomId).emit('c4_result', {
    isDraw,
    winnerId:       winner?.userId ?? null,
    loserId:        loser?.userId ?? null,
    winnerUsername: winner?.username ?? null,
    loserUsername:  loser?.username ?? null,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    currency:       room.currency || 'coins',
    winnerStreak: 0,
    isFirstWin: false,
  });
}

module.exports = {
  createDirectC4Room,
  addToC4Queue, removeFromC4Queue,
  getC4Room, deleteC4Room, getC4RoomBySocket,
  startC4Countdown, handleC4Drop, resolveC4Match,
  emptyBoard,
  startC4Timer, clearC4TimerForRoom,
};

