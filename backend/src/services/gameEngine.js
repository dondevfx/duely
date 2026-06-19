const { getRoom } = require('./matchmaking');
const { calculateNewRatings, updateStreaks, applyEloUpdate } = require('./eloService');
const { settleMatch, settleMatchDiamonds, settleBotMatch } = require('./walletService');
const { creditRakeback } = require('./rakebackService');
const { scheduleBotClick } = require('./botService');

const ROUNDS_TO_WIN = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay() { return 1500 + Math.floor(Math.random() * 3000); } // 1.5–4.5s

// ─── Start a countdown then fire GO ──────────────────────────────────────────
async function startCountdown(io, supabase, roomId) {
  const room = getRoom(roomId);
  if (!room || room.state === 'finished') return;

  // Initialise round tracking on first call
  if (!room.roundWins) {
    room.round     = 1;
    room.roundWins = Object.fromEntries(room.players.map(p => [p.userId, 0]));
  }
  room.clickReceived = false;
  room.state = 'countdown';

  // 3 … 2 … 1 …
  for (let i = 3; i >= 1; i--) {
    if (!getRoom(roomId)) return;
    io.to(roomId).emit('game_countdown', { count: i });
    await sleep(1000);
  }

  // Silent random pause — client just waits (no state change visible to server either)
  await sleep(randomDelay());

  const r = getRoom(roomId);
  if (!r || r.state !== 'countdown') return; // room deleted or another event changed state

  r.state  = 'active';
  r.goTime = Date.now();
  io.to(roomId).emit('game_go');

  // Schedule bot click (3–5 s after GO — very easy to beat)
  for (const p of r.players) {
    if (p.isBot) scheduleBotClick(io, supabase, roomId, p.socketId, r.goTime, handleClick);
  }
}

// ─── Called when a player clicks ─────────────────────────────────────────────
async function handleClick(io, supabase, roomId, socketId) {
  const room = getRoom(roomId);
  if (!room || room.state !== 'active') return; // only fire during active phase
  if (room.clickReceived) return;               // first click wins, ignore rest
  room.clickReceived = true;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) { room.clickReceived = false; return; }

  await resolveRound(io, supabase, roomId, player);
}

// ─── Resolve who won a round ──────────────────────────────────────────────────
async function resolveRound(io, supabase, roomId, winner) {
  const room = getRoom(roomId);
  if (!room || room.state === 'finished' || room.state === 'between_rounds') return;

  const loser = room.players.find(p => p.socketId !== winner.socketId);
  if (!loser) return;

  room.state = 'between_rounds'; // lock immediately — no clicks bleed through

  room.roundWins[winner.userId] = (room.roundWins[winner.userId] || 0) + 1;
  const roundsWon = room.roundWins[winner.userId];
  const scores    = { ...room.roundWins };

  if (roundsWon >= ROUNDS_TO_WIN) {
    // ── Match over ────────────────────────────────────────────────────────────
    room.state = 'finished';

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
      } catch (err) { console.error('Settlement error:', err.message); }
    }

    let winnerStreak = 0;
    let isFirstWin = false;
    if (supabase && !winner.isBot) {
      try {
        await applyEloUpdate(supabase, winner.userId, newWinnerElo);
        await supabase.rpc('increment_win', { uid: winner.userId });
      } catch (e) { console.error('[gameEngine] RPC failed:', e.message); }
      try {
        ({ winnerStreak, isFirstWin } = await updateStreaks(supabase, winner.userId, null));
      } catch { /* streak columns may not exist yet */ }
    }
    // Always reset human loser's streak — any game, free or paid, vs bot or human
    if (supabase && !loser.isBot) {
      supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId).then().catch(() => {});
    }
    if (supabase && !loser.isBot) {
      try {
        await applyEloUpdate(supabase, loser.userId, newLoserElo);
        await supabase.rpc('increment_loss', { uid: loser.userId });
      } catch (e) { console.error('[gameEngine] RPC failed:', e.message); }
    }

    if (supabase && room.entryFee > 0) {
      const p1Id = winner.isBot ? null : winner.userId;
      const p2Id = loser.isBot ? null : loser.userId;
      await creditRakeback(supabase, p1Id, p2Id, room.entryFee * 2, room.currency || 'coins');
    }

    if (supabase && !winner.isBot && !loser.isBot) {
      try {
        await supabase.from('matches').insert({
          player1_id:       room.players[0].userId,
          player2_id:       room.players[1].userId,
          winner_id:        winner.userId,
          entry_fee_c:      (room.currency || 'coins') === 'coins' ? (room.entryFee || 0) : 0,
          entry_fee_diamonds: (room.currency || 'coins') === 'diamonds' ? (room.entryFee || 0) : 0,
          prize_pool_c:     room.entryFee * 2,
          platform_fee_c:   balanceChange?.fee || 0,
          reaction_time_ms: room.goTime ? Math.max(0, Date.now() - room.goTime) : null,
          early_click:      false,
          game_type:        'reaction',
        });
      } catch (e) { console.error('[gameEngine] RPC failed:', e.message); }
    }

    io.to(roomId).emit('game_result', {
      winnerId:       winner.userId,
      loserId:        loser.userId,
      winnerUsername: winner.username,
      loserUsername:  loser.username,
      newWinnerElo,
      newLoserElo,
      balanceChange,
      reactionTimeMs: room.goTime ? Math.max(0, Date.now() - room.goTime) : null,
      currency:       room.currency || 'coins',
      scores,
      winnerStreak: winnerStreak ?? 0,
      isFirstWin: isFirstWin ?? false,
    });

  } else {
    // ── Round over, more rounds to play ───────────────────────────────────────
    room.round++;

    io.to(roomId).emit('game_round_result', {
      round:         room.round - 1,
      roundWinnerId: winner.userId,
      scores,
    });

    await sleep(3000);
    const current = getRoom(roomId);
    if (current && current.state === 'between_rounds') {
      await startCountdown(io, supabase, roomId);
    }
  }
}

// backwards-compat alias used by handlers.js
const resolveMatch = resolveRound;

module.exports = { startCountdown, handleClick, resolveMatch };
