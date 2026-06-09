const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');

const unoRooms = new Map();
const unoQueue  = [];
const botTimers = new Map();

const COLORS = ['red', 'green', 'blue', 'yellow'];

// ─── Deck ─────────────────────────────────────────────────────────────────────

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: '0' });
    for (const v of ['1','2','3','4','5','6','7','8','9','skip','reverse','draw2']) {
      deck.push({ color, value: v });
      deck.push({ color, value: v });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild' });
    deck.push({ color: 'wild', value: 'wild4' });
  }
  // Surge: wild + draw 2 (2 per deck)
  for (let i = 0; i < 2; i++) {
    deck.push({ color: 'wild', value: 'surge' });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealHands(deck, ids) {
  const hands = {};
  for (const id of ids) hands[id] = [];
  for (let i = 0; i < 7; i++) for (const id of ids) hands[id].push(deck.pop());
  return hands;
}

// ─── Room ─────────────────────────────────────────────────────────────────────

function makeRoom(roomId, p1, p2) {
  const deck = createDeck();
  const hands = dealHands(deck, [p1.userId, p2.userId]);

  // First discard must not be a wild card
  let topCard;
  while (true) {
    topCard = deck.pop();
    if (topCard.color !== 'wild') break;
    deck.unshift(topCard);
  }

  return {
    roomId,
    players: [p1, p2],
    state: 'active',
    entryFee: p1.entryFee,
    currency: p1.currency,
    rematches: {},
    deck,
    discard: [topCard],
    hands,
    currentTurn: p1.userId,
    currentColor: topCard.color,
    drawnThisTurn: false,
    turnTimer: null,
    consecutiveMisses: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

// ─── Queue ────────────────────────────────────────────────────────────────────

function addToUnoQueue(player) {
  const idx = unoQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = unoQueue.splice(idx, 1)[0];
    const roomId = 'uno_' + uuidv4();
    const room = makeRoom(roomId, opponent, player);
    unoRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player, room };
  }
  unoQueue.push(player);
  return null;
}

function removeFromUnoQueue(socketId) {
  const idx = unoQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) unoQueue.splice(idx, 1);
}

// ─── Room helpers ─────────────────────────────────────────────────────────────

function getUnoRoom(roomId)    { return unoRooms.get(roomId); }
function deleteUnoRoom(roomId) { unoRooms.delete(roomId); }

function getUnoRoomBySocket(socketId) {
  for (const [roomId, room] of unoRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectUnoRoom(p1, p2) {
  const roomId = 'uno_' + uuidv4();
  const room = makeRoom(roomId, p1, p2);
  unoRooms.set(roomId, room);
  return { roomId, room };
}

// ─── Game logic ───────────────────────────────────────────────────────────────

function isPlayable(card, topCard, currentColor) {
  if (card.value === 'wild' || card.value === 'wild4' || card.value === 'surge') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function opponent(room, userId) {
  return room.players.find(p => p.userId !== userId);
}

function drawCards(room, userId, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      const top = room.discard.pop();
      room.deck = shuffle(room.discard);
      room.discard = [top];
    }
    if (room.deck.length > 0) drawn.push(room.deck.pop());
  }
  room.hands[userId].push(...drawn);
  return drawn;
}

function stateFor(room, userId) {
  const opp = opponent(room, userId);
  return {
    myHand: room.hands[userId],
    topCard: room.discard[room.discard.length - 1],
    currentColor: room.currentColor,
    currentTurn: room.currentTurn,
    opponentCardCount: opp ? room.hands[opp.userId].length : 0,
    deckCount: room.deck.length,
    drawnThisTurn: room.currentTurn === userId ? room.drawnThisTurn : false,
  };
}

function broadcastState(io, room, lastAction) {
  for (const p of room.players) {
    if (p.isBot) continue;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('uno_state_update', { ...stateFor(room, p.userId), lastAction });
  }
}

// Returns { error } | { win, winnerUserId, card } | { card, skipOpponent, drawCount }
function processPlay(room, userId, cardIndex, chosenColor) {
  const hand = room.hands[userId];
  if (!hand || cardIndex < 0 || cardIndex >= hand.length) return { error: 'invalid_card' };

  const card = hand[cardIndex];
  const top  = room.discard[room.discard.length - 1];
  if (!isPlayable(card, top, room.currentColor)) return { error: 'not_playable' };

  hand.splice(cardIndex, 1);
  room.discard.push(card);
  room.drawnThisTurn = false;

  room.currentColor = (card.value === 'wild' || card.value === 'wild4' || card.value === 'surge')
    ? (COLORS.includes(chosenColor) ? chosenColor : COLORS[0])
    : card.color;

  if (hand.length === 0) return { win: true, winnerUserId: userId, card };

  const opp = opponent(room, userId);
  let skipOpp = false, drawCount = 0;
  if (card.value === 'skip' || card.value === 'reverse') { skipOpp = true; }
  else if (card.value === 'draw2')  { drawCount = 2; skipOpp = true; }
  else if (card.value === 'wild4')  { drawCount = 4; skipOpp = true; }
  else if (card.value === 'surge')  { drawCount = 2; skipOpp = true; }

  if (drawCount > 0 && opp) drawCards(room, opp.userId, drawCount);
  if (!skipOpp && opp) { room.currentTurn = opp.userId; room.drawnThisTurn = false; }

  return { card, skipOpp, drawCount };
}

function processDraw(room, userId) {
  if (room.drawnThisTurn) return { error: 'already_drew' };
  const drawn = drawCards(room, userId, 1);
  if (!drawn.length) return { error: 'empty_deck' };
  room.drawnThisTurn = true;
  const top = room.discard[room.discard.length - 1];
  return { card: drawn[0], canPlay: isPlayable(drawn[0], top, room.currentColor) };
}

function processPass(room, userId) {
  const opp = opponent(room, userId);
  if (opp) { room.currentTurn = opp.userId; room.drawnThisTurn = false; }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

function botPickCard(room, botId) {
  const hand = room.hands[botId];
  const top  = room.discard[room.discard.length - 1];
  const playable = hand
    .map((card, i) => ({ card, i }))
    .filter(({ card }) => isPlayable(card, top, room.currentColor));
  if (!playable.length) return null;
  // Prefer actions over numbers, wilds/surge last
  const score = v => (v === 'wild' || v === 'wild4' || v === 'surge') ? 2 : (v === 'skip' || v === 'reverse' || v === 'draw2') ? 0 : 1;
  playable.sort((a, b) => score(a.card.value) - score(b.card.value));
  return playable[0];
}

function scheduleBotTurn(io, supabase, roomId) {
  if (botTimers.has(roomId)) clearTimeout(botTimers.get(roomId));
  const t = setTimeout(async () => {
    botTimers.delete(roomId);
    const room = getUnoRoom(roomId);
    if (!room || room.state !== 'active') return;
    const bot = room.players.find(p => p.isBot);
    if (!bot || room.currentTurn !== bot.userId) return;

    const pick = botPickCard(room, bot.userId);
    if (pick) {
      const chosen = (pick.card.value === 'wild' || pick.card.value === 'wild4' || pick.card.value === 'surge')
        ? COLORS[Math.floor(Math.random() * 4)] : null;
      const res = processPlay(room, bot.userId, pick.i, chosen);
      if (res.error) return;
      if (res.win) {
        await _botWin(io, supabase, roomId);
        return;
      }
      broadcastState(io, room, { type: 'play', card: res.card, byBot: true, chosenColor: room.currentColor });
      if (room.currentTurn === bot.userId) scheduleBotTurn(io, supabase, roomId);
      else startUnoTimer(io, supabase, roomId);
    } else {
      const drawn = processDraw(room, bot.userId);
      if (drawn.error) { processPass(room, bot.userId); broadcastState(io, room, { type: 'draw_pass', byBot: true }); startUnoTimer(io, supabase, roomId); return; }
      if (drawn.canPlay) {
        const idx = room.hands[bot.userId].length - 1;
        const card = room.hands[bot.userId][idx];
        const chosen = (card.value === 'wild' || card.value === 'wild4' || card.value === 'surge')
          ? COLORS[Math.floor(Math.random() * 4)] : null;
        const res = processPlay(room, bot.userId, idx, chosen);
        if (res.win) { await _botWin(io, supabase, roomId); return; }
        broadcastState(io, room, { type: 'play', card: res.card, byBot: true, chosenColor: room.currentColor });
        if (room.currentTurn === bot.userId) scheduleBotTurn(io, supabase, roomId);
        else startUnoTimer(io, supabase, roomId);
      } else {
        processPass(room, bot.userId);
        broadcastState(io, room, { type: 'draw_pass', byBot: true });
        startUnoTimer(io, supabase, roomId);
      }
    }
  }, 900 + Math.random() * 800);
  botTimers.set(roomId, t);
}

async function _botWin(io, supabase, roomId) {
  const room = getUnoRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  _clearUnoTimer(room);
  if (botTimers.has(roomId)) { clearTimeout(botTimers.get(roomId)); botTimers.delete(roomId); }
  const human = room.players.find(p => !p.isBot);
  const newLoserElo = Math.max(100, (human?.elo ?? 1000) - 15);
  if (supabase && human) {
    try { await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', human.userId); } catch (e) { console.error('[unoEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_loss', { uid: human.userId }); } catch (e) { console.error('[unoEngine] RPC failed:', e.message); }
  }
  io.to(roomId).emit('uno_result', {
    winnerId: 'bot', loserId: human?.userId,
    winnerUsername: 'Uno Bot', loserUsername: human?.username,
    newWinnerElo: 1000, newLoserElo,
    balanceChange: null, currency: room.currency || 'coins', reason: 'empty_hand',
  });
}

// ─── Game over ────────────────────────────────────────────────────────────────

function _clearUnoTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function startUnoTimer(io, supabase, roomId) {
  const room = getUnoRoom(roomId);
  if (!room || room.state !== 'active') return;
  _clearUnoTimer(room);
  const currentPlayer = room.players.find(p => p.userId === room.currentTurn);
  if (!currentPlayer || currentPlayer.isBot) return;

  const endsAt = Date.now() + 20000;
  for (const p of room.players) {
    if (!p.isBot) {
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('uno_timer', { endsAt, currentTurn: room.currentTurn });
    }
  }

  room.turnTimer = setTimeout(async () => {
    room.turnTimer = null;
    const r = getUnoRoom(roomId);
    if (!r || r.state !== 'active') return;
    if (r.currentTurn !== currentPlayer.userId) return;

    if (!r.drawnThisTurn) processDraw(r, r.currentTurn);
    processPass(r, r.currentTurn);

    r.consecutiveMisses = r.consecutiveMisses || {};
    r.consecutiveMisses[currentPlayer.userId] = (r.consecutiveMisses[currentPlayer.userId] || 0) + 1;

    if (r.consecutiveMisses[currentPlayer.userId] >= 3) {
      const oppPlayer = r.players.find(p => p.userId !== currentPlayer.userId);
      await handleUnoGameOver(io, supabase, roomId, oppPlayer?.socketId, 'afk');
      return;
    }

    broadcastState(io, r, { type: 'timeout' });
    const bot = r.players.find(p => p.isBot);
    if (bot && r.currentTurn === bot.userId) scheduleBotTurn(io, supabase, roomId);
    else startUnoTimer(io, supabase, roomId);
  }, 20000);
}

function clearUnoTimerForRoom(roomId) {
  const room = getUnoRoom(roomId);
  if (room) _clearUnoTimer(room);
}

async function handleUnoGameOver(io, supabase, roomId, winnerSocketId, reason) {
  const room = getUnoRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  _clearUnoTimer(room);
  if (botTimers.has(roomId)) { clearTimeout(botTimers.get(roomId)); botTimers.delete(roomId); }

  if (winnerSocketId === null) {
    io.to(roomId).emit('uno_result', { draw: true, reason });
    return;
  }

  const winner = room.players.find(p => p.socketId === winnerSocketId);
  const loser  = room.players.find(p => p.socketId !== winnerSocketId);
  if (!winner || !loser) return;

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
    } catch (e) { console.error('Uno settle error:', e.message); }
  }

  if (supabase && !winner.isBot) {
    try { await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId); } catch (e) { console.error('[unoEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_win',  { uid: winner.userId }); } catch (e) { console.error('[unoEngine] RPC failed:', e.message); }
  }
  if (supabase && !loser.isBot) {
    try { await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId); } catch (e) { console.error('[unoEngine] RPC failed:', e.message); }
    try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch (e) { console.error('[unoEngine] RPC failed:', e.message); }
  }
  if (supabase) {
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId, game_type: 'uno',
        entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
      });
    } catch (e) { console.error('[unoEngine] matches insert:', e.message); }
  }

  io.to(roomId).emit('uno_result', {
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange,
    currency: room.currency || 'coins', reason,
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  addToUnoQueue, removeFromUnoQueue,
  getUnoRoom, deleteUnoRoom, getUnoRoomBySocket,
  createDirectUnoRoom,
  processPlay, processDraw, processPass,
  broadcastState, stateFor,
  scheduleBotTurn,
  handleUnoGameOver,
  startUnoTimer, clearUnoTimerForRoom,
};
