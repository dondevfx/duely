// Outcomes that decide real money use the crypto RNG, not Math.random.
// V8's Math.random is a fast non-cryptographic PRNG: an attacker who can watch
// enough results can recover its internal state and predict the next ones. For
// a coin flip, a shuffled deck or a shared level seed that is a live edge, so
// these use crypto.randomInt instead. Cosmetic randomness elsewhere (bot names,
// timing jitter) is deliberately left alone.
const { randomInt } = require('node:crypto');
const { closestByElo } = require('./queueMatch');
const { findRoomBySocket } = require('./roomLookup');
﻿const { calculateNewRatings, applyMatchStreaks, applyEloUpdate, freshRatings } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { unlockUser } = require('./lockService');
const { v4: uuidv4 } = require('uuid');
const { updateHighscore } = require('./highscoreService');
const MAX_SCORE = 15_000_000;
// Max points a single move can legitimately award:
// scoreForClear(16 lines, 5 cells, chain=3) ≈ 77k — use 150k to give headroom for combos.
// This doubles as the token-bucket burst capacity (one big combo can land instantly).
const MAX_DELTA_PER_PING = 150_000;
// Sustained score growth cap, in points per millisecond. The bucket refills at
// this rate, so no matter how fast a client spams pings, the score can't grow
// faster than SCORE_REFILL_PER_MS × time — killing the "spam pings, each +150k"
// exploit while leaving legitimate bursty play (refilled bucket) untouched.
const SCORE_REFILL_PER_MS = 200; // 200k points/sec sustained ceiling
const gameEvents = require('./gameEvents');

const blockBlastRooms = new Map();
const blockBlastQueue = [];

// How long the surviving player gets to beat a finished score. Same value as
// Rush Hour's catch-up window, so the two games do not teach different rules.
const CATCHUP_MS = 15_000;

// Stall watchdog.
//
// Rush Hour and Color Rush ping continuously while a run is alive, so 15s of
// silence there means the client is gone. Block Burst pings only when the score
// CHANGES, and a player weighing three pieces against a crowded board can
// legitimately think for half a minute — so the same 15s would end real runs.
//
// 45s of a player scoring nothing while their opponent plays on is not a game
// state that happens by accident. Long enough never to catch a slow player,
// short enough that refusing to play cannot hold a match open.
const STALL_MS = 45_000;
const WATCH_MS = 3_000;
// Nothing runs this long. The ceiling exists so a match cannot outlive its
// room even if both clients go quiet in a way the stall check cannot see.
const MAX_MATCH_MS = 30 * 60_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToBlockBlastQueue(player) {
  const idx = closestByElo(blockBlastQueue, player, p =>
    p.socketId !== player.socketId &&
    p.entryFee === player.entryFee &&
    p.currency === player.currency &&
    !!p.isDemo === !!player.isDemo
  );
  if (idx !== -1) {
    const opp = blockBlastQueue.splice(idx, 1)[0];
    const roomId = 'bb_' + uuidv4();
    const room = _makeRoom(roomId, opp, player);
    blockBlastRooms.set(roomId, room);
    return { roomId, p1: opp, p2: player };
  }
  blockBlastQueue.push(player);
  return null;
}

function removeFromBlockBlastQueue(socketId) {
  const idx = blockBlastQueue.findIndex(p => p.socketId === socketId);
  if (idx !== -1) { blockBlastQueue.splice(idx, 1); return true; }
  return false;
}

function getBlockBlastRoom(roomId)           { return blockBlastRooms.get(roomId); }
function deleteBlockBlastRoom(roomId)        { blockBlastRooms.delete(roomId); }
// Prefers a live room over a settled-but-not-yet-swept one. See roomLookup.
function getBlockBlastRoomBySocket(socketId) {
  return findRoomBySocket(blockBlastRooms, socketId);
}

function createDirectBlockBlastRoom(p1, p2) {
  const roomId = 'bb_' + uuidv4();
  const room = _makeRoom(roomId, p1, p2);
  blockBlastRooms.set(roomId, room);
  return { roomId };
}

function _makeRoom(roomId, p1, p2) {
  const isSolo = p1.isBot || p2.isBot;
  // Demo accounts always win vs a bot: keep the bot's score trailing a little.
  const demoHuman = isSolo && [p1, p2].some(p => p.isDemo && !p.isBot);
  return {
    roomId,
    players:        [p1, p2],
    state:          'countdown',
    startTime:      null,
    entryFee:       p1.entryFee,
    currency:       p1.currency,
    rematches:      {},
    scores:         {},
    stuck:          new Set(),
    isSolo,
    demoWin:        demoHuman, // demo account always beats the bot
    // Bot wins ~45% of the time; ratio controls how bot score tracks the human
    botWins:        isSolo ? (demoHuman ? false : Math.random() < 0.45) : false,
    botRatio:       isSolo ? (demoHuman ? (Math.random() * 0.12 + 0.80) : (Math.random() * 0.25 + (Math.random() < 0.45 ? 1.05 : 0.70))) : 0,
    // Server-tracked scores from pings — authoritative source for final score
    pingScores:     {},
    pingTimes:      {},
    scoreBuckets:   {}, // token-bucket allowance per socket (anti score-spam)
  };
}

// Called by the score_ping socket handler. Returns the clamped, validated score
// that should be forwarded to the opponent (and stored as the authoritative score).
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

function trackBlockBlastScorePing(roomId, socketId, rawScore) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return null;
  if (!_isPlayer(room, socketId)) return null;

  const now       = Date.now();
  const prev      = room.pingScores[socketId] ?? 0;
  const lastTime  = room.pingTimes[socketId]  ?? (room.startTime || now);
  const delta     = (rawScore || 0) - prev;
  const elapsed   = Math.max(0, now - lastTime);

  // Score must be non-decreasing
  if (rawScore < prev) return prev;

  // Token-bucket rate limit. The bucket refills by elapsed × SCORE_REFILL_PER_MS
  // (capped at MAX_DELTA_PER_PING of burst capacity) and the score may only grow
  // by what the bucket permits. Because rapid-fire pings have tiny elapsed time,
  // they barely refill the bucket — so spamming pings can no longer inflate the
  // score. Legitimate play, which pings over real time, refills normally.
  const bucketPrev = room.scoreBuckets[socketId] ?? MAX_DELTA_PER_PING;
  const bucket     = Math.min(MAX_DELTA_PER_PING, bucketPrev + elapsed * SCORE_REFILL_PER_MS);

  const grant   = Math.max(0, Math.min(delta, bucket));
  const clamped = Math.min(prev + grant, MAX_SCORE);

  // Log throttled pings (client tried to grow faster than allowed) for review
  if (delta > grant) {
    const player = room.players.find(p => p.socketId === socketId);
    console.warn(`[blockBlast] score ping throttled — user:${player?.userId} claimed:${rawScore} prev:${prev} delta:${delta} granted:${grant} clamped to:${clamped}`);
  }

  room.scoreBuckets[socketId] = bucket - (clamped - prev);
  room.pingScores[socketId]   = clamped;
  room.pingTimes[socketId]    = now;
  return clamped;
}

async function startBlockBlastCountdown(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room) return;
  for (let i = 3; i >= 1; i--) {
    io.to(roomId).emit('block_blast_countdown', { count: i });
    await sleep(1000);
  }
  const current = getBlockBlastRoom(roomId);
  if (!current) return;
  current.state = 'active';
  current.startTime = Date.now();
  current.supabase = supabase;
  current.botTimers = current.botTimers || [];
  const seed = randomInt(1000000);
  io.to(roomId).emit('block_blast_start', { seed });

  // No match may hang forever waiting on a client that stops playing.
  //
  // Without this a player could join a PvP match, never place a piece and
  // never get stuck, and the room stayed 'active' indefinitely — the opponent
  // could play as long as they liked and never win, and their only way out was
  // to forfeit and lose the stake. Refusing to play must never be a way to hold
  // someone else's coins hostage.
  const watch = setInterval(() => {
    const r = getBlockBlastRoom(roomId);
    if (!r || r.state !== 'active') { clearInterval(watch); return; }
    const now = Date.now();

    if (now - (r.startTime || now) > MAX_MATCH_MS) {
      clearInterval(watch);
      _forceResolve(io, supabase, roomId).catch(() => {});
      return;
    }

    // Solo has no second human to protect, and its bot never gets stuck — the
    // run ends when the player's does.
    if (r.isSolo) return;

    const live = r.players.filter(p => !p.isBot && !r.stuck.has(p.socketId));
    const stalled = live.filter((p) => {
      const last = r.pingTimes[p.socketId] ?? r.startTime ?? now;
      return now - last > STALL_MS;
    });
    if (stalled.length === 0) return;

    if (stalled.length === live.length) {
      // Everyone still in has gone quiet. There is no one left to play on for,
      // so settle on the scores as they stand rather than marking each of them
      // stuck in turn and arming a catch-up for a player who is also gone.
      clearInterval(watch);
      for (const p of live) r.scores[p.socketId] = r.pingScores[p.socketId] ?? 0;
      _resolveFromScores(io, supabase, roomId).catch(() => {});
      return;
    }

    // Otherwise treated exactly as getting stuck: their run ends at the score
    // the server tracked, and THEIR OPPONENT PLAYS ON with the normal catch-up
    // window. Resolving the whole match here would let the player who is ahead
    // win by walking away.
    for (const p of stalled) {
      handleBlockBlastStuck(io, supabase, roomId, p.socketId, r.pingScores[p.socketId] ?? 0)
        .catch(() => {});
    }
  }, WATCH_MS);
  current.botTimers.push(watch);

  // Bot mode: score trails the human's live ping score, scaled by botRatio
  if (current.isSolo) {
    const human = current.players.find(p => !p.isBot);
    if (human) {
      let botDisplayScore = 0;
      const pingInterval = setInterval(() => {
        const r = getBlockBlastRoom(roomId);
        if (!r || r.state !== 'active') { clearInterval(pingInterval); return; }
        const humanScore = r.pingScores[human.socketId] ?? 0;
        // Target = human score * ratio, approached gradually with small random noise
        const target = Math.floor(humanScore * r.botRatio);
        const step   = Math.floor(Math.random() * 60) + 10;
        if (target > botDisplayScore) {
          botDisplayScore = Math.min(target, botDisplayScore + step);
        }
        r.pingScores['bot'] = botDisplayScore;
        io.to(human.socketId).emit('block_blast_opponent_score', { score: botDisplayScore });
      }, 4000);
      current.botTimers.push(pingInterval);
    }
  }
}

// Player got stuck (no valid placements left)
async function handleBlockBlastStuck(io, supabase, roomId, socketId, score = 0) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (!_isPlayer(room, socketId)) return;

  // Solo mode: end immediately using final ping score vs bot's display score
  if (room.isSolo) {
    const player = room.players.find(p => !p.isBot);
    if (!player) return;
    (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
    room.botTimers = [];
    const verifiedScore = room.pingScores[player.socketId] ?? 0;
    room.scores[player.socketId] = verifiedScore;
    await handleBlockBlastComplete(io, supabase, roomId, player.socketId, verifiedScore);
    return;
  }
  if (room.stuck.has(socketId)) return; // already stuck

  room.stuck.add(socketId);
  // Use server-tracked ping score as authoritative; client-submitted score is ignored
  // to prevent sending a fake high score at the last moment.
  const trackedScore = room.pingScores[socketId] ?? 0;
  room.scores[socketId] = trackedScore;

  const stuckPlayer = room.players.find(p => p.socketId === socketId);
  const otherPlayer = room.players.find(p => p.socketId !== socketId && !p.isBot);

  if (stuckPlayer) {
    io.to(roomId).emit('block_blast_player_stuck', { stuckUserId: stuckPlayer.userId });
  }

  // Use live ping score (updated every few seconds) to check if opponent is already ahead.
  // room.scores is only set when a player finishes — not reliable for live comparison.
  const otherLiveScore = otherPlayer
    ? (room.pingScores[otherPlayer.socketId] ?? room.scores[otherPlayer.socketId] ?? -1)
    : -1;
  if (otherLiveScore > trackedScore) {
    // Opponent is already winning — no comeback possible, end immediately
    await _resolveFromScores(io, supabase, roomId);
    return;
  }

  // Opponent is behind or tied — a fixed window to beat the finished score.
  if (otherPlayer) {
    room.catchupTarget = trackedScore;
    io.to(otherPlayer.socketId).emit('block_blast_keep_playing', { seconds: CATCHUP_MS / 1000 });
    room.stuckTimer = setTimeout(async () => {
      const r = getBlockBlastRoom(roomId);
      if (!r || r.state !== 'active') return;
      await _resolveFromScores(io, supabase, roomId);
    }, CATCHUP_MS);
  } else {
    await _resolveFromScores(io, supabase, roomId);
  }
}

// The chaser has passed the score they were chasing. Nothing they do afterwards
// can lose it, so end the match rather than making them play out the clock.
// Mirrors checkOvertake in carDashEngine.
async function checkBlockBlastOvertake(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (!room.stuckTimer || room.catchupTarget == null) return;

  const chaser = room.players.find(p => !p.isBot && !room.stuck.has(p.socketId));
  if (!chaser) return;
  if ((room.pingScores[chaser.socketId] ?? 0) <= room.catchupTarget) return;

  clearTimeout(room.stuckTimer);
  room.stuckTimer = null;
  room.scores[chaser.socketId] = room.pingScores[chaser.socketId];
  await _resolveFromScores(io, supabase, roomId);
}

// Player submitted their final score (timer ran out)
async function handleBlockBlastComplete(io, supabase, roomId, socketId, score = 0) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
  if (!_isPlayer(room, socketId)) return;
  // Use server-tracked ping score as authoritative — ignores client's submitted value
  const verifiedScore = room.pingScores[socketId] ?? 0;
  room.scores[socketId] = verifiedScore;
  (room.botTimers || []).forEach(t => { clearTimeout(t); clearInterval(t); });
  room.botTimers = [];

  if (room.isSolo) {
    const player = room.players.find(p => !p.isBot);
    if (player) {
      room.state = 'finished';
      // Final bot score = human score * ratio (ensures outcome matches what was shown)
      // A free run is practice: nothing is staked, so there is nothing to lose,
      // and being told you lost to a bot you never bet against just discourages
      // playing. Paid bot matches are untouched — real money is on those.
      const freeSolo = !(room.entryFee > 0);
      const alwaysWin = room.demoWin || freeSolo;
      let botScore = Math.floor(verifiedScore * (room.botRatio ?? 0.8));
      if (alwaysWin && botScore >= verifiedScore) botScore = Math.max(0, verifiedScore - 1);
      const humanWon = alwaysWin ? true : verifiedScore > botScore;
      let balanceChange = null;
      if (room.entryFee > 0 && !room.feesDeducted) {
        console.error(`[blockBlastEngine] CRITICAL: solo room ${roomId} settled without feesDeducted — no payout issued`);
        unlockUser(player.userId);
      } else if (room.entryFee > 0) {
        try {
          balanceChange = await settleBotMatch(supabase, player.userId, room.entryFee, room.currency || 'coins', humanWon, { game: 'Block Burst' });
        } catch (e) { console.error('[blockBlastEngine] solo settle:', e.message); }
      }
      // Rating and record are gated on the run costing something.
      //
      // This is the half that makes an unloseable game safe. A free solo run
      // that always wins AND wrote ELO would be an infinite rating ladder —
      // queue solo, crash immediately, gain rating, repeat. The highscore is
      // still recorded below, since a personal best is the point of the mode.
      // Reported back so the result card can show it. A paid bot match — coins
      // or diamonds — really does move the rating, but the payload carried no
      // number, so the card had nothing to print and hid the row entirely. That
      // reads as "bot matches are unrated", which is not true.
      let humanNewElo = null;
      let humanEloBefore = null;
      if (supabase && !freeSolo) {
        const BOT_ELO = 1000;
        // Read the rating as it stands now. player.elo is whatever the socket
        // cached at queue time, and calculateNewRatings returns an ABSOLUTE
        // value — writing one derived from a stale baseline lands a few points
        // above the real rating and reports +4 on a win worth +20.
        const BOT = { isBot: true, elo: BOT_ELO };
        const { newWinnerElo, newLoserElo, winnerBefore, loserBefore } = humanWon
          ? await freshRatings(supabase, player, BOT)
          : await freshRatings(supabase, BOT, player);
        humanNewElo = humanWon ? newWinnerElo : newLoserElo;
        humanEloBefore = humanWon ? winnerBefore : loserBefore;
        // Through applyEloUpdate so the placement guard applies here too. A
        // raw update skips it, which is how a brand-new account's rating moved
        // on a bot match while every screen still called it Unranked. When the
        // guard holds the write back, the reported rating is reset to the one
        // already stored — otherwise the card announces a swing the database
        // never took.
        try {
          const r = await applyEloUpdate(supabase, player.userId, humanNewElo);
          if (!r?.applied) humanNewElo = humanEloBefore;
        } catch (e) { console.error('[blockBlastEngine] elo update:', e.message); }
        try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: player.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
        // Beating a bot no longer builds a streak — streaks are a PvP record.
        if (false) {
          try {
            await Promise.resolve();
          } catch { /* silent — streak is best-effort */ }
        }
        try {
          await supabase.from('matches').insert({
            player1_id: player.userId, player2_id: null, winner_id: humanWon ? player.userId : null,
            game_type: 'blockBlast', entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
            prize_pool_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) * 2 : 0,
            prize_pool_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
          });
        } catch (e) { console.error('[blockBlastEngine] matches insert:', e.message); }
      }
      if (supabase) {
        await updateHighscore(supabase, player.userId, 'blockBlast', verifiedScore);
      }
      io.emit('active_game_ended', { id: roomId });
      gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
      io.to(roomId).emit('block_blast_result', {
        isSolo:      true,
        newElo:      humanNewElo,
        // The rating this was computed FROM — see carDashEngine.
        eloBefore:   humanEloBefore,
        winnerId:    humanWon ? player.userId : null,
        playerId:    player.userId,
        playerScore: verifiedScore,
        botScore,
        humanWon,
        balanceChange,
        currency:    room.currency || 'coins',
        entryFee:    room.entryFee || 0,
      });
    }
    return;
  }

  // PvP: check if all players have submitted
  const allDone = room.players.every(p => p.isBot || room.scores[p.socketId] != null);
  if (allDone) {
    await _resolveFromScores(io, supabase, roomId);
  }
}

async function _forceResolve(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
  const [p1, p2] = room.players;
  const s1 = room.scores[p1.socketId];
  const s2 = room.scores[p2.socketId];
  if (s1 == null && s2 == null) {
    room.state = 'finished';
    io.emit('active_game_ended', { id: roomId });
    gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
    io.to(roomId).emit('block_blast_result', { draw: true, reason: 'timeout' });
    return;
  }
  await _resolveFromScores(io, supabase, roomId);
}

async function _resolveFromScores(io, supabase, roomId) {
  const room = getBlockBlastRoom(roomId);
  if (!room) return;
  const [p1, p2] = room.players;
  // Prefer submitted final score; fall back to last ping score for players still playing
  const s1 = room.scores[p1.socketId] ?? room.pingScores[p1.socketId] ?? 0;
  const s2 = room.scores[p2.socketId] ?? room.pingScores[p2.socketId] ?? 0;
  const winner = s1 >= s2 ? p1 : p2;
  const loser  = s1 >= s2 ? p2 : p1;
  await _resolve(io, supabase, roomId, winner, loser, Math.max(s1, s2), Math.min(s1, s2));
}

async function _resolve(io, supabase, roomId, winner, loser, winnerScore, loserScore) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state === 'finished') return;
  room.state = 'finished';
  if (room.stuckTimer) { clearTimeout(room.stuckTimer); room.stuckTimer = null; }

  const isFree = (room.entryFee || 0) === 0;
  // Unrated outcomes report null rather than the unchanged rating. Sending
  // the current value made the result card show "1000 (+0)", which reads as
  // a rated match that happened to be worth nothing. null means "this mode
  // does not rate", and the card omits the row entirely. Rush Hour already
  // did this; the rest did not.
  const { newWinnerElo, newLoserElo, winnerBefore, loserBefore } = isFree
    ? { newWinnerElo: null, newLoserElo: null, winnerBefore: null, loserBefore: null }
    : await freshRatings(supabase, winner, loser);

  // Settle wallet immediately so payout is accurate in the result
  let balanceChange = null;
  if (supabase && room.entryFee > 0 && !room.feesDeducted) {
    console.error(`[blockBlastEngine] CRITICAL: room ${roomId} settled without feesDeducted — no payout issued`);
    unlockUser(winner.userId); unlockUser(loser.userId);
  } else if (supabase && room.entryFee > 0) {
    try {
      const _hasBot = winner.isBot || loser.isBot;
      if (_hasBot) {
        const _humanId = winner.isBot ? loser.userId : winner.userId;
        const _humanWon = !winner.isBot;
        balanceChange = await settleBotMatch(supabase, _humanId, room.entryFee, room.currency || 'coins', _humanWon, { game: 'Block Burst' });
      } else {
        const meta = { game: 'Block Burst', winnerUsername: winner.username, loserUsername: loser.username };
        balanceChange = room.currency === 'diamonds'
          ? await settleMatchDiamonds(supabase, winner.userId, loser.userId, room.entryFee, meta)
          : await settleMatch(supabase, winner.userId, loser.userId, room.entryFee, meta);
      }
    } catch (e) { console.error('BlockBlast settle:', e.message); }
  }

  // Emit result immediately after wallet settles — don't wait for ELO/stats DB writes
  io.emit('active_game_ended', { id: roomId });
  gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
  io.to(roomId).emit('block_blast_result', {
    isSolo: false,
    winnerId: winner.userId, loserId: loser.userId,
    winnerUsername: winner.username, loserUsername: loser.username,
    newWinnerElo, newLoserElo, balanceChange,
    // See carDashEngine: the card's queue-time baseline goes stale, so the
    // true before-values travel with the result.
    winnerBefore, loserBefore,
    // Streaks are a PvP record, so the card needs to know not to mention them.
    vsBot: !!(winner.isBot || loser.isBot),
    winnerScore, loserScore,
    currency: room.currency || 'coins',
    entryFee: room.entryFee || 0,
    winnerStreak: 0,
    isFirstWin: false,
  });

  // Fire-and-forget: ELO, streaks, highscores, match record
  Promise.resolve().then(async () => {
    let winnerStreak = 0, isFirstWin = false;
    // A free match still counts toward the record — see the note in
    // blackjackEngine. Only the rating is gated on the entry fee.
    if (supabase && !winner.isBot) {
      if (!isFree) {
        try { await applyEloUpdate(supabase, winner.userId, newWinnerElo); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
      }
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
      // Streaks are PvP-only — applyMatchStreaks no-ops on bot matches.
      try { ({ winnerStreak, isFirstWin } = await applyMatchStreaks(supabase, winner, loser)); } catch {}
    }

    if (supabase && !loser.isBot) {
      if (!isFree) {
        try { await applyEloUpdate(supabase, loser.userId, newLoserElo); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
      }
      try { await supabase.rpc('increment_loss', { uid: loser.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
    }
    if (supabase) {
      if (!winner.isBot) await updateHighscore(supabase, winner.userId, 'blockBlast', winnerScore);
      if (!loser.isBot)  await updateHighscore(supabase, loser.userId,  'blockBlast', loserScore);
      try {
        await supabase.from('matches').insert({
          player1_id: winner.isBot ? null : winner.userId, player2_id: loser.isBot ? null : loser.userId,
          winner_id: winner.isBot ? null : winner.userId, game_type: 'blockBlast',
          entry_fee_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0, entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
          prize_pool_c: (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) * 2 : 0,
          prize_pool_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) * 2 : 0,
        });
      } catch (e) { console.error('[blockBlastEngine] matches insert:', e.message); }
    }
    // If we got streak/isFirstWin, no way to re-emit — backend-only data. Clients refresh profile after result.
  }).catch(e => console.error('[blockBlastEngine] post-result DB:', e.message));
}

module.exports = {
  createDirectBlockBlastRoom,
  addToBlockBlastQueue, removeFromBlockBlastQueue,
  getBlockBlastRoom, deleteBlockBlastRoom, getBlockBlastRoomBySocket,
  startBlockBlastCountdown, handleBlockBlastComplete, handleBlockBlastStuck,
  trackBlockBlastScorePing,
  checkBlockBlastOvertake,
};


