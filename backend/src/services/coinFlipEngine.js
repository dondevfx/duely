// Outcomes that decide real money use the crypto RNG, not Math.random.
// V8's Math.random is a fast non-cryptographic PRNG: an attacker who can watch
// enough results can recover its internal state and predict the next ones. For
// a coin flip, a shuffled deck or a shared level seed that is a live edge, so
// these use crypto.randomInt instead. Cosmetic randomness elsewhere (bot names,
// timing jitter) is deliberately left alone.
const { randomInt } = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
const { settleMatch, settleCoinFlip, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { unlockUser } = require('./lockService');
const gameEvents = require('./gameEvents');

// Queues: headsQueue / tailsQueue keyed by `${entryFee}:${currency}`
const headsQueues = new Map();
const tailsQueues = new Map();
const coinFlipRooms = new Map();

function _queueKey(entryFee, currency) {
  return `${entryFee}:${currency}`;
}

function addToCoinFlipQueue(player) {
  const key = _queueKey(player.entryFee, player.currency);
  const opposite = player.side === 'heads' ? tailsQueues : headsQueues;
  const own = player.side === 'heads' ? headsQueues : tailsQueues;

  const oppQueue = opposite.get(key) || [];
  const oppIdx = oppQueue.findIndex(p => !!p.isDemo === !!player.isDemo);
  if (oppIdx !== -1) {
    const opponent = oppQueue.splice(oppIdx, 1)[0];
    if (oppQueue.length === 0) opposite.delete(key); else opposite.set(key, oppQueue);

    const roomId = 'coinflip_' + uuidv4();
    const room = {
      roomId,
      players: [player, opponent],
      entryFee: player.entryFee,
      currency: player.currency,
      state: 'active',
    };
    coinFlipRooms.set(roomId, room);
    return { roomId, p1: player, p2: opponent };
  }

  const ownQueue = own.get(key) || [];
  ownQueue.push(player);
  own.set(key, ownQueue);
  return null;
}

function removeFromCoinFlipQueue(socketId) {
  for (const [key, queue] of headsQueues) {
    const idx = queue.findIndex(p => p.socketId === socketId);
    if (idx !== -1) { queue.splice(idx, 1); if (queue.length === 0) headsQueues.delete(key); return true; }
  }
  for (const [key, queue] of tailsQueues) {
    const idx = queue.findIndex(p => p.socketId === socketId);
    if (idx !== -1) { queue.splice(idx, 1); if (queue.length === 0) tailsQueues.delete(key); return true; }
  }
  return false;
}

function getCoinFlipRoom(roomId) { return coinFlipRooms.get(roomId); }
function deleteCoinFlipRoom(roomId) { coinFlipRooms.delete(roomId); }
function getCoinFlipRoomBySocket(socketId) {
  for (const [roomId, room] of coinFlipRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectCoinFlipRoom(p1, p2) {
  const roomId = 'coinflip_' + uuidv4();
  // p1 keeps their chosen side; p2 gets opposite
  const p2Side = p1.side === 'heads' ? 'tails' : 'heads';
  const room = {
    roomId,
    players: [p1, { ...p2, side: p2Side }],
    entryFee: p1.entryFee,
    currency: p1.currency,
    state: 'active',
  };
  coinFlipRooms.set(roomId, room);
  return { roomId, p1, p2: { ...p2, side: p2Side } };
}

async function resolveCoinFlip(io, supabase, roomId) {
  const room = getCoinFlipRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';

  const [p1, p2] = room.players;
  let result = randomInt(2) === 0 ? 'heads' : 'tails';

  // Rig demo wins: a demo account playing a bot always wins the flip.
  const demoPlayer = [p1, p2].find(p => p.isDemo && !p.isBot);
  if (demoPlayer && (p1.isBot || p2.isBot)) {
    result = demoPlayer.side;
  }

  const winner = p1.side === result ? p1 : p2;
  const loser  = p1.side === result ? p2 : p1;

  const isFree = room.entryFee === 0;
  const { newWinnerElo, newLoserElo } = isFree
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0 && !room.feesDeducted) {
    // Defensive: never pay out a paid match whose entry fees were never taken —
    // that would mint a payout from nothing. This can't happen today (feesDeducted
    // is set synchronously after a successful deduct), but the guard makes it
    // impossible for any future code path to do so.
    console.error(`[coinFlipEngine] CRITICAL: room ${roomId} reached settlement without feesDeducted — no payout issued`);
    unlockUser(winner.userId); unlockUser(loser.userId);
  } else if (supabase && room.entryFee > 0) {
    try {
      if (winner.isBot || loser.isBot) {
        const humanId = winner.isBot ? loser.userId : winner.userId;
        balanceChange = await settleBotMatch(supabase, humanId, room.entryFee, room.currency, !winner.isBot, { game: 'Coin Flip' }, 0.98); // 2% rake for all account types
      } else {
        const meta = { game: 'Coin Flip', winnerUsername: winner.username, loserUsername: loser.username };
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee, meta)
          : await settleCoinFlip(supabase, winner.userId, loser.userId, room.entryFee, meta); // 2% rake
      }
    } catch (e) { console.error('[coinFlipEngine] settle:', e.message); }
  }

  let winnerStreak = 0, isFirstWin = false;
  if (supabase) {
    if (!isFree) {
      if (!winner.isBot) {
        try { await applyEloUpdate(supabase, winner.userId, newWinnerElo); } catch {}
        try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch {}
      }
      if (!loser.isBot) {
        try { await applyEloUpdate(supabase, loser.userId, newLoserElo); } catch {}
        try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch {}
      }
      if (!winner.isBot) {
        // Human won: increment their streak
        try { ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null)); } catch {}
      }
    }
    // Always reset human loser's streak — any game, free or paid, vs bot or human
    if (!loser.isBot) {
      try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId); } catch {}
    }
    try {
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId,
        game_type: 'coin_flip',
        entry_fee_c: room.currency === 'coins' ? room.entryFee : 0,
        entry_fee_diamonds: room.currency === 'diamonds' ? room.entryFee : 0,
        prize_pool_c: room.currency === 'coins' ? (room.entryFee || 0) * 2 : 0,
        prize_pool_diamonds: room.currency === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
      });
    } catch (e) { console.error('[coinFlipEngine] matches insert:', e.message); }
  }

  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId).filter(Boolean) });
  io.to(roomId).emit('coin_flip_result', {
    result,
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
  });
}

module.exports = {
  addToCoinFlipQueue, removeFromCoinFlipQueue,
  createDirectCoinFlipRoom,
  getCoinFlipRoom, deleteCoinFlipRoom, getCoinFlipRoomBySocket,
  resolveCoinFlip,
};
