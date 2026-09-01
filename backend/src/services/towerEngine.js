// Tower — rooms, queue, scoring and settlement.
//
// Deliberately the same shape as blockBlastEngine: both games are "play your own
// board, higher score wins, the survivor gets a window to beat a finished
// score". Keeping them structurally identical means the forfeit sweep, the room
// lookup and the result card all behave the same way, and a fix to one is
// obviously applicable to the other.
const { randomInt } = require('node:crypto');
const { closestByElo } = require('./queueMatch');
const { findRoomBySocket } = require('./roomLookup');
const { calculateNewRatings, applyMatchStreaks, applyEloUpdate, freshRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { unlockUser } = require('./lockService');
const { v4: uuidv4 } = require('uuid');
const { updateHighscore } = require('./highscoreService');
const gameEvents = require('./gameEvents');

// A score here is a count of blocks, not points, so the numbers are tiny
// compared with Block Burst and the rate limit can be correspondingly tight.
//
// The floor on time-between-drops is real: after a placement the next block
// starts at the far end and has to travel most of the way back before it even
// overlaps the tower. At the capped slide speed that is about a third of a
// second, so ~3 drops/second is the physical maximum. 4/second sustained leaves
// headroom for timing jitter without leaving room to fabricate a run.
const MAX_SCORE            = 100_000;
// The bucket is in POINTS, and a point is no longer a block: a run of perfect
// drops scores up to 10 for one placement. At the physical ceiling of about
// three drops a second that is ~30 points a second, so the old 4/second — sized
// when every block was worth exactly 1 — would have throttled a good run and
// silently capped the very play the multiplier rewards.
//
// Still tied to what is physically possible rather than raised to be
// comfortable: 40/second sustained is three perfect drops a second with
// headroom for jitter, and nothing faster than that can be played.
const MAX_DELTA_PER_PING   = 60;       // burst capacity, in points
const SCORE_REFILL_PER_MS  = 0.04;     // 40 points/second sustained

// How long the surviving player gets to beat a finished score. Same value as
// Block Burst and Rush Hour, so the three do not teach different rules.
const CATCHUP_MS = 15_000;

// Stall watchdog. See the note in blockBlastEngine: Tower also pings only when
// the score changes — one per landed block — so the 15s used by the continuously
// pinging games would end the run of anyone lining up a careful drop. 45s of
// dropping nothing while the opponent plays on is not an accident.
const STALL_MS = 45_000;
const WATCH_MS = 3_000;
const MAX_MATCH_MS = 30 * 60_000;

// Below this standard deviation between drops, a run is suspiciously metronomic.
// Tower takes a single input, which makes it the easiest game here to script.
// This only logs — a good player on an easy stretch can look consistent, and
// nobody should lose a payout to a heuristic.
const ROBOT_STDEV_S  = 0.035;
const ROBOT_MIN_DROPS = 12;

// A diamond bet against the bot has to clear a real floor before it can win.
//
// Same idea as Rush Hour's 25-second minimum: without it the shortest possible
// run is a coin toss against a bot whose score is derived from yours, so the
// cheapest strategy is to drop one block and hope. Fifteen is reachable in well
// under a minute of ordinary play and is not something a single lucky tap
// produces. Coins are untouched — this is the currency that is handed out for
// free, so it is the one worth protecting from a grind.
const DIAMOND_BOT_MIN_SCORE = 15;

const towerRooms = new Map();
const towerQueue = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToTowerQueue(player) {
  const idx = closestByElo(towerQueue, player, p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opp = towerQueue.splice(idx, 1)[0];
    const roomId = 'tw_' + uuidv4();
    towerRooms.set(roomId, _makeRoom(roomId, opp, player));
    return { roomId, p1: opp, p2: player };
  }
  towerQueue.push(player);
  return null;
}

function removeFromTowerQueue(socketId) {
  const i = towerQueue.findIndex(p => p.socketId === socketId);
  if (i !== -1) towerQueue.splice(i, 1);
}

function getTowerRoom(roomId)    { return towerRooms.get(roomId); }
function deleteTowerRoom(roomId) { towerRooms.delete(roomId); }
// Prefers a live room over a settled-but-not-yet-swept one. See roomLookup.
function getTowerRoomBySocket(socketId) {
  return findRoomBySocket(towerRooms, socketId);
}

function createDirectTowerRoom(p1, p2) {
  const roomId = 'tw_' + uuidv4();
  towerRooms.set(roomId, _makeRoom(roomId, p1, p2));
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isSolo    = p1.isBot || p2.isBot;
  const demoHuman = isSolo && [p1, p2].some(p => p.isDemo && !p.isBot);
  return {
    roomId,
    players:      [p1, p2],
    state:        'countdown',
    startTime:    null,
    entryFee:     p1.entryFee,
    currency:     p1.currency,
    scores:       {},          // final, submitted when a run ends
    isSolo,
    demoWin:      demoHuman,
    // How the bot's tower tracks the human's. Above 1 it pulls ahead, below it
    // trails. A demo account always sees the bot trail.
    botRatio:     isSolo
      ? (demoHuman ? (Math.random() * 0.12 + 0.80)
                   : (Math.random() * 0.25 + (Math.random() < 0.45 ? 1.05 : 0.70)))
      : 0,
    pingScores:   {},          // server-tracked, authoritative
    pingTimes:    {},
    scoreBuckets: {},
    botTimers:    [],
    catchupTarget: null,
    catchupTimer:  null,
  };
}

function _isPlayer(room, socketId) {
  return !!room && Array.isArray(room.players)
    && room.players.some(p => p.socketId === socketId);
}

/**
 * Token-bucket clamp on a claimed score. Same mechanism as Block Burst.
 *
 * Rapid-fire pings barely refill the bucket, so spamming them cannot inflate a
 * score; play that happens over real time refills normally. Returns the score
 * the server is willing to believe.
 */
function trackTowerScorePing(roomId, socketId, rawScore) {
  const room = getTowerRoom(roomId);
  if (!room || room.state !== 'active') return null;
  if (!_isPlayer(room, socketId)) return null;

  const now      = Date.now();
  const prev     = room.pingScores[socketId] ?? 0;
  const lastTime = room.pingTimes[socketId]  ?? (room.startTime || now);
  const delta    = (rawScore || 0) - prev;
  const elapsed  = Math.max(0, now - lastTime);

  if (rawScore < prev) return prev;   // a tower cannot get shorter

  const bucketPrev = room.scoreBuckets[socketId] ?? MAX_DELTA_PER_PING;
  const bucket     = Math.min(MAX_DELTA_PER_PING, bucketPrev + elapsed * SCORE_REFILL_PER_MS);
  const grant      = Math.max(0, Math.min(delta, bucket));
  const clamped    = Math.min(prev + grant, MAX_SCORE);

  if (delta > grant) {
    const player = room.players.find(p => p.socketId === socketId);
    console.warn(`[tower] score ping throttled — user:${player?.userId} claimed:${rawScore} prev:${prev} granted:${grant}`);
  }

  room.scoreBuckets[socketId] = bucket - (clamped - prev);
  room.pingScores[socketId]   = clamped;
  room.pingTimes[socketId]    = now;
  return clamped;
}

/**
 * Flags a run whose drops were too evenly spaced to be human.
 *
 * Reported, never enforced. A heuristic that took someone's payout would be
 * worse than the cheating it targets, and this game's whole input is one tap —
 * a decent player on the slow early blocks genuinely looks regular.
 */
function _checkRobotic(room, socketId, taps) {
  if (!Array.isArray(taps) || taps.length < ROBOT_MIN_DROPS) return;
  const gaps = [];
  for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
  const mean  = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const stdev = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  if (stdev >= ROBOT_STDEV_S) return;
  const player = room.players.find(p => p.socketId === socketId);
  console.warn(
    `[tower] SUSPICIOUS RUN — user:${player?.userId} room:${room.roomId} ` +
    `drops:${taps.length} meanGap:${mean.toFixed(3)}s stdev:${stdev.toFixed(4)}s ` +
    `entryFee:${room.entryFee} — inputs are close to metronomic; review before paying out repeatedly`
  );
}

async function startTowerCountdown(io, supabase, roomId) {
  const room = getTowerRoom(roomId);
  if (!room) return;
  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('tower_countdown', { count: i });
    await sleep(1000);
  }
  const current = getTowerRoom(roomId);
  if (!current) return;
  current.state     = 'active';
  current.startTime = Date.now();
  current.supabase  = supabase;

  // The seed does not drive the tower — Tower is deterministic and identical for
  // both players, which is what makes it a fair race. It is sent so the two
  // clients share the same decorative drift, and so the payload matches every
  // other game's start event.
  io.to(roomId).emit('tower_start', { seed: randomInt(1000000) });

  // No match may hang forever waiting on a client that stops playing. Without
  // this, joining a PvP match and never dropping a block held the room 'active'
  // indefinitely: the opponent could play forever without winning, and their
  // only way out was to forfeit and lose the stake.
  const watch = setInterval(() => {
    const r = getTowerRoom(roomId);
    if (!r || r.state !== 'active') { clearInterval(watch); return; }
    const now = Date.now();

    if (now - (r.startTime || now) > MAX_MATCH_MS) {
      clearInterval(watch);
      _resolveFromScores(io, supabase, roomId).catch(() => {});
      return;
    }

    // Solo has no second human to protect; the bot never ends on its own.
    if (r.isSolo) return;

    const live = r.players.filter(p => !p.isBot && r.scores[p.socketId] == null);
    const stalled = live.filter((p) => {
      const last = r.pingTimes[p.socketId] ?? r.startTime ?? now;
      return now - last > STALL_MS;
    });
    if (stalled.length === 0) return;

    if (stalled.length === live.length) {
      // No one left to play on for — settle on the scores as they stand.
      clearInterval(watch);
      for (const p of live) r.scores[p.socketId] = r.pingScores[p.socketId] ?? 0;
      _resolveFromScores(io, supabase, roomId).catch(() => {});
      return;
    }

    // Treated exactly as their run ending: their score is what the server
    // tracked, and their opponent plays on with the normal catch-up window.
    for (const p of stalled) {
      handleTowerComplete(io, supabase, roomId, p.socketId, r.pingScores[p.socketId] ?? 0)
        .catch(() => {});
    }
  }, WATCH_MS);
  current.botTimers.push(watch);

  if (current.isSolo) {
    const human = current.players.find(p => !p.isBot);
    if (human) {
      let botScore = 0;
      const timer = setInterval(() => {
        const r = getTowerRoom(roomId);
        if (!r || r.state !== 'active') { clearInterval(timer); return; }
        const humanScore = r.pingScores[human.socketId] ?? 0;
        const target = Math.floor(humanScore * r.botRatio);
        // One block at a time: a bot tower that jumped four blocks between
        // updates would read as obviously fake next to your own.
        if (target > botScore) botScore = Math.min(target, botScore + 1);
        r.pingScores['bot'] = botScore;
        io.to(human.socketId).emit('tower_opponent_score', { score: botScore });
      }, 1200);
      current.botTimers.push(timer);
    }
  }
}

/**
 * A player's run ended (they missed, or ran out of footprint).
 *
 * `taps` is the timing of every drop, used only for the robotic-run check.
 */
async function handleTowerComplete(io, supabase, roomId, socketId, score = 0, taps = null) {
  const room = getTowerRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (!_isPlayer(room, socketId)) return;

  const verified = room.pingScores[socketId] ?? 0;
  room.scores[socketId] = verified;
  _checkRobotic(room, socketId, taps);
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  // ── Solo (vs bot) ──
  if (room.isSolo) {
    const player = room.players.find(p => !p.isBot);
    if (!player) return;
    room.state = 'finished';

    // A free run is practice: nothing is staked, so there is nothing to lose.
    // Paid bot matches are untouched — real money is on those.
    const freeSolo  = !(room.entryFee > 0);
    const alwaysWin = room.demoWin || freeSolo;
    let botScore = Math.floor(verified * (room.botRatio ?? 0.8));
    if (alwaysWin && botScore >= verified) botScore = Math.max(0, verified - 1);
    // On a diamond bet against the bot the target IS the score: clear
    // DIAMOND_BOT_MIN_SCORE and you win, full stop.
    //
    // This was first written as an extra condition ON TOP of out-scoring the
    // bot, which was wrong and badly so: botRatio sits at 1.05 or higher about
    // 45% of the time, so a 46-block run could lose to a bot placed at 48. The
    // player cleared the stated bar by three times over and was shown a defeat.
    // A rule the player is told ("get 15 to win") has to be the rule that
    // actually decides it.
    const diamondBot = !freeSolo && room.currency === 'diamonds';
    let humanWon;
    if (alwaysWin)        humanWon = true;
    else if (diamondBot)  humanWon = verified >= DIAMOND_BOT_MIN_SCORE;
    else                  humanWon = verified > botScore;

    // Keep the bot's shown score consistent with the outcome, or the card
    // reports one thing on score and another in the headline.
    if (humanWon && botScore >= verified) botScore = Math.max(0, verified - 1);
    if (!humanWon && botScore <= verified) botScore = verified + 1;

    let balanceChange = null;
    // Never pay out a stake that was never taken. Every other engine carries
    // this guard; Tower was the one that did not, even though handlers.js has
    // always set the flag on its rooms. The deduction path cancels the match
    // when it fails, so this should be unreachable — which is exactly why it is
    // worth having, since the unreachable case is the one that would mint coins
    // out of nothing.
    if (room.entryFee > 0 && !room.feesDeducted) {
      console.error(`[towerEngine] CRITICAL: solo room ${roomId} settled without feesDeducted — no payout issued`);
      unlockUser(player.userId);
    } else if (room.entryFee > 0) {
      try {
        balanceChange = await settleBotMatch(
          supabase, player.userId, room.entryFee, room.currency || 'coins', humanWon, { game: 'Tower' });
      } catch (e) { console.error('[tower] solo settle:', e.message); }
    }

    // Rating and record only when the run cost something — an unloseable free
    // run that awarded rating would be an infinite ladder.
    // Reported so the card can show it — a paid bot match rates, in coins or
    // diamonds, and a payload without the number reads as though it does not.
    let humanNewElo = null, eloBefore = null;
    if (supabase && !freeSolo) {
      const BOT_ELO = 1000;
      // Read the CURRENT rating rather than the one cached on the socket when
      // the player joined the queue.
      //
      // calculateNewRatings returns an absolute value, and writing it derived
      // from a stale number produces a delta that is not the gain or loss at
      // all: a socket holding 1020 against a profile of 1000 writes 1020 - 17 =
      // 1003, and the card reports +3 on a defeat. The swing is only ever
      // eloGain or eloLoss when it is computed from what the rating actually is
      // right now.
      // Same read every other engine now does, through the shared helper —
      // this was the bespoke copy it was generalised from.
      const BOT = { isBot: true, elo: BOT_ELO };
      const r = humanWon
        ? await freshRatings(supabase, player, BOT)
        : await freshRatings(supabase, BOT, player);
      eloBefore = humanWon ? r.winnerBefore : r.loserBefore;
      const { newWinnerElo, newLoserElo } = r;
      humanNewElo = humanWon ? newWinnerElo : newLoserElo;
      // Through applyEloUpdate so the placement guard applies here too. A
      // raw update skips it, which is how a brand-new account's rating moved
      // on a bot match while every screen still called it Unranked. When the
      // guard holds the write back, the reported rating is reset to the one
      // already stored — otherwise the card announces a swing the database
      // never took.
      try {
        const r = await applyEloUpdate(supabase, player.userId, humanNewElo);
        if (!r?.applied) humanNewElo = eloBefore;
      } catch (e) { console.error('[tower] elo:', e.message); }
      try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: player.userId }); } catch (e) { console.error('[tower] rpc:', e.message); }
      try {
        await supabase.from('matches').insert({
          player1_id: player.userId, player2_id: null,
          winner_id: humanWon ? player.userId : null, game_type: 'tower',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0,
          entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
          prize_pool_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) * 2 : 0,
          prize_pool_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
        });
      } catch (e) { console.error('[tower] matches insert:', e.message); }
    }
    // A personal best is the point of the mode, so it records either way.
    if (supabase) await updateHighscore(supabase, player.userId, 'tower', verified).catch(() => {});

    io.emit('active_game_ended', { id: roomId });
    gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
    io.to(roomId).emit('tower_result', {
      isSolo: true,
      vsBot: true,
      newElo: humanNewElo,
      // Sent so the card subtracts from the same number the server used. Left
      // to its own cached profile it can be a few points out, and the displayed
      // swing then bears no relation to the real one.
      eloBefore,
      winnerId: humanWon ? player.userId : null,
      playerId: player.userId,
      playerScore: verified,
      botScore,
      humanWon,
      balanceChange,
      currency: room.currency || 'coins',
      entryFee: room.entryFee || 0,
    });
    return;
  }

  // ── PvP ──
  const other = room.players.find(p => p.socketId !== socketId);
  const otherFinal = other ? room.scores[other.socketId] : undefined;

  // Both finished — settle on the two final scores.
  if (otherFinal != null) {
    if (room.catchupTimer) { clearTimeout(room.catchupTimer); room.catchupTimer = null; }
    return _resolveFromScores(io, supabase, roomId);
  }

  // First one out. The survivor gets a window to beat this score; if they pass
  // it we resolve immediately rather than making them keep playing for nothing.
  room.catchupTarget = verified;
  io.to(other.socketId).emit('tower_catchup', {
    endsAt: Date.now() + CATCHUP_MS,
    target: verified,
  });
  room.catchupTimer = setTimeout(() => {
    _resolveFromScores(io, supabase, roomId).catch(e => console.error('[tower] catchup resolve:', e.message));
  }, CATCHUP_MS);
}

/** The surviving player passed the target — no reason to keep them playing. */
async function checkTowerOvertake(io, supabase, roomId) {
  const room = getTowerRoom(roomId);
  if (!room || room.state !== 'active' || room.catchupTarget == null) return;
  const chaser = room.players.find(p => room.scores[p.socketId] == null);
  if (!chaser) return;
  if ((room.pingScores[chaser.socketId] ?? 0) <= room.catchupTarget) return;
  room.scores[chaser.socketId] = room.pingScores[chaser.socketId];
  if (room.catchupTimer) { clearTimeout(room.catchupTimer); room.catchupTimer = null; }
  await _resolveFromScores(io, supabase, roomId);
}

async function _resolveFromScores(io, supabase, roomId) {
  const room = getTowerRoom(roomId);
  if (!room) return;
  const [p1, p2] = room.players;
  const s1 = room.scores[p1.socketId] ?? room.pingScores[p1.socketId] ?? 0;
  const s2 = room.scores[p2.socketId] ?? room.pingScores[p2.socketId] ?? 0;
  const winner = s1 >= s2 ? p1 : p2;
  const loser  = s1 >= s2 ? p2 : p1;
  await _resolve(io, supabase, roomId, winner, loser, Math.max(s1, s2), Math.min(s1, s2));
}

async function _resolve(io, supabase, roomId, winner, loser, winnerScore, loserScore) {
  const room = getTowerRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  if (room.catchupTimer) { clearTimeout(room.catchupTimer); room.catchupTimer = null; }
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });

  const isFree = (room.entryFee || 0) === 0;
  // null means "this mode does not rate", so the result card omits the row
  // rather than printing an unchanged number as if something had happened.
  const { newWinnerElo, newLoserElo, winnerBefore, loserBefore } = isFree
    ? { newWinnerElo: null, newLoserElo: null, winnerBefore: null, loserBefore: null }
    : await freshRatings(supabase, winner, loser);

  let balanceChange = null;
  if (room.entryFee > 0 && !room.feesDeducted) {
    console.error(`[towerEngine] CRITICAL: room ${roomId} settled without feesDeducted — no payout issued`);
    unlockUser(winner.userId); unlockUser(loser.userId);
  } else if (supabase && room.entryFee > 0) {
    try {
      const meta = { game: 'Tower', winnerUsername: winner.username, loserUsername: loser.username };
      balanceChange = (room.currency === 'diamonds')
        ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee, meta)
        : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee, meta);
    } catch (e) { console.error('[tower] settle:', e.message); }
  } else {
    unlockUser(winner.userId); unlockUser(loser.userId);
  }

  // Streaks are resolved BEFORE the result goes out. They used to be emitted as
  // a hard-coded 0 and applied afterwards in the background, so a winning PvP
  // streak was recorded correctly but never once shown — the card had a zero.
  // applyMatchStreaks no-ops on bot matches, which is what keeps streaks PvP-only.
  let winnerStreak = 0, isFirstWin = false;
  if (supabase && !winner.isBot && !loser.isBot) {
    try {
      ({ winnerStreak, isFirstWin } = await applyMatchStreaks(supabase, winner, loser));
    } catch (e) { console.error('[tower] streaks:', e.message); }
  }

  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
  io.to(roomId).emit('tower_result', {
    isSolo: false,
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange,
    // See carDashEngine: the card's own baseline is captured at queue time
    // and goes stale, so the true before-values travel with the result.
    winnerBefore, loserBefore,
    vsBot: !!(winner.isBot || loser.isBot),
    winnerScore, loserScore,
    currency: room.currency || 'coins',
    entryFee: room.entryFee || 0,
    winnerStreak,
    isFirstWin,
  });

  // Bookkeeping after the result is on screen — none of it changes the outcome.
  Promise.resolve().then(async () => {
    if (!supabase) return;
    // A free match still counts toward the record; only the rating is gated on
    // the stake.
    if (!winner.isBot) {
      if (!isFree) {
        try { await applyEloUpdate(supabase, winner.userId, newWinnerElo); } catch {}
      }
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch {}
      // Streaks already applied above, before the emit.
    }
    if (!loser.isBot) {
      if (!isFree) {
        try { await applyEloUpdate(supabase, loser.userId, newLoserElo); } catch {}
      }
      try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch {}
    }
    if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'tower', winnerScore).catch(() => {});
    if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'tower', loserScore).catch(() => {});
    try {
      const cur = room.currency || 'coins';
      await supabase.from('matches').insert({
        player1_id: winner.isBot ? null : winner.userId,
        player2_id: loser.isBot ? null : loser.userId,
        winner_id:  winner.isBot ? null : winner.userId,
        game_type: 'tower',
        entry_fee_c:        cur === 'coins'    ? (room.entryFee || 0) : 0,
        entry_fee_diamonds: cur === 'diamonds' ? (room.entryFee || 0) : 0,
        prize_pool_c:        cur === 'coins'    ? (room.entryFee || 0) * 2 : 0,
        prize_pool_diamonds: cur === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
      });
    } catch (e) { console.error('[tower] matches insert:', e.message); }
  }).catch(e => console.error('[tower] post-result DB:', e.message));
}

module.exports = {
  addToTowerQueue, removeFromTowerQueue,
  getTowerRoom, deleteTowerRoom, getTowerRoomBySocket,
  createDirectTowerRoom,
  startTowerCountdown, trackTowerScorePing,
  handleTowerComplete, checkTowerOvertake,
  CATCHUP_MS,
};
