// Outcomes that decide real money use the crypto RNG, not Math.random.
// See the note at the top of carDashEngine — a shared level seed is a live
// edge, so it comes from crypto.randomInt.
const { randomInt } = require('node:crypto');
const { closestByElo } = require('./queueMatch');
const { findRoomBySocket } = require('./roomLookup');
/**
 * colorRushEngine.js — "Color Rush"
 *
 * Tap to fly a ball up through spinning obstacles. You may only pass through
 * the part of an obstacle matching your current color; touching any other
 * color ends the run. White diamonds inside the obstacles are worth a point
 * each, and the highest score wins.
 *
 * Both players climb the SAME seeded course, so the only variable is
 * execution — the same property Rush Hour and Block Burst rely on, and the
 * one that makes this defensible as a game of skill.
 *
 * Anti-cheat: the score is the diamond count, which is computed on the client,
 * so the server clamps it against its OWN measurement of elapsed time (see
 * maxScoreFor). The client only reports "I died"; the server timestamps that
 * against the match start, so a claimed survival time can never exceed real
 * elapsed time.
 *
 * This is deliberately a near-twin of carDashEngine. The two games share a
 * shape — seeded course, score race, one player dies and the other gets a
 * fixed window to beat them — and the differences that matter are the score
 * ceiling and the wording. Keeping them structurally identical means a fix to
 * the settlement path in one is a mechanical port to the other, which is how
 * the double-ELO bug got fixed everywhere rather than in one engine.
 */
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { unlockUser } = require('./lockService');
const { calculateNewRatings, applyMatchStreaks, applyEloUpdate, freshRatings } = require('./eloService');
const { updateHighscore } = require('./highscoreService');
const gameEvents = require('./gameEvents');
const { v4: uuidv4 } = require('uuid');

const MAX_RUN_MS = 15 * 60_000; // sanity ceiling — no run is 15 minutes
const STALL_MS   = 15_000;
// When a player dies while AHEAD, the survivor gets this long to beat their
// score. Same 15 seconds as every other game here, deliberately.
const CATCHUP_MS = 15_000;
// Survive at least this long to beat a bot, so a wagered bot game cannot be
// won by dying immediately. Mirrors carDashEngine's BOT_WIN_MIN_MS.
const BOT_WIN_MIN_MS = 20_000;
const WATCH_MS   = 2_000;

// ── Anti-cheat score ceiling ────────────────────────────────────────────────
// Score is one point per diamond, and there is exactly one diamond per
// obstacle, so the ceiling is "how fast could a perfect player possibly clear
// obstacles?"
//
//   obstacle spacing        950 world units (client OBSTACLE_GAP)
//   fastest possible climb  ~350 u/s (tapping again the instant the arc peaks)
//   => 0.37 obstacles/second, and only if the player never once waits inside
//      an obstacle for their color to come round — which they now always must,
//      because the way out has to be matched as well as the way in
//
// The cap is 1.5/s — four times the theoretical maximum,
// because clipping an honest player is far worse than a loose bound on a
// cheater: a clipped score loses a match that was actually won. It was 6/s
// when obstacles were 480 apart and only the entry had to be matched; the
// course has since slowed down a lot, and a bound that no longer bears any
// relation to the game is not really a bound.
const SCORE_RATE_CAP = 1.5;    // diamonds per second, see derivation above
const maxScoreFor = (ms) => Math.floor((ms / 1000) * SCORE_RATE_CAP + 5);
const GAME_NAME  = 'Color Rush';

const colorRushRooms = new Map();
const colorRushQueue = [];

// ── Queue ────────────────────────────────────────────────────────────────────
function addToColorRushQueue(player) {
  const idx = closestByElo(colorRushQueue, player, p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opp = colorRushQueue.splice(idx, 1)[0];
    const roomId = 'colorrush_' + uuidv4();
    colorRushRooms.set(roomId, _makeRoom(roomId, opp, player));
    return { roomId, p1: opp, p2: player };
  }
  colorRushQueue.push(player);
  return null;
}

function removeFromColorRushQueue(socketId) {
  const i = colorRushQueue.findIndex(p => p.socketId === socketId);
  if (i !== -1) { colorRushQueue.splice(i, 1); return true; }
  return false;
}

function getColorRushRoom(roomId)    { return colorRushRooms.get(roomId); }
function deleteColorRushRoom(roomId) { colorRushRooms.delete(roomId); }
// Prefers a live room over a settled-but-not-yet-swept one. See roomLookup.
function getColorRushRoomBySocket(socketId) {
  return findRoomBySocket(colorRushRooms, socketId);
}

function createDirectColorRushRoom(p1, p2) {
  const roomId = 'colorrush_' + uuidv4();
  colorRushRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isSolo = !!(p1.isBot || p2.isBot);
  // A free bot game is practice, not a match — nothing staked, nothing to win.
  const soloRun = isSolo && !(parseFloat(p1.entryFee) > 0);
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
    times: {},        // survival ms — server-authoritative
    scores: {},        // diamonds collected, clamped against elapsed time
    progress: {},      // last live ping, for the opponent bar
    lastPingAt: {},
    catchupTimer: null, catchupTarget: null, catchupEndsAt: null,
    isSolo,
    soloRun,
    demoWin,
    botTargetMs: isSolo && !demoWin ? 18_000 + Math.floor(Math.random() * 40_000) : 0,
    botTimers: [],
  };
}

// ── Start ────────────────────────────────────────────────────────────────────
async function startColorRushCountdown(io, supabase, roomId) {
  const room = getColorRushRoom(roomId);
  if (!room) return;
  for (let n = 3; n >= 1; n--) {
    io.to(roomId).emit('color_rush_countdown', { count: n });
    await new Promise(r => setTimeout(r, 1000));
    if (!getColorRushRoom(roomId)) return;
  }
  const fresh = getColorRushRoom(roomId);
  if (!fresh || fresh.state === 'finished') return;
  fresh.state = 'active';
  fresh.startedAt = Date.now();
  for (const p of fresh.players) if (!p.isBot) fresh.lastPingAt[p.socketId] = Date.now();
  io.to(roomId).emit('color_rush_start', { seed: fresh.seed });

  // Watchdog: no match may hang forever waiting on a client that stops talking.
  const watch = setInterval(() => {
    const r = getColorRushRoom(roomId);
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
      if (r.isSolo) {
        clearInterval(watch);
        _resolveFromTimes(io, supabase, roomId).catch(() => {});
        return;
      }
      // A stalled player is treated exactly as if they had died: their run ends
      // at their last verified progress and THEIR OPPONENT PLAYS ON. Resolving
      // the whole match here would let a player who is ahead background the tab
      // to deny the opponent their catch-up window. Leaving must never be
      // better than playing — see the same note in carDashEngine.
      _maybeResolve(io, supabase, roomId).catch(() => {});
      checkColorRushOvertake(io, supabase, roomId).catch(() => {});
    }
    if (now - r.startedAt > MAX_RUN_MS) {
      clearInterval(watch);
      forceResolveColorRush(io, supabase, roomId).catch(() => {});
    }
  }, WATCH_MS);
  fresh.botTimers.push(watch);

  // Solo / bot: the bot trails the player and never dies on its own.
  if (fresh.isSolo) {
    const human = fresh.players.find(p => !p.isBot);
    const tick = setInterval(() => {
      const r = getColorRushRoom(roomId);
      if (!r || r.state !== 'active') { clearInterval(tick); return; }
      const elapsed = Date.now() - r.startedAt;
      const trail = Math.max(0, Math.floor(elapsed * 0.85));
      r.progress[_botKey(r)] = trail;
      if (human) io.to(human.socketId).emit('color_rush_opponent_progress', { ms: trail });
    }, 250);
    fresh.botTimers.push(tick);
  }
}

const _botKey = (room) => {
  const bot = room.players.find(p => p.isBot);
  return bot ? (bot.socketId || 'bot') : 'bot';
};

// Only a player IN this room may act on it. See the note in carDashEngine:
// the socket id cannot be spoofed, but without this an outsider could still
// write into another room's score and timing maps.
function _isPlayer(room, socketId) {
  return !!room && Array.isArray(room.players)
    && room.players.some(p => p.socketId === socketId);
}

// ── Live progress (clamped to wall clock — can't be inflated) ────────────────
function trackColorRushProgress(roomId, socketId, claimedMs, claimedScore) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return null;
  if (!_isPlayer(room, socketId)) return null;
  // Already finalised — by a stall, a death or a dropped connection. Their run
  // is over, so late pings must not revive it or move their score.
  if (room.times[socketId] != null) return null;
  const elapsed = Date.now() - room.startedAt;
  const ms = Math.max(0, Math.min(Number(claimedMs) || 0, elapsed, MAX_RUN_MS));
  room.progress[socketId] = ms;
  room.lastPingAt[socketId] = Date.now();
  room.scores[socketId] = Math.max(0, Math.min(Number(claimedScore) || 0, maxScoreFor(elapsed)));
  return ms;
}

// ── Death — the server decides how long they actually survived ───────────────
async function handleColorRushDeath(io, supabase, roomId, socketId, claimedScore) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return;
  if (!_isPlayer(room, socketId)) return;
  if (room.times[socketId] != null) return; // already died
  const survived = Math.min(Date.now() - room.startedAt, MAX_RUN_MS);
  room.times[socketId] = survived;
  room.progress[socketId] = survived;
  room.scores[socketId] = Math.max(0, Math.min(Number(claimedScore) || 0, maxScoreFor(survived)));

  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('color_rush_opponent_died', { ms: survived });
  io.to(socketId).emit('color_rush_died', { ms: survived });

  // Solo / bot: end immediately — no waiting on a bot.
  if (room.isSolo && !room.players.find(p => p.socketId === socketId)?.isBot) {
    (room.botTimers || []).forEach(t => clearInterval(t));
    room.botTimers = [];
    await _resolveFromTimes(io, supabase, roomId);
    return;
  }

  await _maybeResolve(io, supabase, roomId);
  _armCatchup(io, supabase, roomId);
}

// The survivor is chasing a score that can no longer move. Give them a fixed
// window to beat it rather than letting the match run on forever.
function _armCatchup(io, supabase, roomId) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state !== 'active' || room.catchupTimer) return;
  if (room.players.length !== 2) return;

  const key = (p) => (p.isBot ? _botKey(room) : p.socketId);
  const out = room.players.filter(p => room.times[key(p)] != null);
  if (out.length !== 1) return;                       // nobody out, or both

  const dead = out[0];
  const alive = room.players.find(p => p !== dead);
  if (!alive || alive.isBot) return;

  const target = room.scores[key(dead)] ?? 0;
  // Already ahead? Nothing to chase — checkColorRushOvertake ends it instead.
  if ((room.scores[key(alive)] ?? 0) > target) return;

  room.catchupTarget = target;
  room.catchupEndsAt = Date.now() + CATCHUP_MS;
  io.to(alive.socketId).emit('color_rush_catchup', {
    seconds: CATCHUP_MS / 1000,
    targetScore: target,
  });

  room.catchupTimer = setTimeout(async () => {
    const r = getColorRushRoom(roomId);
    if (!r || r.state !== 'active') return;
    r.catchupTimer = null;
    const k = (p) => (p.isBot ? _botKey(r) : p.socketId);
    if (r.times[k(alive)] == null) {
      r.times[k(alive)] = Math.min(Date.now() - r.startedAt, MAX_RUN_MS);
      r.progress[k(alive)] = r.times[k(alive)];
    }
    await _resolveFromTimes(io, supabase, roomId).catch(() => {});
  }, CATCHUP_MS);
  // Registered so the central cleanup in _resolve clears it — otherwise a match
  // that ends early leaves a timer firing into a finished room.
  (room.botTimers ||= []).push(room.catchupTimer);
}

// One player is out, the other is still climbing. The moment the survivor's
// score passes the dead player's, the match is decided — their score can only
// climb, so nothing afterwards can lose it.
//
// Equal scores deliberately do NOT end it: the tiebreak is survival time, and
// the survivor is still adding to theirs.
async function checkColorRushOvertake(io, supabase, roomId) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return;
  if (room.players.length !== 2) return;
  const key = (p) => (p.isBot ? _botKey(room) : p.socketId);
  const out = room.players.filter(p => room.times[key(p)] != null);
  if (out.length !== 1) return;
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
  const room = getColorRushRoom(roomId);
  if (!room || room.state === 'finished') return;
  const allDone = room.players.every(p => room.times[p.socketId ?? _botKey(room)] != null ||
    (p.isBot && room.times[_botKey(room)] != null));
  if (!allDone) return;
  await _resolveFromTimes(io, supabase, roomId);
}

async function _resolveFromTimes(io, supabase, roomId) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state === 'finished' || room.resolving) return;
  // CLAIM the room here, synchronously, before the first await below.
  // See carDashEngine: every settlement entry point funnels through this
  // function, and two of them landing in the same tick both passed a
  // check-only guard and applied ELO twice — a +22 win written twice reads as
  // +44. The flag is separate from state='finished' because the soloRun branch
  // and _resolve itself still need to see a live room.
  room.resolving = true;
  const [p1, p2] = room.players;
  const key = (p) => p.isBot ? _botKey(room) : p.socketId;

  const timeOf  = (p) => room.times[key(p)]  ?? room.progress[key(p)] ?? 0;
  const scoreOf = (p) => room.scores[key(p)] ?? 0;

  // A bot has no client, so give it a believable diamond count for the time it
  // survived — roughly one per second and a half.
  const bot = room.players.find(p => p.isBot);
  if (bot && room.scores[_botKey(room)] == null) {
    const bt = timeOf(bot);
    room.scores[_botKey(room)] = Math.floor(bt / 1500);
  }

  // Bot rooms: the bot has no real run, so its time and score are pinned either
  // side of the human's depending on whether they cleared BOT_WIN_MIN_MS.
  // Without the floor a wagered bot game paid out on a two-second run.
  if (room.isSolo && bot) {
    const human = room.players.find(p => !p.isBot);
    if (human) {
      const hT = room.times[human.socketId] ?? room.progress[human.socketId] ?? 0;
      const hS = room.scores[human.socketId] ?? 0;
      const cleared = room.demoWin || hT >= BOT_WIN_MIN_MS;
      if (cleared) {
        room.times[_botKey(room)]  = Math.max(0, Math.floor(hT * 0.85) - 200);
        room.scores[_botKey(room)] = Math.max(0, hS - 1);
      } else {
        // Pinned ahead on BOTH, since score decides and time breaks a tie —
        // setting only one would let a short high-scoring run still win.
        room.times[_botKey(room)]  = hT + 1_000;
        room.scores[_botKey(room)] = hS + 2;
      }
    }
  }

  // A practice run just reports how it went — nothing staked, nothing settled.
  if (room.soloRun) {
    const human = room.players.find(p => !p.isBot);
    if (human) {
      room.state = 'finished';
      const ms    = room.times[human.socketId] ?? room.progress[human.socketId] ?? 0;
      const score = room.scores[human.socketId] ?? 0;
      (room.botTimers || []).forEach(t => clearInterval(t));
      // Score only — Color Rush does not keep a time stat. Elapsed time is
      // still measured server-side for the anti-cheat clamp, the catch-up
      // window and to break an exact tie, but it is not something the player
      // is playing for and it is not recorded.
      try { await updateHighscore(supabase, human.userId, 'colorRush', score); } catch {}
      unlockUser(human.userId);
      io.emit('active_game_ended', { id: roomId });
      gameEvents.emit('game_ended', { socketIds: [human.socketId] });
      setTimeout(() => deleteColorRushRoom(roomId), 5_000);
      io.to(roomId).emit('color_rush_result', { soloRun: true, ms, score });
    }
    return;
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

/**
 * A player's connection dropped mid-run.
 *
 * This ends their RUN at the score the server has already verified — it does
 * NOT forfeit the match. The distinction matters because of what actually
 * happens on a phone: switching apps suspends the page, and the socket goes
 * with it. Treating that as "you lose" makes a staked match hinge on a phone
 * call, while treating it as "you stopped scoring there" costs the player
 * exactly the time they were away and nothing more.
 *
 * It is only fair because the opponent is never blocked. Both players climb
 * their own copy of the same course at the same time, so there is nobody
 * waiting on a turn: the survivor plays on and gets the usual catch-up window
 * against a score that can no longer move.
 *
 * Returns true when it has taken responsibility for the room, so the caller
 * knows not to run the generic forfeit.
 */
function endRunOnDisconnect(io, supabase, roomId, socketId) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state !== 'active' || !room.startedAt) return false;
  if (!_isPlayer(room, socketId)) return false;
  if (room.times[socketId] != null) return false;   // already out
  // A bot room has no second human to carry on, so let the generic forfeit
  // handle it rather than resolving a match against an opponent that is not
  // really there.
  if (room.isSolo) return false;

  const verified = Math.min(room.progress[socketId] ?? 0, Date.now() - room.startedAt, MAX_RUN_MS);
  room.times[socketId] = verified;

  const opp = room.players.find(p => p.socketId !== socketId);
  if (opp && !opp.isBot) io.to(opp.socketId).emit('color_rush_opponent_died', { ms: verified });

  _maybeResolve(io, supabase, roomId).catch(() => {});
  _armCatchup(io, supabase, roomId);
  checkColorRushOvertake(io, supabase, roomId).catch(() => {});
  return true;
}

// Opponent left / timed out — whoever has the better score takes it.
async function forceResolveColorRush(io, supabase, roomId) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state === 'finished') return;
  await _resolveFromTimes(io, supabase, roomId);
}

async function _resolve(io, supabase, roomId, winner, loser, winnerMs, loserMs, winnerScore = 0, loserScore = 0) {
  const room = getColorRushRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  (room.botTimers || []).forEach(t => { clearInterval(t); clearTimeout(t); });
  room.botTimers = [];

  const isFree = (room.entryFee || 0) === 0;
  // ELO / W-L only count when there's something at stake or a real opponent.
  const vsBot = !!(winner.isBot || loser.isBot);
  const ranked = !isFree || !vsBot;
  // Ratings computed from CURRENT profile values, not the elo cached on the
  // socket at queue time — see freshRatings.
  const { newWinnerElo, newLoserElo, winnerBefore, loserBefore } = ranked
    ? await freshRatings(supabase, winner, loser)
    : { newWinnerElo: null, newLoserElo: null, winnerBefore: null, loserBefore: null };

  let balanceChange = null;
  if (supabase && room.entryFee > 0 && !room.feesDeducted) {
    console.error(`[colorRushEngine] CRITICAL: room ${roomId} settled without feesDeducted — no payout issued`);
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
    } catch (e) { console.error('[colorRushEngine] settle:', e.message); }
  }

  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId).filter(Boolean) });
  setTimeout(() => deleteColorRushRoom(roomId), 5_000);
  io.to(roomId).emit('color_rush_result', {
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange,
    // The ratings these were computed FROM — the result card needs them to show
    // a true delta, since its own baseline goes stale by settlement.
    winnerBefore, loserBefore,
    vsBot,
    winnerMs, loserMs,
    winnerScore, loserScore,
    currency: room.currency || 'coins',
    entryFee: room.entryFee || 0,
  });

  // Fire-and-forget bookkeeping
  Promise.resolve().then(async () => {
    if (!supabase) return;
    if (!winner.isBot) {
      if (ranked) { try { await applyEloUpdate(supabase, winner.userId, newWinnerElo, true); } catch {} }
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch {}
      try { await applyMatchStreaks(supabase, winner, loser); } catch {}
    }
    if (!loser.isBot) {
      if (ranked) { try { await applyEloUpdate(supabase, loser.userId, newLoserElo, true); } catch {} }
      try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch {}
    }
    if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'colorRush', winnerScore).catch(() => {});
    if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'colorRush', loserScore).catch(() => {});
    try {
      const cur = room.currency || 'coins';
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot ? null : loser.userId,
        winner_id: winner.isBot ? null : winner.userId,
        game_type: 'colorRush',
        entry_fee_c: cur === 'coins' ? (room.entryFee || 0) : 0,
        entry_fee_diamonds: cur === 'diamonds' ? (room.entryFee || 0) : 0,
        prize_pool_c: cur === 'coins' ? (room.entryFee || 0) * 2 : 0,
        prize_pool_diamonds: cur === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
      });
    } catch (e) { console.error('[colorRushEngine] matches insert:', e.message); }
  }).catch(e => console.error('[colorRushEngine] post-result DB:', e.message));
}

module.exports = {
  addToColorRushQueue, removeFromColorRushQueue,
  createDirectColorRushRoom,
  getColorRushRoom, deleteColorRushRoom, getColorRushRoomBySocket,
  startColorRushCountdown, trackColorRushProgress, handleColorRushDeath,
  forceResolveColorRush,
  checkColorRushOvertake,
  endRunOnDisconnect,
  // Exported so tests assert against the real ceiling instead of a copy of the
  // number, which goes stale the moment the spacing or climb rate changes.
  SCORE_RATE_CAP,
};
