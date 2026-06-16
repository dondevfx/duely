const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch, settleDrawMatch, settleDrawMatchDiamonds, creditCoins, creditDiamonds } = require('./walletService');
const { creditRakeback } = require('./rakebackService');
const gameEvents = require('./gameEvents');

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const bjQueues = new Map(); // key → player[]
const bjRooms  = new Map();

function _makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const v of VALUES) deck.push({ suit: s, value: v });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function _cardVal(card) {
  if (['J', 'Q', 'K'].includes(card.value)) return 10;
  if (card.value === 'A') return 11;
  return parseInt(card.value);
}

function _handScore(hand) {
  if (!hand || !hand.length) return 0;
  let score = 0;
  let aces = 0;
  for (const c of hand) {
    score += _cardVal(c);
    if (c.value === 'A') aces++;
  }
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}

function _queueKey(entryFee, currency) { return `${entryFee}:${currency}`; }

function addToBlackjackQueue(player) {
  const key = _queueKey(player.entryFee, player.currency);
  const queue = bjQueues.get(key) || [];
  const idx = queue.findIndex(p => p.socketId !== player.socketId);
  if (idx !== -1) {
    const opponent = queue.splice(idx, 1)[0];
    if (queue.length === 0) bjQueues.delete(key); else bjQueues.set(key, queue);
    const roomId = 'bj_' + uuidv4();
    const room = _makeRoom(roomId, player, opponent);
    bjRooms.set(roomId, room);
    return { roomId, p1: player, p2: opponent };
  }
  queue.push(player);
  bjQueues.set(key, queue);
  return null;
}

function removeFromBlackjackQueue(socketId) {
  for (const [key, queue] of bjQueues) {
    const idx = queue.findIndex(p => p.socketId === socketId);
    if (idx !== -1) { queue.splice(idx, 1); if (!queue.length) bjQueues.delete(key); return; }
  }
}

function _makeRoom(roomId, p1, p2) {
  const deck = _makeDeck();
  const dealerHand = [deck.pop(), deck.pop()];
  const hands = {
    [p1.socketId]: [deck.pop(), deck.pop()],
    [p2.socketId]: [deck.pop(), deck.pop()],
  };
  return {
    roomId, players: [p1, p2],
    entryFee: p1.entryFee, currency: p1.currency,
    state: 'active',
    deck, dealerHand, hands,
    stood: {},
    busted: {},
    // Split support:
    splitHand: {},        // { [socketId]: cards[] } — pending hand2 (before player switches to it)
    completedHand1: {},   // { [socketId]: cards[] } — hand1 after player transitions to hand2
    timer: null,
  };
}

function getBlackjackRoom(roomId)    { return bjRooms.get(roomId); }
function deleteBlackjackRoom(roomId) { bjRooms.delete(roomId); }
function getBlackjackRoomBySocket(socketId) {
  for (const [roomId, room] of bjRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectBlackjackRoom(p1, p2) {
  const roomId = 'bj_' + uuidv4();
  bjRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

// ── Best effective score for a player (accounts for split hands) ──────────────
function _getBestEff(room, socketId) {
  const mainScore = _handScore(room.hands[socketId]);
  const mainEff   = mainScore > 21 ? 0 : mainScore;
  const splitH    = room.completedHand1[socketId];
  if (splitH) {
    const splitEff = _handScore(splitH) > 21 ? 0 : _handScore(splitH);
    return Math.max(mainEff, splitEff);
  }
  return mainEff;
}

// ── Transition player from hand1 to hand2 after split ────────────────────────
function _transitionToHand2(io, supabase, room, socketId) {
  const hand2 = room.splitHand[socketId];
  if (!hand2) return;

  // Save completed hand1
  room.completedHand1[socketId] = [...room.hands[socketId]];
  // Activate hand2
  room.hands[socketId] = hand2;
  delete room.splitHand[socketId];
  room.busted[socketId] = false; // reset bust flag for hand2

  const score2 = _handScore(hand2);
  const sock = io.sockets.sockets.get(socketId);
  if (sock) sock.emit('bj_split_hand2', { hand: hand2, score: score2 });

  // Auto-stand if hand2 is 21
  if (score2 === 21) {
    room.stood[socketId] = true;
    _checkAllDone(io, room.roomId, supabase);
  }
}

function startBlackjackGame(io, supabase, roomId) {
  const room = getBlackjackRoom(roomId);
  if (!room) return;

  // Send each player their hand + dealer up-card (hide dealer hole card)
  for (const p of room.players) {
    if (p.isBot) continue;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) continue;
    const oppSocketId = room.players.find(x => x.socketId !== p.socketId)?.socketId;
    sock.emit('bj_start', {
      hand: room.hands[p.socketId],
      handScore: _handScore(room.hands[p.socketId]),
      dealerUpCard: room.dealerHand[0],
      opponentHand: room.hands[oppSocketId] ?? [],   // initial 2 cards shown face-up
      opponentHandSize: room.hands[oppSocketId]?.length ?? 2,
      timeLimit: 20,
    });
  }

  // 20-second timer — auto-stand anyone who hasn't acted
  room.timer = setTimeout(() => {
    _autoStandAll(io, supabase, roomId);
  }, 20000);

  // If bot is a player, simulate bot action after short delay
  for (const p of room.players) {
    if (p.isBot) {
      const delay = 2000 + Math.random() * 3000;
      setTimeout(() => _botAction(io, supabase, roomId, p.socketId), delay);
    }
  }
}

function _emitBotCardToHuman(io, room, botSocketId, card) {
  const humanPlayer = room.players.find(p => !p.isBot);
  if (humanPlayer) io.to(humanPlayer.socketId).emit('bj_opp_card', { card });
}

function _botAction(io, supabase, roomId, botSocketId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  const hand = room.hands[botSocketId];
  const score = _handScore(hand);
  if (score < 17) {
    const newCard = room.deck.pop();
    room.hands[botSocketId].push(newCard);
    _emitBotCardToHuman(io, room, botSocketId, newCard);
    if (_handScore(room.hands[botSocketId]) > 21) {
      room.busted[botSocketId] = true;
      room.stood[botSocketId] = true;
    } else if (_handScore(room.hands[botSocketId]) >= 17) {
      room.stood[botSocketId] = true;
    } else {
      setTimeout(() => _botAction(io, supabase, roomId, botSocketId), 1500);
      return;
    }
  } else {
    room.stood[botSocketId] = true;
  }
  _checkAllDone(io, roomId, supabase);
}

function handleBlackjackHit(io, supabase, roomId, socketId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.stood[socketId] || room.busted[socketId]) return;

  const card = room.deck.pop();
  room.hands[socketId].push(card);
  const score = _handScore(room.hands[socketId]);

  io.to(socketId).emit('bj_card', { card, hand: room.hands[socketId], score });

  // Notify opponent about the new card (they see it only after they've hit the same number of times)
  const oppSocketId = room.players.find(p => p.socketId !== socketId)?.socketId;
  const oppPlayer   = room.players.find(p => p.socketId !== socketId);
  if (oppSocketId && !oppPlayer?.isBot) {
    io.to(oppSocketId).emit('bj_opp_card', { card });
  }

  if (score > 21) {
    room.busted[socketId] = true;
    io.to(socketId).emit('bj_bust', { score });
    // If on hand1 and has pending hand2, transition instead of ending
    if (room.splitHand[socketId]) {
      _transitionToHand2(io, supabase, room, socketId);
      return;
    }
    room.stood[socketId] = true;
    _checkAllDone(io, roomId, supabase);
  } else if (score === 21) {
    // Auto-stand on 21
    if (room.splitHand[socketId]) {
      // On hand1, auto-transition to hand2
      _transitionToHand2(io, supabase, room, socketId);
      return;
    }
    room.stood[socketId] = true;
    _checkAllDone(io, roomId, supabase);
  }
}

function handleBlackjackStand(io, supabase, roomId, socketId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.stood[socketId]) return;

  // If on hand1 and has pending hand2, transition instead of standing
  if (room.splitHand[socketId]) {
    _transitionToHand2(io, supabase, room, socketId);
    return;
  }

  room.stood[socketId] = true;
  io.to(socketId).emit('bj_stood');
  _checkAllDone(io, roomId, supabase);
}

function handleBlackjackSplit(io, supabase, roomId, socketId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (room.stood[socketId] || room.busted[socketId]) return;

  const currentHand = room.hands[socketId];
  // Can only split initial 2 cards of the same rank
  if (currentHand.length !== 2) return;
  if (currentHand[0].value !== currentHand[1].value) return;
  // Only one split per game
  if (room.splitHand[socketId] || room.completedHand1[socketId]) return;

  const [card1, card2] = currentHand;
  const newCard1 = room.deck.pop();
  const newCard2 = room.deck.pop();

  const hand1 = [card1, newCard1];
  const hand2 = [card2, newCard2];

  room.hands[socketId] = hand1;
  room.splitHand[socketId] = hand2;

  const score1 = _handScore(hand1);
  const score2 = _handScore(hand2);

  const sock = io.sockets.sockets.get(socketId);
  if (sock) sock.emit('bj_split', { hand1, score1, hand2, score2 });

  // Notify opponent that their opponent split (they're now playing 2 hands)
  const oppSocketId = room.players.find(p => p.socketId !== socketId)?.socketId;
  if (oppSocketId) io.to(oppSocketId).emit('bj_opp_split');

  // If hand1 immediately hits 21, auto-transition to hand2
  if (score1 === 21) {
    _transitionToHand2(io, supabase, room, socketId);
  }
}

function _autoStandAll(io, supabase, roomId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  for (const p of room.players) {
    // If still on hand1 of a split, complete hand1 and transition
    if (!room.stood[p.socketId]) {
      // Skip players whose socket is gone — the disconnect handler will forfeit them
      if (!p.isBot) {
        const sock = io.sockets.sockets.get(p.socketId);
        if (!sock || !sock.connected) continue;
      }
      if (room.splitHand[p.socketId]) {
        room.completedHand1[p.socketId] = [...room.hands[p.socketId]];
        room.hands[p.socketId] = room.splitHand[p.socketId];
        delete room.splitHand[p.socketId];
      }
      room.stood[p.socketId] = true;
    }
  }
  _checkAllDone(io, roomId, supabase);
}

function _checkAllDone(io, roomId, supabase) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  const allDone = room.players.every(p => room.stood[p.socketId]);
  if (allDone) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    _resolveGame(io, supabase, roomId);
  }
}

async function _resolveGame(io, supabase, roomId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  // Dealer draws to 17
  while (_handScore(room.dealerHand) < 17) room.dealerHand.push(room.deck.pop());
  const dealerScore = _handScore(room.dealerHand);

  const [p1, p2] = room.players;

  // 1v1 resolution: best effective score wins (bust = 0)
  // Uses best-of-split-hands approach
  const eff1 = _getBestEff(room, p1.socketId);
  const eff2 = _getBestEff(room, p2.socketId);
  const isDraw = eff1 === eff2;

  const winner = isDraw ? p1 : (eff1 > eff2 ? p1 : p2);
  const loser  = isDraw ? p2 : (eff1 > eff2 ? p2 : p1);

  const isFree = room.entryFee === 0;
  const { newWinnerElo, newLoserElo } = (isDraw || isFree)
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0) {
    try {
      const hasBot = winner.isBot || loser.isBot || p1.isBot || p2.isBot;
      if (hasBot) {
        const humanId = p1.isBot ? p2.userId : p1.userId;
        if (isDraw) {
          // Bot draw: fee already deducted upfront — full refund (bot matches are diamonds-only, no platform fee)
          if (room.currency === 'diamonds') {
            await creditDiamonds(supabase, humanId, Math.floor(room.entryFee));
          } else {
            await creditCoins(supabase, humanId, parseFloat(room.entryFee));
          }
          balanceChange = { winnerPayout: room.entryFee };
        } else {
          balanceChange = await settleBotMatch(supabase, humanId, room.entryFee, room.currency, !winner.isBot);
        }
      } else if (isDraw) {
        balanceChange = room.currency === 'diamonds'
          ? await settleDrawMatchDiamonds(supabase, p1.userId, p2.userId, room.entryFee)
          : await settleDrawMatch(supabase, p1.userId, p2.userId, room.entryFee);
      } else {
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee)
          : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee);
      }
    } catch (e) { console.error('[blackjackEngine] settle:', e.message); }
  }

  let winnerStreak = 0, isFirstWin = false;
  if (supabase) {
    if (!isDraw && !isFree) {
      if (!winner.isBot) {
        try { await applyEloUpdate(supabase, winner.userId, newWinnerElo); } catch (eloWinErr) { console.error('[blackjackEngine] elo winner update failed:', eloWinErr.message); }
        try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch (e) { console.error('[blackjackEngine] increment_win:', e.message); }
      }
      if (!loser.isBot) {
        try { await applyEloUpdate(supabase, loser.userId, newLoserElo); } catch (eloLoseErr) { console.error('[blackjackEngine] elo loser update failed:', eloLoseErr.message); }
        try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch (e) { console.error('[blackjackEngine] increment_loss:', e.message); }
      }
      if (!winner.isBot) {
        // Human won: increment their streak
        try { ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null)); } catch (e) { console.error('[blackjackEngine] updateStreaks:', e.message); }
      }
    }
    // Always reset human loser's streak — any game, free or paid, vs bot or human
    if (!loser.isBot) {
      try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId); } catch (e) { console.error('[blackjackEngine] reset streak:', e.message); }
    }
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot ? null : loser.userId,
        winner_id: isDraw ? null : (winner.isBot ? null : winner.userId),
        game_type: 'blackjack',
        entry_fee_c: room.currency === 'coins' ? room.entryFee : 0,
        entry_fee_diamonds: room.currency === 'diamonds' ? room.entryFee : 0,
      });
    } catch (e) { console.error('[blackjackEngine] matches insert:', e.message); }
    if (room.entryFee > 0) {
      await creditRakeback(supabase, winner.isBot ? null : winner.userId, loser.isBot ? null : loser.userId, room.entryFee * 2, room.currency);
    }
  }

  // Build hand result info (include split hands)
  function handInfo(p) {
    const mainScore = _handScore(room.hands[p.socketId]);
    const splitH = room.completedHand1[p.socketId] ?? null;
    return {
      hand: room.hands[p.socketId],
      score: mainScore,
      splitHand: splitH,
      splitScore: splitH ? _handScore(splitH) : null,
    };
  }

  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId).filter(Boolean) });
  io.to(roomId).emit('bj_result', {
    isDraw,
    winnerId: winner.userId,
    loserId: loser.userId,
    winnerUsername: winner.username,
    loserUsername: loser.username,
    newWinnerElo,
    newLoserElo,
    balanceChange,
    currency: room.currency,
    entryFee: room.entryFee,
    winnerStreak: winnerStreak ?? 0,
    isFirstWin: isFirstWin ?? false,
    hands: {
      [p1.userId]: handInfo(p1),
      [p2.userId]: handInfo(p2),
    },
    dealerHand: room.dealerHand,
    dealerScore,
  });
}

module.exports = {
  addToBlackjackQueue, removeFromBlackjackQueue,
  getBlackjackRoom, deleteBlackjackRoom, getBlackjackRoomBySocket,
  createDirectBlackjackRoom,
  startBlackjackGame,
  handleBlackjackHit, handleBlackjackStand, handleBlackjackSplit,
};
