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

module.exports = { updateHighscore };
