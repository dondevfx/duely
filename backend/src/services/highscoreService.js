async function updateHighscore(supabase, userId, gameType, score) {
  if (!supabase || !userId || score == null || score <= 0) return;
  try {
    const { data: existing } = await supabase
      .from('game_highscores')
      .select('score')
      .eq('user_id', userId)
      .eq('game_type', gameType)
      .single();
    if (!existing) {
      await supabase.from('game_highscores').insert({ user_id: userId, game_type: gameType, score });
    } else if (score > existing.score) {
      await supabase.from('game_highscores').update({ score, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('game_type', gameType);
    }
  } catch (e) { console.error('[highscoreService] updateHighscore error:', e.message); }
}

module.exports = { updateHighscore };
