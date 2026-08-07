// Outcomes that decide real money use the crypto RNG, not Math.random.
// V8's Math.random is a fast non-cryptographic PRNG: an attacker who can watch
// enough results can recover its internal state and predict the next ones. For
// a coin flip, a shuffled deck or a shared level seed that is a live edge, so
// these use crypto.randomInt instead. Cosmetic randomness elsewhere (bot names,
// timing jitter) is deliberately left alone.
const { randomInt } = require('node:crypto');
/**
 * carDashEngine.js — "Rush Hour"
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
const { updateHighscorePair } = require('./highscoreService');
const gameEvents = require('./gameEvents');
const { v4: uuidv4 } = require('uuid');

const MAX_RUN_MS = 15 * 60_000; // sanity ceiling — no run is 15 minutes
// A live client pings progress ~3x/second. If pings stop while the player is
// still "alive" they have either closed/frozen the tab (backgrounding is the
// remaining way to pause a run) or are running a client that never reports a
// crash — or switched apps on a phone, which suspends the animation loop and
// therefore the progress pings entirely. Either way the opponent must not be
// left hanging: after STALL_MS we
// finalise that player at their last verified progress.
const STALL_MS   = 15_000;
// When a player crashes while AHEAD, the survivor gets this long to beat their
// score. Pass it and they win immediately; let it run out and they lose. Before
// this the survivor could drive indefinitely, so a match had no defined end.
const CATCHUP_MS = 15_000;
const WATCH_MS   = 2_000;
// Anti-cheat: score is client-computed, so it is capped against server-measured
// elapsed time. Ceiling mirrors the client formula (distance + time + a generous
// near-miss rate) plus headroom, so honest runs are never clipped.
// ── Anti-cheat score ceiling ────────────────────────────────────────────────
// Score is computed on the client, so the server clamps it against elapsed time.
// The ceiling is derived from the client's own scoring constants rather than
// picked by feel, so the two cannot drift apart:
//
//   distance   PTS_DIST(0.06) x top speed(1450 + 780*5.0 = 5350)  = 321/s
//   survival   PTS_TIME                                           =   8/s
//   near miss  NEAR_RATE(1.5/s) x PTS_NEAR(75) x COMBO_MAX(10)    = 1125/s
//
// The near-miss term is what forced this up. At the old 380/s, distance alone at
// top speed was already 329/s — 87% of the ceiling — so once the combo cap went
// to 10 a skilled player chaining near misses would have had their score
// silently clipped and lost matches they had actually won. Clipping an honest
// player is far worse than a looser bound on a cheater, and the clamp still
// holds a fabricated score to something proportional to time played.
//
// NEAR_RATE is the one estimate here: 1.5 near misses a second is generous for
// real play, since each one needs the player lined up behind a car first. If the
// combo ceiling or the speed ramp changes again, revisit this.
const SCORE_RATE_CAP = 1500;   // points per second, see derivation above
const maxScoreFor = (ms) => Math.floor((ms / 1000) * SCORE_RATE_CAP + 500);
const GAME_NAME  = 'Rush Hour';

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
    seed: randomInt(1000000),
    startedAt: null,
    // survival times (ms) — server-authoritative, set when a player crashes
    times: {},
    // scores (capped against elapsed time)
    scores: {},
    // last live progress ping per player, for the opponent bar
    progress: {},
    lastPingAt: {},   // socketId -> ms, for the stall watchdog
    catchupTimer: null, catchupTarget: null, catchupEndsAt: null,
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
  for (const p of fresh.players) if (!p.isBot) fresh.lastPingAt[p.socketId] = Date.now();
  io.to(roomId).emit('car_dash_start', { seed: fresh.seed });

  // Watchdog: no match may hang forever waiting on a client that stops talking.
  const watch = setInterval(() => {
    const r = getCarDashRoom(roomId);
    if (!r || r.state !== 'active') { clearInterval(watch); return; }
    const now = Date.now();
    let stalled = false;
    for (const p of r.players) {
      if (p.isBot || r.times[p.socketId] != null) continue;
      const last = r.lastPingAt[p.socketId] ?? r.startedAt;
      if (now - last > STALL_MS) {
        // Finalise at their last verified progress — never at a claimed value.
        r.times[p.socketId] = Math.min(r.progress[p.socketId] ?? 0, now - r.startedAt, MAX_RUN_MS);
        stalled = true;
      }
    }
    if (stalled) {
      // Solo and bot rooms have no second human to wait for, and the bot only
      // gets a final time when the PLAYER crashes. So _maybeResolve below would
      // wait forever: the human is finalised, the bot never is, and the room
      // hangs. Switching apps mid-run on a phone hit this every time — the run
      // was already over server-side, so the eventual crash was ignored and the
      // match simply never ended. Pin the bot and settle it here instead.
      if (r.isSolo) {
        clearInterval(watch);
        const human = r.players.find(p => !p.isBot);
        const hT = human ? (r.times[human.socketId] ?? 0) : 0;
        const hS = human ? (r.scores[human.socketId] ?? 0) : 0;
        r.times[_botKey(r)]  = Math.max(0, Math.floor(hT * 0.85) - 200);
        r.scores[_botKey(r)] = Math.max(0, Math.floor(hS * 0.85) - 10);
        _resolveFromTimes(io, supabase, roomId).catch(() => {});
        return;
      }

      // A stalled player is treated exactly as if they had crashed: their run
      // ends at their last verified progress and THEIR OPPONENT PLAYS ON.
      //
      // Resolving the whole match here was an exploit. A player who was ahead
      // could background the tab, and ten seconds later the match settled with
      // the opponent frozen wherever they happened to be — denying them the
      // chance to catch up. Leaving must never be better than playing.
      _maybeResolve(io, supabase, roomId).catch(() => {});
      checkOvertake(io, supabase, roomId).catch(() => {});
    }
    if (now - r.startedAt > MAX_RUN_MS) {
      clearInterval(watch);
      forceResolveCarDash(io, supabase, roomId).catch(() => {});
    }
  }, WATCH_MS);
  fresh.botTimers.push(watch);

  // Solo / bot: the bot just trails the player's progress and never crashes on
  // its own — the run ends the moment the PLAYER crashes, and the player always
  // wins (see handleCarDashCrash). This applies to bot AND demo accounts.
  if (fresh.isSolo) {
    const human = fresh.players.find(p => !p.isBot);
    const tick = setInterval(() => {
      const r = getCarDashRoom(roomId);
      if (!r || r.state !== 'active') { clearInterval(tick); return; }
      const elapsed = Date.now() - r.startedAt;
      const trail = Math.max(0, Math.floor(elapsed * 0.85));
      r.progress[_botKey(r)] = trail;
      if (human) io.to(human.socketId).emit('car_dash_opponent_progress', { ms: trail });
    }, 250);
    fresh.botTimers.push(tick);
  }
}

const _botKey = (room) => {
  const bot = room.players.find(p => p.isBot);
  return bot ? (bot.socketId || 'bot') : 'bot';
};

// Only a player IN this room may act on it.
//
// Every gameplay handler passes the server-assigned socket id, which cannot be
// spoofed, but none of them checked that the socket actually belongs to the room
// named in the message. Winners and payouts were never at risk — all resolution
// is keyed off room.players, so stray entries were ignored — but an outsider
// could still write into the room's score and timing maps, which grows without
// bound, and in Rush Hour could push fabricated progress at a real opponent.
function _isPlayer(room, socketId) {
  return !!room && Array.isArray(room.players)
    && room.players.some(p => p.socketId === socketId);
}

// ── Live progress (clamped to wall clock — can't be inflated) ────────────────
function trackCarDashProgress(roomId, socketId, claimedMs, claimedScore) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return null;
  if (!_isPlayer(room, socketId)) return null;
  const elapsed = Date.now() - room.startedAt;
  const ms = Math.max(0, Math.min(Number(claimedMs) || 0, elapsed, MAX_RUN_MS));
  room.progress[socketId] = ms;
  room.lastPingAt[socketId] = Date.now();
  room.scores[socketId] = Math.max(0, Math.min(Number(claimedScore) || 0, maxScoreFor(elapsed)));
  return ms;
}

// ── Crash — the server decides how long they actually survived ───────────────
async function handleCarDashCrash(io, supabase, roomId, socketId, claimedScore) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return;
  if (!_isPlayer(room, socketId)) return;
  if (room.times[socketId] != null) return; // already crashed
  const survived = Math.min(Date.now() - room.startedAt, MAX_RUN_MS);
  room.times[socketId] = survived;
  room.progress[socketId] = survived;
  room.scores[socketId] = Math.max(0, Math.min(Number(claimedScore) || 0, maxScoreFor(survived)));

  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('car_dash_opponent_crashed', { ms: survived });
  io.to(socketId).emit('car_dash_crashed', { ms: survived });

  // Solo / bot: end immediately with the player ahead — no waiting on a bot.
  if (room.isSolo && !room.players.find(p => p.socketId === socketId)?.isBot) {
    (room.botTimers || []).forEach(t => clearInterval(t));
    room.botTimers = [];
    room.times[_botKey(room)]  = Math.max(0, Math.floor(survived * 0.85) - 200);
    room.scores[_botKey(room)] = Math.max(0, Math.floor((room.scores[socketId] || 0) * 0.85) - 10);
    await _resolveFromTimes(io, supabase, roomId);
    return;
  }

  await _maybeResolve(io, supabase, roomId);
  _armCatchup(io, supabase, roomId);
}

// The survivor is chasing a score that can no longer move. Give them a fixed
// window to beat it rather than letting the match run on forever.
function _armCatchup(io, supabase, roomId) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state !== 'active' || room.catchupTimer) return;
  if (room.players.length !== 2) return;

  const key = (p) => (p.isBot ? _botKey(room) : p.socketId);
  const out = room.players.filter(p => room.times[key(p)] != null);
  if (out.length !== 1) return;                       // nobody out, or both

  const dead = out[0];
  const alive = room.players.find(p => p !== dead);
  if (!alive || alive.isBot) return;

  const target = room.scores[key(dead)] ?? 0;
  // Already ahead? Then there is nothing to chase — checkOvertake ends it on the
  // next ping instead.
  if ((room.scores[key(alive)] ?? 0) > target) return;

  room.catchupTarget = target;
  room.catchupEndsAt = Date.now() + CATCHUP_MS;
  io.to(alive.socketId).emit('car_dash_catchup', {
    seconds: CATCHUP_MS / 1000,
    targetScore: target,
  });

  room.catchupTimer = setTimeout(async () => {
    const r = getCarDashRoom(roomId);
    if (!r || r.state !== 'active') return;
    r.catchupTimer = null;
    // Time is up. Finalise the survivor where they stand — if they had passed
    // the target, checkOvertake would already have ended the match.
    const k = (p) => (p.isBot ? _botKey(r) : p.socketId);
    if (r.times[k(alive)] == null) {
      r.times[k(alive)] = Math.min(Date.now() - r.startedAt, MAX_RUN_MS);
      r.progress[k(alive)] = r.times[k(alive)];
    }
    await _resolveFromTimes(io, supabase, roomId).catch(() => {});
  }, CATCHUP_MS);
  // Registered here so the central cleanup in _resolve clears it — otherwise a
  // match that ends early leaves a timer that fires into a finished room.
  (room.botTimers ||= []).push(room.catchupTimer);
}

// One player is out, the other is still driving. The moment the survivor's
// score passes the score the crashed player finished on, the match is decided —
// nothing the survivor does afterwards can lose it, because the winner is the
// higher score and theirs can only climb. Ending here saves the survivor
// driving out a match they have already won.
//
// Equal scores deliberately do NOT end it: the tiebreak is survival time, and
// the survivor is still adding to theirs, so letting it run costs nothing and
// keeps the rule "more points wins" literally true.
async function checkOvertake(io, supabase, roomId) {
  const room = getCarDashRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return;
  if (room.players.length !== 2) return;
  const key = (p) => (p.isBot ? _botKey(room) : p.socketId);
  const out = room.players.filter(p => room.times[key(p)] != null);
  if (out.length !== 1) return;                     // nobody out yet, or both
  const dead = out[0];
  const alive = room.players.find(p => p !== dead);
  if (!alive) return;
  const deadScore = room.scores[key(dead)] ?? 0;
  const aliveScore = room.scores[key(alive)] ?? 0;
  if (aliveScore <= deadScore) return;
  if (room.catchupTimer) { clearTimeout(room.catchupTimer); room.catchupTimer = null; }
  room.times[key(alive)] = Math.min(Date.now() - room.startedAt, MAX_RUN_MS);
  room.progress[key(alive)] = room.times[key(alive)];
  await _resolveFromTimes(io, supabase, roomId);
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
  if (bot && room.scores[_botKey(room)] == null) {
    const bt = timeOf(bot);
    room.scores[_botKey(room)] = Math.floor((bt / 1000) * 50);
  }

  // Any solo/bot room (including demo accounts): pin the bot just behind on BOTH
  // time and score so the human always wins.
  if (room.isSolo && bot) {
    const human = room.players.find(p => !p.isBot);
    if (human) {
      const hT = room.times[human.socketId] ?? room.progress[human.socketId] ?? 0;
      const hS = room.scores[human.socketId] ?? 0;
      room.times[_botKey(room)]  = Math.max(0, Math.floor(hT * 0.85) - 200);
      room.scores[_botKey(room)] = Math.max(0, Math.floor(hS * 0.85) - 10);
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
  // ELO / W-L only count when there's something at stake or a real opponent:
  // a paid match (any opponent) or PvP. A free run against a bot is practice
  // and must never move your rating.
  const vsBot = !!(winner.isBot || loser.isBot);
  const ranked = !isFree || !vsBot;
  const { newWinnerElo, newLoserElo } = ranked
    ? calculateNewRatings(winner.elo, loser.elo)
    : { newWinnerElo: null, newLoserElo: null };

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
  // Drop the room shortly after settling so finished rooms can't accumulate and
  // can't be re-resolved by a late event.
  setTimeout(() => deleteCarDashRoom(roomId), 5_000);
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
    if (ranked && !winner.isBot) {
      try { await applyEloUpdate(supabase, winner.userId, newWinnerElo, true); } catch {}
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch {}
      try { await updateStreaks(supabase, winner.userId, null); } catch {}
    }
    if (!loser.isBot) {
      try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId); } catch {}
    }
    if (ranked && !loser.isBot) {
      try { await applyEloUpdate(supabase, loser.userId, newLoserElo, true); } catch {}
      try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch {}
    }
    // Highscore is stored in seconds survived
    if (!winner.isBot) await updateHighscorePair(supabase, winner.userId, 'carDash', winnerScore, 'carDashMs', winnerMs).catch(() => {});
    if (!loser.isBot)  await updateHighscorePair(supabase, loser.userId,  'carDash', loserScore, 'carDashMs', loserMs).catch(() => {});
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
  checkOvertake,
};
