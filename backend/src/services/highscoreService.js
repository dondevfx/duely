async function updateHighscore(supabase, userId, gameType, score) {
  if (!supabase || !userId || score == null || score <= 0) return;
  try {
    // Read current best first so we only write if this score beats it
    const { data: existing } = await supabase
      .from('game_highscores')
      .select('score')
      .eq('user_id', userId)
      .eq('game_type', gameType)
      .maybeSingle();
    if (!existing) {
      const { error } = await supabase.from('game_highscores').insert({ user_id: userId, game_type: gameType, score });
      if (error) console.error('[highscoreService] insert error:', error.message);
    } else if (score > existing.score) {
      const { error } = await supabase.from('game_highscores').update({ score, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('game_type', gameType);
      if (error) console.error('[highscoreService] update error:', error.message);
    }
  } catch (e) { console.error('[highscoreService] updateHighscore error:', e.message); }
}

/**
 * Records a highscore plus an associated stat (e.g. Rush Hour's score AND the
 * survival time of that exact run). The companion is stored as its own
 * game_type row so no schema change is needed, and it is only written when the
 * primary score is actually beaten — so the two always describe the SAME run.
 */
async function updateHighscorePair(supabase, userId, gameType, score, companionType, companionValue) {
  if (!supabase || !userId || score == null || score <= 0) return;
  try {
    const { data: existing } = await supabase
      .from('game_highscores')
      .select('score')
      .eq('user_id', userId)
      .eq('game_type', gameType)
      .maybeSingle();

    const isBest = !existing || score > existing.score;
    if (!isBest) return;

    if (!existing) {
      await supabase.from('game_highscores').insert({ user_id: userId, game_type: gameType, score });
    } else {
      await supabase.from('game_highscores').update({ score, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('game_type', gameType);
    }

    if (companionType && companionValue != null) {
      const { data: cExisting } = await supabase
        .from('game_highscores')
        .select('score')
        .eq('user_id', userId)
        .eq('game_type', companionType)
        .maybeSingle();
      if (!cExisting) {
        await supabase.from('game_highscores').insert({ user_id: userId, game_type: companionType, score: Math.round(companionValue) });
      } else {
        await supabase.from('game_highscores').update({ score: Math.round(companionValue), updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('game_type', companionType);
      }
    }
  } catch (e) { console.error('[highscoreService] updateHighscorePair error:', e.message); }
}

module.exports = { updateHighscore, updateHighscorePair };
