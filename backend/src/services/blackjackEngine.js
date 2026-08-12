// Outcomes that decide real money use the crypto RNG, not Math.random.
// V8's Math.random is a fast non-cryptographic PRNG: an attacker who can watch
// enough results can recover its internal state and predict the next ones. For
// a coin flip, a shuffled deck or a shared level seed that is a live edge, so
// these use crypto.randomInt instead. Cosmetic randomness elsewhere (bot names,
// timing jitter) is deliberately left alone.
const { randomInt } = require('node:crypto');
const { findRoomBySocket } = require('./roomLookup');
const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, applyMatchStreaks, applyEloUpdate } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch, settleDrawMatch, settleDrawMatchDiamonds, creditCoins, creditDiamonds } = require('./walletService');
const { unlockUser } = require('./lockService');
const gameEvents = require('./gameEvents');

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const bjQueues = new Map(); // key → player[]
const bjRooms  = new Map();

function _makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const v of VALUES) deck.push({ suit: s, value: v });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
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
  const idx = queue.findIndex(p => p.socketId !== player.socketId && !!p.isDemo === !!player.isDemo);
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
    if (idx !== -1) { queue.splice(idx, 1); if (!queue.length) bjQueues.delete(key); return true; }
  }
  return false;
}

// Pull a specific card out of the deck (removing it) so rigged hands don't
// duplicate cards the deck can still deal on a hit. Falls back to the top card.
function _takeCard(deck, pred) {
  const i = deck.findIndex(pred);
  return i !== -1 ? deck.splice(i, 1)[0] : deck.pop();
}

const _TEN_FACES = ['10', 'J', 'Q', 'K'];

// Build a two-card hand from the deck summing to `target` (13–21), using a
// ten-value card + the complement. Faces are varied and never form a splittable
// pair, so rigged demo hands look like ordinary deals.
function _dealTwoTo(deck, target) {
  const need = target - 10; // 3..11
  const firstFace = _TEN_FACES[Math.floor(Math.random() * _TEN_FACES.length)];
  const first = _takeCard(deck, c => c.value === firstFace) || _takeCard(deck, c => _cardVal(c) === 10);
  let second;
  if (need === 11) {
    second = _takeCard(deck, c => c.value === 'A');
  } else if (need === 10) {
    const others = _TEN_FACES.filter(f => f !== first.value);
    const otherFace = others[Math.floor(Math.random() * others.length)];
    second = _takeCard(deck, c => c.value === otherFace) || _takeCard(deck, c => _cardVal(c) === 10 && c.value !== first.value);
  } else {
    second = _takeCard(deck, c => c.value === String(need));
  }
  return [first, second];
}

// Rigged hit card for a demo player: climbs toward 20 or 21 without busting, so
// the demo can be dealt anything and hit its way to a winning hand realistically.
function _riggedDemoHitCard(deck, hand) {
  const s = _handScore(hand);
  const safeMax = 21 - s;                 // biggest value we can add without busting
  if (safeMax <= 0) return _takeCard(deck, () => true); // already 21 (shouldn't hit); rig covers
  const target = Math.random() < 0.4 ? 20 : 21;         // aim for 20 sometimes, 21 mostly
  let add = Math.min(target - s, safeMax, 11);
  if (add <= 0) add = Math.min(safeMax, 11);            // already past target — just stay safe
  // Ace covers an add of 1 (soft-reduces) or 11 (soft).
  if (add === 1 || add === 11) {
    return _takeCard(deck, c => c.value === 'A')
        || _takeCard(deck, c => _cardVal(c) <= safeMax);
  }
  // add 2..10: a hard card of exactly that value lands us on the target.
  return _takeCard(deck, c => _cardVal(c) === add && c.value !== 'A')
      || _takeCard(deck, c => _cardVal(c) <= safeMax && c.value !== 'A')
      || _takeCard(deck, c => _cardVal(c) <= safeMax);
}

function _makeRoom(roomId, p1, p2) {
  const deck = _makeDeck();
  const dealerHand = [deck.pop(), deck.pop()];
  const hands = {
    [p1.socketId]: [deck.pop(), deck.pop()],
    [p2.socketId]: [deck.pop(), deck.pop()],
  };

  // Demo account vs bot: the demo always wins, but it plays out realistically.
  // The demo keeps its normal random deal; its HIT cards are rigged to climb
  // toward 20/21 without busting (see handleBlackjackHit / _riggedDemoHitCard).
  // The bot is set up to lose — it either busts or stands on a low total (17–18).
  const demo = [p1, p2].find(p => p.isDemo && !p.isBot);
  const bot  = [p1, p2].find(p => p.isBot);
  let botForceBust = false;
  const demoRig = !!(demo && bot);
  if (demoRig) {
    if (Math.random() < 0.5) {
      // Bot busts: start it at 13–16 so dealer rules make it hit, then the hit
      // is forced to a ten to bust it (see _botAction).
      hands[bot.socketId] = _dealTwoTo(deck, 13 + Math.floor(Math.random() * 4)); // 13..16
      botForceBust = true;
    } else {
      // Bot stands low: a pat 17 or 18 — dealer stands, the demo's 20/21 beats it.
      hands[bot.socketId] = _dealTwoTo(deck, 17 + Math.floor(Math.random() * 2)); // 17..18
    }
  }

  return {
    roomId, players: [p1, p2],
    entryFee: p1.entryFee, currency: p1.currency,
    state: 'active',
    deck, dealerHand, hands,
    stood: {},
    busted: {},
    botForceBust, // demo game: bot's next hit is forced to bust it
    demoRig,      // demo game: demo's hit cards are rigged toward 20/21
    demoSocketId: demoRig ? demo.socketId : null,
    // Split support:
    splitHand: {},        // { [socketId]: cards[] } — pending hand2 (before player switches to it)
    completedHand1: {},   // { [socketId]: cards[] } — hand1 after player transitions to hand2
    timer: null,
  };
}

function getBlackjackRoom(roomId)    { return bjRooms.get(roomId); }
function deleteBlackjackRoom(roomId) { bjRooms.delete(roomId); }
// Prefers a live room over a settled-but-not-yet-swept one. See roomLookup.
function getBlackjackRoomBySocket(socketId) {
  return findRoomBySocket(bjRooms, socketId);
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
  // Deal hand2's second card now (it was held back until hand1 finished)
  if (hand2.length < 2) hand2.push(room.deck.pop());
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
    // Demo game rigged for a bot bust: force the hit to a ten so the bot busts.
    const newCard = room.botForceBust
      ? (_takeCard(room.deck, c => _cardVal(c) === 10) || room.deck.pop())
      : room.deck.pop();
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

// Only a player IN this room may act on it. See the note in carDashEngine:
// resolution is keyed off room.players so outcomes were never at risk, but an
// outsider naming a room they are not in should not be able to touch its state
// at all.
function _isPlayer(room, socketId) {
  return !!room && Array.isArray(room.players)
    && room.players.some(p => p.socketId === socketId);
}

function handleBlackjackHit(io, supabase, roomId, socketId) {
  const room = getBlackjackRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (!_isPlayer(room, socketId)) return;
  if (room.stood[socketId] || room.busted[socketId]) return;

  // Demo game: rig the demo's hit cards so it climbs toward 20/21 without busting.
  const card = (room.demoRig && socketId === room.demoSocketId)
    ? _riggedDemoHitCard(room.deck, room.hands[socketId])
    : room.deck.pop();
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
  if (!_isPlayer(room, socketId)) return;
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
  if (!_isPlayer(room, socketId)) return;
  if (room.stood[socketId] || room.busted[socketId]) return;

  const currentHand = room.hands[socketId];
  // Can only split initial 2 cards of the same rank
  if (currentHand.length !== 2) return;
  if (currentHand[0].value !== currentHand[1].value) return;
  // Only one split per game
  if (room.splitHand[socketId] || room.completedHand1[socketId]) return;

  const [card1, card2] = currentHand;
  const newCard1 = room.deck.pop();

  const hand1 = [card1, newCard1];
  const hand2 = [card2]; // hand 2's second card is dealt only once it becomes active

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
  let isDraw = eff1 === eff2;

  let winner = isDraw ? p1 : (eff1 > eff2 ? p1 : p2);
  let loser  = isDraw ? p2 : (eff1 > eff2 ? p2 : p1);

  // Rig demo wins: a demo account playing a bot always wins.
  const demoPlayer = [p1, p2].find(p => p.isDemo && !p.isBot);
  if (demoPlayer && (p1.isBot || p2.isBot)) {
    isDraw = false;
    winner = demoPlayer;
    loser  = demoPlayer === p1 ? p2 : p1;
  }

  const isFree = room.entryFee === 0;
  const { newWinnerElo, newLoserElo } = (isDraw || isFree)
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0 && !room.feesDeducted) {
    // Defensive: never settle a paid match whose fees were never taken.
    console.error(`[blackjackEngine] CRITICAL: room ${roomId} reached settlement without feesDeducted — no payout issued`);
    unlockUser(p1.userId); unlockUser(p2.userId);
  } else if (supabase && room.entryFee > 0) {
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
          balanceChange = await settleBotMatch(supabase, humanId, room.entryFee, room.currency, !winner.isBot, { game: 'Blackjack' });
        }
      } else if (isDraw) {
        balanceChange = room.currency === 'diamonds'
          ? await settleDrawMatchDiamonds(supabase, p1.userId, p2.userId, room.entryFee)
          : await settleDrawMatch(supabase, p1.userId, p2.userId, room.entryFee);
      } else {
        const meta = { game: 'Blackjack', winnerUsername: winner.username, loserUsername: loser.username };
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee, meta)
          : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee, meta);
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
      // Streaks are PvP-only — applyMatchStreaks no-ops on bot matches, and
      // handles both the winner's increment and the loser's reset.
      try { ({ winnerStreak, isFirstWin } = await applyMatchStreaks(supabase, winner, loser)); } catch (e) { console.error('[blackjackEngine] streaks:', e.message); }
    }

    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot ? null : loser.userId,
        winner_id: isDraw ? null : (winner.isBot ? null : winner.userId),
        game_type: 'blackjack',
        entry_fee_c: room.currency === 'coins' ? room.entryFee : 0,
        entry_fee_diamonds: room.currency === 'diamonds' ? room.entryFee : 0,
        prize_pool_c: room.currency === 'coins' ? (room.entryFee || 0) * 2 : 0,
        prize_pool_diamonds: room.currency === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
      });
    } catch (e) { console.error('[blackjackEngine] matches insert:', e.message); }
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
