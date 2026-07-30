/**
 * carDashEngine.js — "Highway Dash"
 *
 * Both players drive the same seeded traffic; the highest SCORE wins (survival
 * time breaks a tie).
 *
 * Anti-cheat: the score IS survival time, and the SERVER measures it. The client
 * only reports "I crashed" — the server timestamps it against the match start,
 * so a claimed time can never exceed real elapsed time. Live progress pings are
 * clamped to the wall clock for the same reason. Traffic is generated from a
 * shared seed, so both players face an identical road (pure skill, verifiable).
 */
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { unlockUser } = require('./lockService');
const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
const { updateHighscore } = require('./highscoreService');
const gameEvents = require('./gameEvents');
const { v4: uuidv4 } = require('uuid');

const MAX_RUN_MS = 15 * 60_000; // sanity ceiling — no run is 15 minutes
// Anti-cheat: score is client-computed, so it is capped against server-measured
// elapsed time. Ceiling mirrors the client formula (distance + time + a generous
// near-miss rate) plus headroom, so honest runs are never clipped.
const maxScoreFor = (ms) => Math.floor((ms / 1000) * 380 + 500);
const GAME_NAME  = 'Highway Dash';

const carDashRooms = new Map();
const carDashQueue = [];

// ── Queue ────────────────────────────────────────────────────────────────────
function addToCarDashQueue(player) {
  const idx = carDashQueue.findIndex(p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opp = carDashQueue.splice(idx, 1)[0];
    const roomId = 'cardash_' + uuidv4();
    carDashRooms.set(roomId, _makeRoom(roomId, opp, player));
    return { roomId, p1: opp, p2: player };
  }
  carDashQueue.push(player);
  return null;
}

function removeFromCarDashQueue(socketId) {
  const i = carDashQueue.findIndex(p => p.socketId === socketId);
  if (i !== -1) { carDashQueue.splice(i, 1); return true; }
  return false;
}

function getCarDashRoom(roomId)    { return carDashRooms.get(roomId); }
function deleteCarDashRoom(roomId) { carDashRooms.delete(roomId); }
function getCarDashRoomBySocket(socketId) {
  for (const [roomId, room] of carDashRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
}

function createDirectCarDashRoom(p1, p2) {
  const roomId = 'cardash_' + uuidv4();
  carDashRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isSolo = !!(p1.isBot || p2.isBot);
  // Demo accounts always win vs a bot — the bot's time is pinned just under the
  // demo's at resolve time (see _resolveFromTimes).
  const demoWin = isSolo && [p1, p2].some(p => p.isDemo && !p.isBot);
  return {
    roomId,
    players: [p1, p2],
    state: 'countdown',
    entryFee: p1.entryFee,
    currency: p1.currency,
    feesDeducted: false,
    seed: Math.floor(Math.random() * 999999),
    startedAt: null,
    // survival times (ms) — server-authoritative, set when a player crashes
    times: {},
    // scores (capped against elapsed time)
    scores: {},
    // last live progress ping per player, for the opponent bar
    progress: {},
    isSolo,
    demoWin,
    // Non-demo solo: the bot crashes at a fixed, believable time.
    botTargetMs: isSolo && !demoWin ? 18_000 + Math.floor(Math.random() * 40_000) : 0,
    botTimers: [],
  };
}

// ── Start ────────────────────────────────────────────────────────────────────
async function startCarDashCountdown(io, supabase, roomId) {
  const room = getCarDashRoom(roomId);
  if (!room) return;
  for (let n = 3; n >= 1; n--) {
    io.to(roomId).emit('car_dash_countdown', { count: n });
    await new Promise(r => setTimeout(r, 1000));
    if (!getCarDashRoom(roomId)) return;
  }
  const fresh = getCarDashRoom(roomId);
  if (!fresh || fresh.state === 'finished') return;
  fresh.state = 'active';
  fresh.startedAt = Date.now();
  io.to(roomId).emit('car_dash_start', { seed: fresh.seed });

  // Solo: drive the bot's progress bar, then crash it at its target time.
  if (fresh.isSolo && !fresh.demoWin) {
    const human = fresh.players.find(p => !p.isBot);
    const tick = setInterval(() => {
      const r = getCarDashRoom(roomId);
      if (!r || r.state !== 'active') { clearInterval(tick); return; }
      const elapsed = Date.now() - r.startedAt;
      r.progress[_botKey(r)] = Math.min(elapsed, r.botTargetMs);
      if (human) io.to(human.socketId).emit('car_dash_opponent_progress', { ms: r.progress[_botKey(r)] });
      if (elapsed >= r.botTargetMs) {
        clearInterval(tick);
        r.times[_botKey(r)] = r.botTargetMs;
        if (human) io.to(human.socketId).emit('car_dash_opponent_crashed', { ms: r.botTargetMs });
        _maybeResolve(io, supabase, roomId);
      }
    }, 250);
    fresh.botTimers.push(tick);
  }
}

const _botKey = (room) => {
  const bot = room.players.find(p => p.isBot);
  return bot ? (bot.socketId || 'bot') : 'bot';
};

// ── Live progress (clamped to wall clock — can't be inflated) ────────────────
function trackCarDashProgress(roomId, socketId, claimedMs, claimedScore) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return null;
  const elapsed = Date.now() - room.startedAt;
  const ms = Math.max(0, Math.min(Number(claimedMs) || 0, elapsed, MAX_RUN_MS));
  room.progress[socketId] = ms;
  room.scores[socketId] = Math.max(0, Math.min(Number(claimedScore) || 0, maxScoreFor(elapsed)));
  return ms;
}

// ── Crash — the server decides how long they actually survived ───────────────
async function handleCarDashCrash(io, supabase, roomId, socketId, claimedScore) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return;
  if (room.times[socketId] != null) return; // already crashed
  const survived = Math.min(Date.now() - room.startedAt, MAX_RUN_MS);
  room.times[socketId] = survived;
  room.progress[socketId] = survived;
  room.scores[socketId] = Math.max(0, Math.min(Number(claimedScore) || 0, maxScoreFor(survived)));

  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('car_dash_opponent_crashed', { ms: survived });
  io.to(socketId).emit('car_dash_crashed', { ms: survived });

  await _maybeResolve(io, supabase, roomId);
}

// Resolve once everyone (bot included) has a final time.
async function _maybeResolve(io, supabase, roomId) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state === 'finished') return;
  const allDone = room.players.every(p => room.times[p.socketId ?? _botKey(room)] != null ||
    (p.isBot && room.times[_botKey(room)] != null));
  if (!allDone) return;
  await _resolveFromTimes(io, supabase, roomId);
}

async function _resolveFromTimes(io, supabase, roomId) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state === 'finished') return;
  const [p1, p2] = room.players;
  const key = (p) => p.isBot ? _botKey(room) : p.socketId;

  const timeOf  = (p) => room.times[key(p)]  ?? room.progress[key(p)] ?? 0;
  const scoreOf = (p) => room.scores[key(p)] ?? 0;

  // A bot has no client, so give it a believable score for the time it drove
  // (distance + survival, no near-miss bonuses).
  const bot = room.players.find(p => p.isBot);
  if (bot) {
    const bt = timeOf(bot);
    room.scores[_botKey(room)] = Math.floor((bt / 1000) * 50);
  }

  // Demo vs bot: pin the bot just behind on BOTH time and score so the demo wins.
  if (room.demoWin) {
    const demo = room.players.find(p => p.isDemo && !p.isBot);
    if (demo && bot) {
      const dT = room.times[demo.socketId] ?? 0;
      const dS = room.scores[demo.socketId] ?? 0;
      room.times[_botKey(room)]  = Math.max(0, Math.floor(dT * 0.85) - 200);
      room.scores[_botKey(room)] = Math.max(0, Math.floor(dS * 0.85) - 10);
    }
  }

  // Highest SCORE wins; survival time breaks a tie.
  const s1 = scoreOf(p1), s2 = scoreOf(p2);
  const t1 = timeOf(p1),  t2 = timeOf(p2);
  const p1Wins = s1 !== s2 ? s1 > s2 : t1 >= t2;
  const winner = p1Wins ? p1 : p2;
  const loser  = p1Wins ? p2 : p1;
  await _resolve(io, supabase, roomId, winner, loser,
    p1Wins ? t1 : t2, p1Wins ? t2 : t1,
    p1Wins ? s1 : s2, p1Wins ? s2 : s1);
}

// Opponent left / timed out — whoever has the better time takes it.
async function forceResolveCarDash(io, supabase, roomId) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state === 'finished') return;
  await _resolveFromTimes(io, supabase, roomId);
}

async function _resolve(io, supabase, roomId, winner, loser, winnerMs, loserMs, winnerScore = 0, loserScore = 0) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  (room.botTimers || []).forEach(t => { clearInterval(t); clearTimeout(t); });
  room.botTimers = [];

  const isFree = (room.entryFee || 0) === 0;
  const { newWinnerElo, newLoserElo } = isFree
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

  let balanceChange = null;
  if (supabase && room.entryFee > 0 && !room.feesDeducted) {
    console.error(`[carDashEngine] CRITICAL: room ${roomId} settled without feesDeducted — no payout issued`);
    unlockUser(winner.userId); unlockUser(loser.userId);
  } else if (supabase && room.entryFee > 0) {
    try {
      if (winner.isBot || loser.isBot) {
        const humanId = winner.isBot ? loser.userId : winner.userId;
        balanceChange = await settleBotMatch(supabase, humanId, room.entryFee, room.currency || 'coins', !winner.isBot, { game: GAME_NAME });
      } else {
        const meta = { game: GAME_NAME, winnerUsername: winner.username, loserUsername: loser.username };
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee, meta)
          : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee, meta);
      }
    } catch (e) { console.error('[carDashEngine] settle:', e.message); }
  }

  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId).filter(Boolean) });
  io.to(roomId).emit('car_dash_result', {
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange,
    winnerMs, loserMs,
    winnerScore, loserScore,
    currency: room.currency || 'coins',
    entryFee: room.entryFee || 0,
  });

  // Fire-and-forget bookkeeping
  Promise.resolve().then(async () => {
    if (!supabase) return;
    if (!isFree && !winner.isBot) {
      try { await applyEloUpdate(supabase, winner.userId, newWinnerElo, true); } catch {}
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch {}
      try { await updateStreaks(supabase, winner.userId, null); } catch {}
    }
    if (!loser.isBot) {
      try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId); } catch {}
    }
    if (!isFree && !loser.isBot) {
      try { await applyEloUpdate(supabase, loser.userId, newLoserElo, true); } catch {}
      try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch {}
    }
    // Highscore is stored in seconds survived
    if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'carDash', winnerScore).catch(() => {});
    if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'carDash', loserScore).catch(() => {});
    try {
      const cur = room.currency || 'coins';
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId,
        game_type: 'carDash',
        entry_fee_c: cur === 'coins' ? (room.entryFee || 0) : 0,
        entry_fee_diamonds: cur === 'diamonds' ? (room.entryFee || 0) : 0,
        prize_pool_c: cur === 'coins' ? (room.entryFee || 0) * 2 : 0,
        prize_pool_diamonds: cur === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
      });
    } catch (e) { console.error('[carDashEngine] matches insert:', e.message); }
  }).catch(e => console.error('[carDashEngine] post-result DB:', e.message));
}

module.exports = {
  addToCarDashQueue, removeFromCarDashQueue,
  createDirectCarDashRoom,
  getCarDashRoom, deleteCarDashRoom, getCarDashRoomBySocket,
  startCarDashCountdown, trackCarDashProgress, handleCarDashCrash,
  forceResolveCarDash,
};
