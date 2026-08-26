// A win is worth slightly more than a loss costs, and both vary, so a rating
// drifts upward with play rather than sitting exactly where a fixed +/-25 left
// it. The ranges overlap deliberately — a good run should feel like it is
// climbing without a single loss undoing it exactly.
const ELO_GAIN_MIN = 20, ELO_GAIN_MAX = 23;
const ELO_LOSS_MIN = 17, ELO_LOSS_MAX = 20;

const randBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Cosmetic randomness, so Math.random is fine here — the crypto RNG is reserved
// for outcomes that decide money (see the note atop the game engines).
function eloGain() { return randBetween(ELO_GAIN_MIN, ELO_GAIN_MAX); }
function eloLoss() { return randBetween(ELO_LOSS_MIN, ELO_LOSS_MAX); }

function calculateNewRatings(winnerElo, loserElo) {
  return {
    newWinnerElo: (winnerElo || 1000) + eloGain(),
    newLoserElo:  Math.max(0, (loserElo  || 1000) - eloLoss()),
  };
}

/**
 * Updates win streaks for the winner (increment) and loser (reset).
 * Tries the atomic Postgres RPC first; falls back to a manual read-modify-write.
 *
 * @returns {{ winnerStreak: number, isFirstWin: boolean }}
 */
/**
 * Apply a win streak for a settled match — the ONLY place streaks change.
 *
 * Streaks are a PvP record. A bot is not an opponent you beat, so a bot match
 * neither builds a streak nor breaks one. Previously the increment was guarded
 * by !winner.isBot and the reset separately by !loser.isBot, which meant losing
 * to a bot wiped a real streak while the bot match itself counted for nothing —
 * the worst of both. Two guards in five engines is also two things to keep in
 * step, so the rule lives here instead.
 *
 * @param {object} winner  { userId, isBot }
 * @param {object} loser   { userId, isBot }
 * @returns {{winnerStreak:number, isFirstWin:boolean, applied:boolean}}
 */
async function applyMatchStreaks(supabase, winner, loser) {
  const isPvp = winner && loser && !winner.isBot && !loser.isBot;
  if (!isPvp) return { winnerStreak: 0, isFirstWin: false, applied: false };

  let result = { winnerStreak: 0, isFirstWin: false };
  try {
    result = await updateStreaks(supabase, winner.userId, null);
  } catch (e) {
    console.error('[streaks] increment failed:', e.message);
  }
  try {
    await supabase.from('profiles').update({ current_streak: 0 }).eq('id', loser.userId);
  } catch (e) {
    console.error('[streaks] reset failed:', e.message);
  }
  return { ...result, applied: true };
}

async function updateStreaks(supabase, winnerId, loserId) {
  try {
    // Try atomic RPC first
    const { data: newStreak, error: rpcError } = await supabase
      .rpc('update_win_streak', { p_winner_id: winnerId, p_loser_id: loserId || null });

    if (!rpcError) {
      // Also check if this is the winner's first ever win (for "first win" message)
      const { data: pf } = await supabase
        .from('profiles').select('wins').eq('id', winnerId).single();
      const isFirstWin = (pf?.wins ?? 0) === 1;
      return { winnerStreak: newStreak ?? 1, isFirstWin };
    }

    console.error('[updateStreaks] RPC failed, falling back:', rpcError.message);

    // Fallback: manual read-modify-write
    const { data: winnerProfile, error: selectError } = await supabase
      .from('profiles')
      .select('current_streak, best_streak, wins')
      .eq('id', winnerId)
      .single();

    if (selectError) {
      console.error('[updateStreaks] SELECT failed:', selectError.message);
      return { winnerStreak: 0, isFirstWin: false };
    }

    const newStreakFallback = (winnerProfile.current_streak ?? 0) + 1;
    const newBest           = Math.max(newStreakFallback, winnerProfile.best_streak ?? 0);
    const isFirstWin        = (winnerProfile.wins ?? 0) === 1;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ current_streak: newStreakFallback, best_streak: newBest })
      .eq('id', winnerId);

    if (updateError) console.error('[updateStreaks] UPDATE winner failed:', updateError.message);

    if (loserId) {
      const { error: loserErr } = await supabase
        .from('profiles').update({ current_streak: 0 }).eq('id', loserId);
      if (loserErr) console.error('[updateStreaks] UPDATE loser failed:', loserErr.message);
    }

    return { winnerStreak: newStreakFallback, isFirstWin };
  } catch (e) {
    console.error('[updateStreaks] unexpected error:', e.message);
    return { winnerStreak: 0, isFirstWin: false };
  }
}

async function updateElo(supabase, winnerId, loserId, winnerElo, loserElo) {
  const { newWinnerElo, newLoserElo } = calculateNewRatings(winnerElo, loserElo);

  await Promise.all([
    supabase.from('profiles')
      .update({ elo: newWinnerElo })
      .eq('id', winnerId),
    supabase.from('profiles')
      .update({ elo: newLoserElo })
      .eq('id', loserId),
  ]);

  // increment wins/losses separately to avoid RLS issues
  await supabase.rpc('increment_win', { user_id: winnerId });
  await supabase.rpc('increment_loss', { user_id: loserId });

  let streakData = { winnerStreak: 0, isFirstWin: false };
  try {
    streakData = await updateStreaks(supabase, winnerId, loserId);
  } catch { /* silently ignore */ }

  return { newWinnerElo, newLoserElo, ...streakData };
}

/**
 * Apply ELO update only after a player has completed placement (3+ total matches).
 * ELO updates happen BEFORE wins/losses are incremented, so compare against current total.
 * Pass force=true to skip the placement guard (e.g. paid matches).
 */
async function applyEloUpdate(supabase, userId, newElo, force = false) {
  try {
    if (!force) {
      const { data } = await supabase
        .from('profiles').select('wins, losses').eq('id', userId).single();
      const total = (data?.wins ?? 0) + (data?.losses ?? 0);
      // Still in placement — no ELO change. Reported so the caller can tell
      // the player nothing moved, instead of showing a swing that was
      // computed and then silently discarded.
      if (total < 3) return { applied: false, placement: true };
    }
    await supabase.from('profiles').update({ elo: newElo }).eq('id', userId);
    return { applied: true };
  } catch (e) {
    console.error('[applyEloUpdate] error:', e.message);
    return { applied: false, error: e.message };
  }
}

/**
 * Write a rating and report the delta that ACTUALLY landed.
 *
 * The result card used to be handed two numbers — the new rating and the
 * rating it was computed from — and asked to subtract them. That is one
 * subtraction too many: it is only correct if the write happened, happened
 * exactly once, and nothing moved the rating in between. When any of those
 * failed the card reported a swing nobody received, most visibly as +44 on a
 * win worth +22.
 *
 * This does the arithmetic on the side that knows the answer. It re-reads the
 * row after writing, so the delta returned is the difference between what is
 * now stored and what was stored a moment ago — not a prediction. A skipped
 * placement write therefore reports 0, which is the truth.
 */
async function applyEloAndMeasure(supabase, userId, newElo, force = false) {
  if (!supabase || !userId) return { before: null, after: null, delta: null };

  const readElo = async () => {
    try {
      const { data } = await supabase.from('profiles').select('elo').eq('id', userId).single();
      return Number.isFinite(Number(data?.elo)) ? Number(data.elo) : null;
    } catch { return null; }
  };

  const before = await readElo();
  const res = await applyEloUpdate(supabase, userId, newElo, force);
  if (!res?.applied) return { before, after: before, delta: 0, placement: !!res?.placement };

  const after = await readElo();
  const delta = (before != null && after != null) ? after - before : null;

  // A delta outside the possible range means something wrote twice, or wrote
  // a value computed from a stale baseline. Worth shouting about rather than
  // rendering: it is money-adjacent trust, and it is exactly the shape of the
  // bug this function exists to stop.
  if (delta != null && Math.abs(delta) > ELO_GAIN_MAX) {
    console.error(
      `[elo] IMPOSSIBLE SWING for ${userId}: ${before} -> ${after} (${delta > 0 ? '+' : ''}${delta}). ` +
      `Max possible is +${ELO_GAIN_MAX}/-${ELO_LOSS_MAX}. Something wrote this rating twice.`);
  }

  return { before, after, delta, placement: false };
}


/**
 * Compute new ratings from what the players are rated RIGHT NOW.
 *
 * calculateNewRatings returns an ABSOLUTE value, and every engine was feeding
 * it the elo cached on the socket when the player joined the queue. Those drift
 * apart the moment a player finishes another match, and the absolute write then
 * produces a delta that is not the gain at all:
 *
 *   socket says 1000, profile is actually 1016
 *   calculateNewRatings(1000, 1000) -> 1020
 *   writing 1020 over 1016 is +4, on a win worth +20
 *
 * That is the whole bug. The swing is only ever eloGain or eloLoss when it is
 * computed from the rating as it stands at settlement.
 *
 * Bots have no profile row, so their nominal rating is used as-is. A read that
 * fails falls back to the cached value — a rating that moves by slightly the
 * wrong amount beats a match that fails to settle.
 *
 * Returns the BEFORE values too, so a result screen can show the true delta
 * rather than subtracting from its own stale copy.
 */
async function freshRatings(supabase, winner, loser) {
  const read = async (p) => {
    const cached = Number(p && p.elo) || 1000;
    if (!supabase || !p || p.isBot || !p.userId) return cached;
    try {
      const { data } = await supabase.from('profiles').select('elo').eq('id', p.userId).single();
      if (data && Number.isFinite(Number(data.elo))) return Number(data.elo);
    } catch (e) {
      console.error('[elo] could not read current rating:', e.message);
    }
    return cached;
  };

  const winnerBefore = await read(winner);
  const loserBefore  = await read(loser);
  const { newWinnerElo, newLoserElo } = calculateNewRatings(winnerBefore, loserBefore);

  // A swing outside the possible range is reported here, with both ratings,
  // because +44 was seen in production and could not be reproduced by
  // reasoning about the code. calculateNewRatings can only ever produce
  // +20..+23 / -17..-20 from the numbers it is given, so if the CARD shows
  // something else, either these before-values are not what the card
  // subtracts from, or the rating moved again between here and the write.
  // This line says which, the next time it happens.
  const wSwing = newWinnerElo - winnerBefore;
  const lSwing = loserBefore - newLoserElo;
  if (wSwing > ELO_GAIN_MAX || lSwing > ELO_LOSS_MAX) {
    console.error(
      `[elo] IMPOSSIBLE SWING computed — winner ${winner?.userId}: ${winnerBefore} -> ${newWinnerElo} (+${wSwing}), ` +
      `loser ${loser?.userId}: ${loserBefore} -> ${newLoserElo} (-${lSwing}). ` +
      `Max is +${ELO_GAIN_MAX}/-${ELO_LOSS_MAX}.`);
  }

  return { winnerBefore, loserBefore, newWinnerElo, newLoserElo };
}
module.exports = { eloGain, eloLoss, applyMatchStreaks, calculateNewRatings, freshRatings, updateElo, updateStreaks, applyEloUpdate, applyEloAndMeasure, ELO_GAIN_MAX, ELO_LOSS_MAX };
