const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');

const ROUNDS_TO_WIN = 2;

const rpsRooms = new Map();
const rpsQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Returns 'p1' | 'p2' | 'tie'
function getWinner(c1, c2) {
  if (c1 === c2) return 'tie';
  if (
    (c1==='rock'&&c2==='scissors') ||
    (c1==='scissors'&&c2==='paper') ||
    (c1==='paper'&&c2==='rock')
  ) return 'p1';
  return 'p2';
}

function addToRPSQueue(player) {
  const idx = rpsQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency
  );
  if (idx !== -1) {
    const opponent = rpsQueue.splice(idx, 1)[0];
    const roomId = 'rps_' + uuidv4();
    const room = _makeRoom(roomId, opponent, player);
    rpsRooms.set(roomId, room);
    return { roomId, p1: opponent, p2: player };
  }
  rpsQueue.push(player);
  return null;
}

function removeFromRPSQueue(socketId) {
  const idx = rpsQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) rpsQueue.splice(idx, 1);
}

function getRPSRoom(roomId)    { return rpsRooms.get(roomId); }
function deleteRPSRoom(roomId) { rpsRooms.delete(roomId); }
function getRPSRoomBySocket(socketId) {
  for (const [roomId, room] of rpsRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectRPSRoom(p1, p2) {
  const roomId = 'rps_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  rpsRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  return {
    roomId,
    players:   [p1, p2],
    choices:   {},
    state:     'choosing',
    entryFee:  p1.entryFee,
    currency:  p1.currency,
    rematches: {},
    round:     1,
    roundWins: { [p1.userId]: 0, [p2.userId]: 0 },
    roundTimer: null,
    consecutiveMisses: { [p1.userId]: 0, [p2.userId]: 0 },
  };
}

function _clearRPSTimer(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
}

function startRPSRound(io, supabase, roomId) {
  const room = getRPSRoom(roomId);
  if (!room) return;
  _clearRPSTimer(room);
  room.choices = {};
  room.state   = 'choosing';
  const endsAt = Date.now() + 20000;
  io.to(roomId).emit('rps_round_start', { round: room.round, endsAt });

  room.roundTimer = setTimeout(async () => {
    room.roundTimer = null;
    const r = getRPSRoom(roomId);
    if (!r || r.state !== 'choosing') return;

    // Auto-fill any missing choices randomly
    const opts = ['rock', 'paper', 'scissors'];
    const missed = [];
    for (const p of r.players) {
      if (!p.isBot && !r.choices[p.socketId]) {
        r.choices[p.socketId] = opts[Math.floor(Math.random() * 3)];
        missed.push(p.userId);
      }
    }

    // Increment consecutive misses for players who didn't choose
    r.consecutiveMisses = r.consecutiveMisses || {};
    for (const p of r.players) {
      if (missed.includes(p.userId)) {
        r.consecutiveMisses[p.userId] = (r.consecutiveMisses[p.userId] || 0) + 1;
      }
    }

    // Check forfeit (3 consecutive misses)
    for (const p of r.players) {
      if ((r.consecutiveMisses[p.userId] || 0) >= 3) {
        r.state = 'finished';
        const opp = r.players.find(q => q.userId !== p.userId);
        const { newWinnerElo, newLoserElo } = calculateNewRatings(opp.elo, p.elo);
        let balanceChange = null;
        if (supabase && r.entryFee > 0) {
          const { settleMatch, settleMatchDiamonds } = require('./walletService');
          try {
            balanceChange = r.currency === 'diamonds'
              ? await settleMatchDiamonds(supabase, opp.userId, p.userId, r.entryFee)
              : await settleMatch(supabase, opp.userId, p.userId, r.entryFee);
          } catch (e) { console.error('[rpsEngine] settle:', e.message); }
        }
        if (supabase) {
          try { await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', opp.userId); await supabase.rpc('increment_win', { uid: opp.userId }); } catch {}
          try { await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', p.userId); await supabase.rpc('increment_loss', { uid: p.userId }); } catch {}
        }
        io.to(roomId).emit('rps_result', {
          winnerId: opp.userId, loserId: p.userId,
          winnerUsername: opp.username, loserUsername: p.username,
          newWinnerElo, newLoserElo, balanceChange,
          currency: r.currency || 'coins', scores: r.roundWins, reason: 'afk',
        });
        return;
      }
    }

    await _resolveRound(io, supabase, roomId);
  }, 20000);
}

async function handleRPSChoice(io, supabase, roomId, socketId, choice) {
  const room = getRPSRoom(roomId);
  if (!room || room.state !== 'choosing') return;
  if (!['rock','paper','scissors'].includes(choice)) return;
  if (room.choices[socketId]) return;

  room.choices[socketId] = choice;

  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) {
    io.to(opp.socketId).emit('rps_opponent_chose');
  }

  // Bot auto-picks
  if (opp?.isBot && !room.choices[opp.socketId]) {
    const opts = ['rock','paper','scissors'];
    room.choices[opp.socketId] = opts[Math.floor(Math.random() * 3)];
  }

  if (room.players.every(p => room.choices[p.socketId])) {
    await _resolveRound(io, supabase, roomId);
  }
}

async function _resolveRound(io, supabase, roomId) {
  const room = getRPSRoom(roomId);
  if (!room) return;
  _clearRPSTimer(room);
  room.state = 'reveal';

  const [p1, p2] = room.players;
  const c1  = room.choices[p1.socketId];
  const c2  = room.choices[p2.socketId];
  const res = getWinner(c1, c2);

  io.to(roomId).emit('rps_reveal', {
    choices: { [p1.userId]: c1, [p2.userId]: c2 },
    result:  res,
    round:   room.round,
  });

  await sleep(2000);

  const r = getRPSRoom(roomId);
  if (!r) return;

  if (res === 'tie') {
    io.to(roomId).emit('rps_tie', { round: r.round });
    await sleep(800);
    const still = getRPSRoom(roomId);
    if (still) startRPSRound(io, supabase, roomId);
    return;
  }

  const winner = res === 'p1' ? p1 : p2;
  const loser  = res === 'p1' ? p2 : p1;

  r.roundWins[winner.userId] = (r.roundWins[winner.userId] || 0) + 1;
  const roundsWon = r.roundWins[winner.userId];
  const scores    = { ...r.roundWins };

  if (roundsWon >= ROUNDS_TO_WIN) {
    r.state = 'finished';
    const { newWinnerElo, newLoserElo } = calculateNewRatings(winner.elo, loser.elo);

    let balanceChange = null;
    if (supabase && r.entryFee > 0) {
      try {
        const _hasBot = winner.isBot || loser.isBot;
        if (_hasBot) {
          const _humanId = winner.isBot ? loser.userId : winner.userId;
          const _humanWon = !winner.isBot;
          balanceChange = await settleBotMatch(supabase, _humanId, r.entryFee, r.currency || 'coins', _humanWon);
        } else {
          balanceChange = r.currency === 'diamonds'
            ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, r.entryFee)
            : await settleMatch(supabase, winner.userId, loser.userId, r.entryFee);
        }
      } catch (e) { console.error('RPS settle error:', e.message); }
    }

    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[rpsEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[rpsEngine] RPC failed:', e.message); }
    }
    if (supabase) {
      try {
        await supabase.from('matches').insert({
          player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
          winner_id: winner.isBot ? null : winner.userId, game_type: 'rps',
          entry_fee_c: (r.currency || 'coins') === 'coins' ? (r.entryFee || 0) : 0, entry_fee_diamonds: (r.currency || 'coins') === 'diamonds' ? (r.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[rpsEngine] matches insert:', e.message); }
    }

    io.to(roomId).emit('rps_result', {
      winnerId:       winner.userId,
      loserId:        loser.userId,
      winnerUsername: winner.username,
      loserUsername:  loser.username,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      currency: r.currency || 'coins',
      scores,
    });
  } else {
    r.round++;
    r.state = 'between_rounds';
    io.to(roomId).emit('rps_round_result', {
      round:         r.round - 1,
      roundWinnerId: winner.userId,
      scores,
    });
    await sleep(1500);
    const current = getRPSRoom(roomId);
    if (current && current.state === 'between_rounds') startRPSRound(io, supabase, roomId);
  }
}

module.exports = {
  addToRPSQueue, removeFromRPSQueue,
  getRPSRoom, deleteRPSRoom, getRPSRoomBySocket,
  createDirectRPSRoom,
  startRPSRound, handleRPSChoice,
};
