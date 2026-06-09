const { v4: uuidv4 } = require('uuid');
const { calculateNewRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { BOTS_ENABLED } = require('./botService');
const { updateHighscore } = require('./highscoreService');

const GAME_DURATION        = 10000;
const MIN_MS_BETWEEN_CLICKS = 20;
const ROUNDS_TO_WIN        = 2;

const clickRooms = new Map();
const clickQueue = [];

function _makeRoom(p1, p2) {
  const roomId = uuidv4();
  const isBot  = p1.isBot || p2.isBot;
  const room = {
    players:      [p1, p2],
    state:        'waiting',
    entryFee:     p1.entryFee,
    currency:     p1.currency || 'coins',
    isBot,
    clicks:       { [p1.socketId]: 0, [p2.socketId]: 0 },
    lastClickAt:  { [p1.socketId]: 0, [p2.socketId]: 0 },
    rematches:    {},
    gameTimer:    null,
    tickTimer:    null,
    botIntervals: [],
    round:        1,
    roundWins:    { [p1.userId]: 0, [p2.userId]: 0 },
  };
  clickRooms.set(roomId, room);
  return roomId;
}

function createDirectClickRoom(p1, p2) {
  const roomId = _makeRoom(p1, p2);
  return { roomId };
}

function addToClickQueue(player) {
  clickQueue.push(player);
  if (clickQueue.length < 2) return null;
  clickQueue.sort((a, b) => a.elo - b.elo);
  const p1  = clickQueue.shift();
  const idx = clickQueue.findIndex(p =>
    p.socketId !== p1.socketId &&
    p.entryFee === p1.entryFee &&
    p.currency === p1.currency
  );
  if (idx === -1) { clickQueue.unshift(p1); return null; }
  const p2     = clickQueue.splice(idx, 1)[0];
  const roomId = _makeRoom(p1, p2);
  return { roomId, p1, p2 };
}

function removeFromClickQueue(socketId) {
  const idx = clickQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) clickQueue.splice(idx, 1);
}

function getClickRoom(roomId)  { return clickRooms.get(roomId) || null; }
function deleteClickRoom(roomId) {
  const room = clickRooms.get(roomId);
  if (room) {
    clearTimeout(room.gameTimer);
    clearInterval(room.tickTimer);
    room.botIntervals.forEach(clearInterval);
  }
  clickRooms.delete(roomId);
}
function getClickRoomBySocket(socketId) {
  for (const [roomId, room] of clickRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startClickRaceCountdown(io, supabase, roomId) {
  const room = getClickRoom(roomId);
  if (!room) return;
  room.state = 'countdown';

  for (let i = 3; i >= 1; i--) {
    if (!getClickRoom(roomId)) return;
    io.to(roomId).emit('click_race_countdown', { count: i });
    await sleep(1000);
  }

  if (!getClickRoom(roomId)) return;

  // Reset clicks for this round
  for (const p of room.players) {
    room.clicks[p.socketId]      = 0;
    room.lastClickAt[p.socketId] = 0;
  }
  room.botIntervals.forEach(clearInterval);
  room.botIntervals = [];
  clearTimeout(room.gameTimer);
  clearInterval(room.tickTimer);

  room.state     = 'active';
  room.startTime = Date.now();
  io.to(roomId).emit('click_race_go', { duration: GAME_DURATION });

  // Bot auto-clicks
  for (const player of room.players) {
    if (player.isBot && BOTS_ENABLED) {
      const cps = 3 + Math.random() * 3;
      const iv  = setInterval(() => {
        const r = getClickRoom(roomId);
        if (!r || r.state !== 'active') { clearInterval(iv); return; }
        r.clicks[player.socketId] = (r.clicks[player.socketId] || 0) + 1;
      }, 1000 / cps);
      room.botIntervals.push(iv);
    }
  }

  // Tick: send progress every second
  let elapsed = 0;
  room.tickTimer = setInterval(() => {
    elapsed += 1000;
    const r = getClickRoom(roomId);
    if (!r || r.state !== 'active') return;
    const counts = {};
    for (const p of r.players) counts[p.userId] = r.clicks[p.socketId] || 0;
    io.to(roomId).emit('click_race_tick', {
      timeLeft: Math.max(0, GAME_DURATION - elapsed),
      counts,
    });
  }, 1000);

  // End round after GAME_DURATION
  room.gameTimer = setTimeout(() => {
    resolveClickRound(io, supabase, roomId);
  }, GAME_DURATION);
}

function handleClickRaceClick(roomId, socketId) {
  const room = getClickRoom(roomId);
  if (!room || room.state !== 'active') return;

  const now = Date.now();
  if (now - (room.lastClickAt[socketId] || 0) < MIN_MS_BETWEEN_CLICKS) return;
  room.lastClickAt[socketId] = now;
  room.clicks[socketId] = (room.clicks[socketId] || 0) + 1;
}

async function resolveClickRound(io, supabase, roomId) {
  const room = getClickRoom(roomId);
  if (!room || room.state === 'finished' || room.state === 'between_rounds' || room.resolvingRound) return;
  room.resolvingRound = true;

  clearTimeout(room.gameTimer);
  clearInterval(room.tickTimer);
  room.botIntervals.forEach(clearInterval);
  room.botIntervals = [];

  const [p1, p2] = room.players;
  const c1 = room.clicks[p1.socketId] || 0;
  const c2 = room.clicks[p2.socketId] || 0;

  let winner, loser;
  if (c1 >= c2) { winner = p1; loser = p2; }
  else           { winner = p2; loser = p1; }

  room.roundWins[winner.userId] = (room.roundWins[winner.userId] || 0) + 1;
  const roundsWon = room.roundWins[winner.userId];
  const scores = { ...room.roundWins };

  const roundClicks = {
    [p1.userId]: c1,
    [p2.userId]: c2,
  };

  // Save best-round click count as highscore for both players
  if (supabase) {
    if (!p1.isBot && c1 > 0) updateHighscore(supabase, p1.userId, 'clickRace', c1).catch(() => {});
    if (!p2.isBot && c2 > 0) updateHighscore(supabase, p2.userId, 'clickRace', c2).catch(() => {});
  }

  if (roundsWon >= ROUNDS_TO_WIN) {
    // Match over
    room.state = 'finished';
    room.resolvingRound = false;

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
      } catch (e) { console.error('Click race settle:', e.message); }
    }

    if (supabase && !winner.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newWinnerElo }).eq('id', winner.userId);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[clickRaceEngine] RPC failed:', e.message); }
    }
    if (supabase && !loser.isBot) {
      try {
        await supabase.from('profiles').update({ elo: newLoserElo }).eq('id', loser.userId);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[clickRaceEngine] RPC failed:', e.message); }
    }
    if (supabase) {
      try {
        await supabase.from('matches').insert({
          player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
          winner_id: winner.isBot ? null : winner.userId, game_type: 'clickRace',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
        });
      } catch (e) { console.error('[clickRaceEngine] matches insert:', e.message); }
    }

    io.to(roomId).emit('click_race_result', {
      winnerId:       winner.userId,
      loserId:        loser.userId,
      winnerUsername: winner.username,
      loserUsername:  loser.username,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      currency:       room.currency || 'coins',
      isBot:          room.isBot,
      clicks:         roundClicks,
      winnerClicks:   room.clicks[winner.socketId] || 0,
      loserClicks:    room.clicks[loser.socketId]  || 0,
      scores,
    });
  } else {
    // Lock state immediately so no clicks bleed through
    room.state = 'between_rounds';
    room.round++;
    room.resolvingRound = false;

    io.to(roomId).emit('click_round_result', {
      round:         room.round - 1,
      roundWinnerId: winner.userId,
      scores,
      clicks:        roundClicks,
    });

    await sleep(2500);
    const current = getClickRoom(roomId);
    if (current && current.state === 'between_rounds') {
      await startClickRaceCountdown(io, supabase, roomId);
    }
  }
}

// backwards compat alias
const resolveClickRace = resolveClickRound;

module.exports = {
  createDirectClickRoom,
  addToClickQueue,
  removeFromClickQueue,
  getClickRoom,
  deleteClickRoom,
  getClickRoomBySocket,
  startClickRaceCountdown,
  handleClickRaceClick,
  resolveClickRace,
};
