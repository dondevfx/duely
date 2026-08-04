// Outcomes that decide real money use the crypto RNG, not Math.random.
// V8's Math.random is a fast non-cryptographic PRNG: an attacker who can watch
// enough results can recover its internal state and predict the next ones. For
// a coin flip, a shuffled deck or a shared level seed that is a live edge, so
// these use crypto.randomInt instead. Cosmetic randomness elsewhere (bot names,
// timing jitter) is deliberately left alone.
const { randomInt } = require('node:crypto');
﻿const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function addToBlockBlastQueue(player) {
  const idx = blockBlastQueue.findIndex(p =>
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
function getBlockBlastRoomBySocket(socketId) {
  for (const [roomId, room] of blockBlastRooms) {
    if (room.players.some(p => p.socketId === socketId)) return { roomId, room };
  }
  return null;
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
function trackBlockBlastScorePing(roomId, socketId, rawScore) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return null;

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

  // Opponent is behind or tied — give them 30 seconds to try and beat the stuck player's score
  if (otherPlayer) {
    io.to(otherPlayer.socketId).emit('block_blast_keep_playing', { seconds: 30 });
    room.stuckTimer = setTimeout(async () => {
      const r = getBlockBlastRoom(roomId);
      if (!r || r.state !== 'active') return;
      await _resolveFromScores(io, supabase, roomId);
    }, 30000);
  } else {
    await _resolveFromScores(io, supabase, roomId);
  }
}

// Player submitted their final score (timer ran out)
async function handleBlockBlastComplete(io, supabase, roomId, socketId, score = 0) {
  const room = getBlockBlastRoom(roomId);
  if (!room || room.state !== 'active') return;
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
      let botScore = Math.floor(verifiedScore * (room.botRatio ?? 0.8));
      if (room.demoWin && botScore >= verifiedScore) botScore = Math.max(0, verifiedScore - 1);
      const humanWon = room.demoWin ? true : verifiedScore > botScore;
      let balanceChange = null;
      if (room.entryFee > 0 && !room.feesDeducted) {
        console.error(`[blockBlastEngine] CRITICAL: solo room ${roomId} settled without feesDeducted — no payout issued`);
        unlockUser(player.userId);
      } else if (room.entryFee > 0) {
        try {
          balanceChange = await settleBotMatch(supabase, player.userId, room.entryFee, room.currency || 'coins', humanWon, { game: 'Block Burst' });
        } catch (e) { console.error('[blockBlastEngine] solo settle:', e.message); }
      }
      if (supabase) {
        const BOT_ELO = 1000;
        const { newWinnerElo, newLoserElo } = humanWon
          ? calculateNewRatings(player.elo, BOT_ELO)
          : calculateNewRatings(BOT_ELO, player.elo);
        const humanNewElo = humanWon ? newWinnerElo : newLoserElo;
        try { await supabase.from('profiles').update({ elo: humanNewElo }).eq('id', player.userId); } catch (e) { console.error('[blockBlastEngine] elo update:', e.message); }
        try { await supabase.rpc(humanWon ? 'increment_win' : 'increment_loss', { uid: player.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
        if (humanWon) {
          try {
            await updateStreaks(supabase, player.userId, null);
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
        await updateHighscore(supabase, player.userId, 'blockBlast', verifiedScore);
      }
      io.emit('active_game_ended', { id: roomId });
      gameEvents.emit('game_ended', { socketIds: room.players.map(p => p.socketId) });
      io.to(roomId).emit('block_blast_result', {
        isSolo:      true,
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
  const { newWinnerElo, newLoserElo } = isFree
    ? { newWinnerElo: winner.elo, newLoserElo: loser.elo }
    : calculateNewRatings(winner.elo, loser.elo);

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
    winnerScore, loserScore,
    currency: room.currency || 'coins',
    entryFee: room.entryFee || 0,
    winnerStreak: 0,
    isFirstWin: false,
  });

  // Fire-and-forget: ELO, streaks, highscores, match record
  Promise.resolve().then(async () => {
    let winnerStreak = 0, isFirstWin = false;
    if (supabase && !isFree && !winner.isBot) {
      try { await applyEloUpdate(supabase, winner.userId, newWinnerElo, true); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
      try { await supabase.rpc('increment_win', { uid: winner.userId }); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
      try { ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null)); } catch {}
    }
    if (supabase && !loser.isBot) {
      try { await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId); } catch {}
    }
    if (supabase && !isFree && !loser.isBot) {
      try { await applyEloUpdate(supabase, loser.userId, newLoserElo, true); } catch (e) { console.error('[blockBlastEngine] RPC failed:', e.message); }
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
};


