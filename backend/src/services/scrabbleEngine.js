const { v4: uuidv4 } = require('uuid');
const { isValidWord } = require('./wordValidator');
const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { updateHighscore } = require('./highscoreService');
const gameEvents = require('./gameEvents');

// ── Board constants ─────────────────────────────────────────────────────────
const SIZE = 6;

// Premium squares — key = "row,col"
// ★ = center (Double Word on first cover)
const PREMIUM = {
  '0,0': 'TW', '0,5': 'TW', '5,0': 'TW', '5,5': 'TW',
  '1,1': 'DW', '1,4': 'DW', '4,1': 'DW', '4,4': 'DW',
  '0,2': 'TL', '0,3': 'TL', '2,0': 'TL', '3,0': 'TL',
  '2,5': 'TL', '3,5': 'TL', '5,2': 'TL', '5,3': 'TL',
  '2,2': '★',
  '2,3': 'DL', '3,2': 'DL', '3,3': 'DL',
};

// Letter point values (standard Scrabble)
const LETTER_VALUES = {
  A:1, B:3, C:3, D:2, E:1, F:4, G:2, H:4, I:1, J:8, K:5, L:1, M:3,
  N:1, O:1, P:3, Q:10, R:1, S:1, T:1, U:1, V:4, W:4, X:8, Y:4, Z:10, '?':0,
};

// Tile bag scaled for 6×6 (~55 tiles, vowel-heavy for better gameplay)
const BAG_TEMPLATE = [
  // Vowels — increased counts for playability
  ...Array(6).fill('A'), ...Array(9).fill('E'), ...Array(6).fill('I'),
  ...Array(6).fill('O'), ...Array(4).fill('U'),
  // Common consonants
  ...Array(2).fill('B'), ...Array(2).fill('C'), ...Array(3).fill('D'),
  ...Array(2).fill('F'), ...Array(2).fill('G'), ...Array(2).fill('H'),
  ...Array(2).fill('K'), ...Array(3).fill('L'), ...Array(2).fill('M'),
  ...Array(4).fill('N'), ...Array(2).fill('P'), ...Array(4).fill('R'),
  ...Array(4).fill('S'), ...Array(4).fill('T'),
  // Less common
  Array(1).fill('J'),  Array(1).fill('Q'),  Array(1).fill('V'),
  Array(1).fill('W'),  Array(1).fill('X'),  Array(1).fill('Y'),
  Array(1).fill('Z'),
  // Blanks
  ...Array(2).fill('?'),
].flat();

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

// ── Room management ──────────────────────────────────────────────────────────
const rooms = new Map();
const queue = [];

function addToScrabbleQueue(player) {
  const idx = queue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opp = queue.splice(idx, 1)[0];
    const roomId = 'scrabble_' + uuidv4();
    rooms.set(roomId, _makeRoom(roomId, opp, player));
    return { roomId, p1: opp, p2: player };
  }
  queue.push(player);
  return null;
}

function removeFromScrabbleQueue(socketId) {
  const idx = queue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

function getScrabbleRoom(roomId) { return rooms.get(roomId); }
function deleteScrabbleRoom(roomId) { rooms.delete(roomId); }
function getScrabbleRoomBySocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectScrabbleRoom(p1, p2) {
  const roomId = 'scrabble_' + uuidv4();
  rooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const bag = shuffle(BAG_TEMPLATE);
  const hand1 = bag.splice(0, 7);
  const hand2 = bag.splice(0, 7);
  return {
    roomId,
    players: [p1, p2],
    state: 'waiting',
    entryFee: p1.entryFee,
    currency: p1.currency || 'coins',
    board: emptyBoard(),
    bag,
    hands: { [p1.socketId]: hand1, [p2.socketId]: hand2 },
    scores: { [p1.socketId]: 0, [p2.socketId]: 0 },
    turnIndex: 0,
    passCount: 0,
    usedPremiums: new Set(),
    turnTimer: null,
    rematches: {},
    firstWord: true,
  };
}

// ── Word finding ─────────────────────────────────────────────────────────────
function findWords(board, placements) {
  // Build temp board
  const tmp = board.map(r => r.map(c => c ? { ...c } : null));
  const newSet = new Set(placements.map(p => `${p.row},${p.col}`));
  for (const p of placements) {
    tmp[p.row][p.col] = { letter: p.displayLetter || p.letter, isBlank: !!p.isBlank };
  }

  // Read word in direction from start
  function readFrom(r, c, dr, dc) {
    // Find true start
    let sr = r, sc = c;
    while (sr - dr >= 0 && sr - dr < SIZE && sc - dc >= 0 && sc - dc < SIZE && tmp[sr - dr][sc - dc]) {
      sr -= dr; sc -= dc;
    }
    const cells = [];
    let cr = sr, cc = sc;
    while (cr >= 0 && cr < SIZE && cc >= 0 && cc < SIZE && tmp[cr][cc]) {
      cells.push({ row: cr, col: cc, letter: tmp[cr][cc].letter, isNew: newSet.has(`${cr},${cc}`) });
      cr += dr; cc += dc;
    }
    if (cells.length < 2 || !cells.some(c => c.isNew)) return null;
    return { word: cells.map(c => c.letter).join(''), cells };
  }

  const rows = [...new Set(placements.map(p => p.row))];
  const cols = [...new Set(placements.map(p => p.col))];
  const words = [];

  if (rows.length === 1) {
    const w = readFrom(rows[0], placements[0].col, 0, 1);
    if (w) words.push(w);
    for (const p of placements) { const w = readFrom(p.row, p.col, 1, 0); if (w) words.push(w); }
  } else if (cols.length === 1) {
    const w = readFrom(placements[0].row, cols[0], 1, 0);
    if (w) words.push(w);
    for (const p of placements) { const w = readFrom(p.row, p.col, 0, 1); if (w) words.push(w); }
  } else {
    return null; // not a valid line
  }

  return words;
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function scoreWords(words, usedPremiums) {
  let total = 0;
  const newUsed = new Set(usedPremiums);

  for (const { cells } of words) {
    let wordScore = 0, wordMult = 1;
    for (const cell of cells) {
      const key = `${cell.row},${cell.col}`;
      const prem = PREMIUM[key];
      let lv = LETTER_VALUES[cell.letter.toUpperCase()] || 0;
      if (cell.isNew && prem && !usedPremiums.has(key)) {
        newUsed.add(key);
        if (prem === 'DL')              lv *= 2;
        else if (prem === 'TL')         lv *= 3;
        else if (prem === 'DW' || prem === '★') wordMult *= 2;
        else if (prem === 'TW')         wordMult *= 3;
      }
      wordScore += lv;
    }
    total += wordScore * wordMult;
  }
  return { score: total, newUsedPremiums: newUsed };
}

// ── Validation ────────────────────────────────────────────────────────────────
function validatePlacement(room, placements, socketId) {
  if (room.players[room.turnIndex].socketId !== socketId)
    return { ok: false, error: 'Not your turn' };
  if (!placements || placements.length === 0)
    return { ok: false, error: 'No tiles placed' };

  for (const p of placements) {
    if (p.row < 0 || p.row >= SIZE || p.col < 0 || p.col >= SIZE)
      return { ok: false, error: 'Out of bounds' };
    if (room.board[p.row][p.col])
      return { ok: false, error: `(${p.row},${p.col}) is already occupied` };
  }

  const rows = [...new Set(placements.map(p => p.row))];
  const cols = [...new Set(placements.map(p => p.col))];
  if (rows.length > 1 && cols.length > 1)
    return { ok: false, error: 'Tiles must all be in the same row or column' };

  // Gap check
  if (rows.length === 1) {
    const row = rows[0];
    const cs = placements.map(p => p.col).sort((a, b) => a - b);
    for (let c = cs[0]; c <= cs[cs.length - 1]; c++) {
      if (!room.board[row][c] && !placements.find(p => p.row === row && p.col === c))
        return { ok: false, error: 'Tiles must be contiguous (no gaps)' };
    }
  } else {
    const col = cols[0];
    const rs = placements.map(p => p.row).sort((a, b) => a - b);
    for (let r = rs[0]; r <= rs[rs.length - 1]; r++) {
      if (!room.board[r][col] && !placements.find(p => p.row === r && p.col === col))
        return { ok: false, error: 'Tiles must be contiguous (no gaps)' };
    }
  }

  // First word: must cover at least one tile in the middle area (rows 1–4, cols 1–4)
  if (room.firstWord) {
    const coversMiddle = placements.some(p => p.row >= 1 && p.row <= 4 && p.col >= 1 && p.col <= 4);
    if (!coversMiddle) return { ok: false, error: 'First word must be placed in the middle area of the board' };
  } else {
    // Must connect to existing tiles
    let connected = false;
    outer: for (const p of placements) {
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = p.row + dr, nc = p.col + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && room.board[nr][nc] && !placements.find(x => x.row === nr && x.col === nc)) {
          connected = true; break outer;
        }
      }
    }
    if (!connected) return { ok: false, error: 'Word must connect to existing tiles' };
  }

  // Player must hold these tiles
  const hand = [...room.hands[socketId]];
  for (const p of placements) {
    const tile = p.isBlank ? '?' : p.letter.toUpperCase();
    const idx = hand.indexOf(tile);
    if (idx === -1) return { ok: false, error: `You don't have tile: ${tile}` };
    hand.splice(idx, 1);
  }

  return { ok: true };
}

// ── Play word ─────────────────────────────────────────────────────────────────
function handleScrabblePlay(io, supabase, roomId, socketId, placements) {
  const room = getScrabbleRoom(roomId);
  if (!room || room.state !== 'active') return;

  const v = validatePlacement(room, placements, socketId);
  if (!v.ok) { _err(io, socketId, v.error); return; }

  const words = findWords(room.board, placements);
  if (!words || words.length === 0) { _err(io, socketId, 'No valid words formed'); return; }

  for (const { word } of words) {
    if (!isValidWord(word)) { _err(io, socketId, `"${word}" is not a valid word`); return; }
  }

  const { score, newUsedPremiums } = scoreWords(words, room.usedPremiums);
  room.usedPremiums = newUsedPremiums;
  const bingo = placements.length === 7;
  const total = score + (bingo ? 15 : 0);

  // Apply placements to board
  for (const p of placements) {
    room.board[p.row][p.col] = {
      letter: p.displayLetter || p.letter.toUpperCase(),
      isBlank: !!p.isBlank,
    };
  }
  room.firstWord = false;
  room.passCount = 0;

  // Update hand
  const hand = [...room.hands[socketId]];
  for (const p of placements) {
    const tile = p.isBlank ? '?' : p.letter.toUpperCase();
    const idx = hand.indexOf(tile); if (idx !== -1) hand.splice(idx, 1);
  }
  const draw = room.bag.splice(0, Math.min(7 - hand.length, room.bag.length));
  const newHand = [...hand, ...draw];
  room.hands[socketId] = newHand;
  room.scores[socketId] = (room.scores[socketId] || 0) + total;

  _clearTimer(room);
  room.turnIndex = 1 - room.turnIndex;

  // Broadcast
  io.to(roomId).emit('scrabble_word_played', {
    socketId,
    placements: placements.map(p => ({ row: p.row, col: p.col, letter: p.displayLetter || p.letter.toUpperCase(), isBlank: !!p.isBlank })),
    words: words.map(w => w.word),
    score: total,
    bingo,
    board: room.board,
    scores: room.scores,
    bagCount: room.bag.length,
    nextTurn: room.players[room.turnIndex].socketId,
  });
  const ps = io.sockets.sockets.get(socketId);
  if (ps) ps.emit('scrabble_new_tiles', { hand: newHand });

  io.to(roomId + '_spectators').emit('scrabble_spectator_board', { board: room.board, scores: room.scores });

  // End check
  if (room.bag.length === 0 && newHand.length === 0) {
    _endGame(io, supabase, roomId, 'tiles_out'); return;
  }
  const boardFull = room.board.every(row => row.every(cell => cell !== null));
  if (boardFull) {
    _endGame(io, supabase, roomId, 'board_full'); return;
  }
  _startTimer(io, supabase, roomId);
}

// ── Skip ─────────────────────────────────────────────────────────────────────
function handleScrabbleSkip(io, supabase, roomId, socketId) {
  const room = getScrabbleRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.players[room.turnIndex].socketId !== socketId) return;
  room.passCount++;
  _clearTimer(room);
  if (room.passCount >= 4) { _endGame(io, supabase, roomId, 'consecutive_passes'); return; }
  room.turnIndex = 1 - room.turnIndex;
  io.to(roomId).emit('scrabble_skipped', { socketId, passCount: room.passCount, nextTurn: room.players[room.turnIndex].socketId });
  _startTimer(io, supabase, roomId);
}

// ── Exchange ──────────────────────────────────────────────────────────────────
function handleScrabbleExchange(io, supabase, roomId, socketId, letters) {
  const room = getScrabbleRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.players[room.turnIndex].socketId !== socketId) return;
  if (room.bag.length < letters.length) { _err(io, socketId, 'Not enough tiles in bag'); return; }

  const hand = [...room.hands[socketId]];
  for (const l of letters) { const idx = hand.indexOf(l); if (idx !== -1) hand.splice(idx, 1); }
  room.bag = shuffle([...room.bag, ...letters]);
  const drawn = room.bag.splice(0, letters.length);
  room.hands[socketId] = [...hand, ...drawn];
  room.passCount++;
  _clearTimer(room);
  room.turnIndex = 1 - room.turnIndex;

  const ps = io.sockets.sockets.get(socketId);
  if (ps) ps.emit('scrabble_new_tiles', { hand: room.hands[socketId] });
  io.to(roomId).emit('scrabble_exchanged', {
    socketId, count: letters.length, bagCount: room.bag.length,
    nextTurn: room.players[room.turnIndex].socketId,
  });
  _startTimer(io, supabase, roomId);
}

// ── Start game ────────────────────────────────────────────────────────────────
function startScrabbleGame(io, supabase, roomId) {
  const room = getScrabbleRoom(roomId);
  if (!room) return;
  room.state = 'active';
  const [p1, p2] = room.players;

  io.to(roomId).emit('scrabble_start', {
    board: room.board,
    premium: PREMIUM,
    scores: room.scores,
    bagCount: room.bag.length,
    firstTurnSocketId: p1.socketId,
    players: [
      { socketId: p1.socketId, userId: p1.userId, username: p1.username },
      { socketId: p2.socketId, userId: p2.userId, username: p2.username },
    ],
  });

  // Send hands privately
  const s1 = io.sockets.sockets.get(p1.socketId);
  const s2 = io.sockets.sockets.get(p2.socketId);
  if (s1 && !p1.isBot) s1.emit('scrabble_your_hand', { hand: room.hands[p1.socketId] });
  if (s2 && !p2.isBot) s2.emit('scrabble_your_hand', { hand: room.hands[p2.socketId] });

  _startTimer(io, supabase, roomId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _err(io, socketId, error) {
  const s = io.sockets.sockets.get(socketId);
  if (s) s.emit('scrabble_error', { error });
}

function _clearTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function _startTimer(io, supabase, roomId) {
  const room = getScrabbleRoom(roomId);
  if (!room) return;
  const cur = room.players[room.turnIndex];
  io.to(roomId).emit('scrabble_turn', { socketId: cur.socketId, timeLimit: 60 });
  if (cur.isBot) {
    // Bot move — schedule instead of a hard timeout
    scheduleBotMove(io, supabase, roomId);
  } else {
    room.turnTimer = setTimeout(() => handleScrabbleSkip(io, supabase, roomId, cur.socketId), 62000);
  }
}

async function _endGame(io, supabase, roomId, reason) {
  const room = getScrabbleRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  _clearTimer(room);

  const [p1, p2] = room.players;

  // Deduct remaining hand tiles
  for (const p of [p1, p2]) {
    if (!p.isBot) {
      const penalty = (room.hands[p.socketId] || []).reduce((s, l) => s + (LETTER_VALUES[l.toUpperCase()] || 0), 0);
      room.scores[p.socketId] = Math.max(0, (room.scores[p.socketId] || 0) - penalty);
    }
  }

  const s1 = room.scores[p1.socketId] || 0;
  const s2 = room.scores[p2.socketId] || 0;
  const [winner, loser] = s1 >= s2 ? [p1, p2] : [p2, p1];
  const winnerScore = room.scores[winner.socketId] || 0;
  const loserScore  = room.scores[loser.socketId]  || 0;

  const fee = room.entryFee || 0;
  const currency = room.currency || 'coins';
  const isFree = fee === 0;
  const { newWinnerElo, newLoserElo } = isFree
    ? { newWinnerElo: winner.elo || 1000, newLoserElo: loser.elo || 1000 }
    : calculateNewRatings(winner.elo || 1000, loser.elo || 1000);
  let balanceChange = null;

  if (fee > 0 && supabase) {
    try {
      const hasBot = winner.isBot || loser.isBot;
      if (hasBot) {
        const humanId = winner.isBot ? loser.userId : winner.userId;
        const humanWon = !winner.isBot;
        balanceChange = await settleBotMatch(supabase, humanId, fee, currency, humanWon);
      } else {
        balanceChange = currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, fee)
          : await settleMatch(supabase, winner.userId, loser.userId, fee);
      }
    } catch (e) { console.error('[scrabble] settle error:', e.message); }
  }

  if (supabase) {
    if (!isFree) {
      if (!winner.isBot) {
        await applyEloUpdate(supabase, winner.userId, newWinnerElo);
        await supabase.rpc('increment_win', { uid: winner.userId }).catch(() => {});
        // Human won: increment their streak
        try { await updateStreaks(supabase, winner.userId, null); } catch {}
      }
      if (!loser.isBot) {
        await applyEloUpdate(supabase, loser.userId, newLoserElo);
        await supabase.rpc('increment_loss', { uid: loser.userId }).catch(() => {});
      }
    }
    // Always reset human loser's streak — any game, free or paid, vs bot or human
    if (!loser.isBot) {
      supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId).catch(() => {});
    }
    if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'wordVS', winnerScore).catch(() => {});
    if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'wordVS', loserScore).catch(() => {});
    if (!winner.isBot && !loser.isBot) {
      await supabase.from('matches').insert({
        player1_id: p1.userId, player2_id: p2.userId, winner_id: winner.userId,
        game_type: 'scrabble',
        entry_fee_c:         currency === 'coins'    ? fee : 0,
        entry_fee_diamonds:  currency === 'diamonds' ? fee : 0,
        prize_pool_c:        currency === 'coins'    ? fee * 2 : 0,
        prize_pool_diamonds: currency === 'diamonds' ? fee * 2 : 0,
        platform_fee_c:      currency === 'coins'    ? parseFloat((fee * 2 * 0.05).toFixed(4)) : 0,
      }).catch(() => {});
    }
  }

  gameEvents.emit('game_ended', { socketIds: [p1.socketId, p2.socketId] });
  io.to(roomId).emit('scrabble_result', {
    winnerId:      winner.userId,
    loserId:       loser.userId,
    winnerUsername: winner.username,
    loserUsername:  loser.username,
    winnerScore,
    loserScore,
    scores: { [p1.socketId]: s1, [p2.socketId]: s2 },
    newWinnerElo,
    newLoserElo,
    balanceChange,
    reason,
    currency,
    entryFee: fee || 0,
  });

  io.emit('active_game_ended', { id: roomId });
  deleteScrabbleRoom(roomId);
}

// ── Bot logic ─────────────────────────────────────────────────────────────────
function _canFormWord(word, hand) {
  const h = [...hand];
  let blanks = h.filter(l => l === '?').length;
  for (const ch of word.toUpperCase()) {
    const i = h.findIndex(l => l === ch);
    if (i >= 0) { h.splice(i, 1); }
    else if (blanks > 0) { blanks--; h.splice(h.indexOf('?'), 1); }
    else return false;
  }
  return true;
}

function _botPlacements(word, sr, sc, dir, board, hand) {
  const placements = [];
  const h = [...hand];
  for (let i = 0; i < word.length; i++) {
    const r = dir === 'H' ? sr : sr + i;
    const c = dir === 'H' ? sc + i : sc;
    if (r >= SIZE || c >= SIZE) return null;
    const ch = word[i].toUpperCase();
    if (board[r]?.[c]) {
      if (board[r][c].letter !== ch) return null;
    } else {
      const hi = h.indexOf(ch);
      if (hi >= 0) { h.splice(hi, 1); placements.push({ row: r, col: c, letter: ch, displayLetter: ch, isBlank: false }); }
      else {
        const bi = h.indexOf('?');
        if (bi >= 0) { h.splice(bi, 1); placements.push({ row: r, col: c, letter: ch, displayLetter: ch, isBlank: true }); }
        else return null;
      }
    }
  }
  return placements.length > 0 ? placements : null;
}

async function scheduleBotMove(io, supabase, roomId) {
  const room = getScrabbleRoom(roomId);
  if (!room || room.state !== 'active') return;
  const bot = room.players[room.turnIndex];
  if (!bot || !bot.isBot) return;

  // 1.5–3s thinking delay
  const delay = 1500 + Math.floor(Math.random() * 1500);
  await new Promise(r => setTimeout(r, delay));

  const fresh = getScrabbleRoom(roomId);
  if (!fresh || fresh.state !== 'active') return;
  if (fresh.players[fresh.turnIndex].socketId !== bot.socketId) return;

  const hand = fresh.hands[bot.socketId] || [];
  const { board, firstWord, bag } = fresh;

  const { loadWords } = require('./wordValidator');
  const allWords = loadWords();

  // Collect formable words (cap at 800 for perf)
  const candidates = [];
  for (const w of allWords) {
    if (w.length >= 2 && w.length <= 6 && _canFormWord(w, hand)) {
      candidates.push(w.toUpperCase());
      if (candidates.length >= 800) break;
    }
  }

  let bestScore = -1, bestPlacements = null;

  for (const word of candidates) {
    for (const dir of ['H', 'V']) {
      const maxR = dir === 'V' ? SIZE - word.length : SIZE;
      const maxC = dir === 'H' ? SIZE - word.length : SIZE;
      for (let r = 0; r < maxR; r++) {
        for (let c = 0; c < maxC; c++) {
          const placements = _botPlacements(word, r, c, dir, board, hand);
          if (!placements || placements.length === 0) continue;
          const v = validatePlacement(fresh, placements, bot.socketId);
          if (!v.ok) continue;
          const formed = findWords(board, placements);
          if (!formed) continue;
          let valid = true;
          for (const { word: w } of formed) { if (!isValidWord(w)) { valid = false; break; } }
          if (!valid) continue;
          const { score } = scoreWords(formed, fresh.usedPremiums);
          if (score > bestScore) { bestScore = score; bestPlacements = placements; }
        }
      }
    }
  }

  if (bestPlacements) {
    handleScrabblePlay(io, supabase, roomId, bot.socketId, bestPlacements);
  } else if (bag.length >= 2 && hand.length > 0) {
    // Exchange the least-valuable tile
    const sorted = [...hand].sort((a, b) => (LETTER_VALUES[a] || 0) - (LETTER_VALUES[b] || 0));
    handleScrabbleExchange(io, supabase, roomId, bot.socketId, [sorted[0]]);
  } else {
    handleScrabbleSkip(io, supabase, roomId, bot.socketId);
  }
}

module.exports = {
  addToScrabbleQueue, removeFromScrabbleQueue,
  getScrabbleRoom, deleteScrabbleRoom, getScrabbleRoomBySocket,
  createDirectScrabbleRoom,
  startScrabbleGame, scheduleBotMove,
  handleScrabblePlay, handleScrabbleSkip, handleScrabbleExchange,
  PREMIUM, LETTER_VALUES, SIZE,
};
