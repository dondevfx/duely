const ELO_CHANGE = 25;

function calculateNewRatings(winnerElo, loserElo) {
  return {
    newWinnerElo: (winnerElo || 1000) + ELO_CHANGE,
    newLoserElo:  Math.max(0, (loserElo  || 1000) - ELO_CHANGE),
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
      if (total < 3) return; // still in placement — no ELO change
    }
    await supabase.from('profiles').update({ elo: newElo }).eq('id', userId);
  } catch (e) {
    console.error('[applyEloUpdate] error:', e.message);
  }
}

module.exports = { applyMatchStreaks, calculateNewRatings, updateElo, updateStreaks, applyEloUpdate };
