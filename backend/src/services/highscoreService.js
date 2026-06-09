async function updateHighscore(supabase, userId, gameType, score) {
  if (!supabase || !userId || score == null || score <= 0) return;
  try {
    const { data: existing } = await supabase
      .from('game_highscores')
      .select('score')
      .eq('user_id', userId)
      .eq('game_type', gameType)
      .single();
    if (!existing || score > existing.score) {
      await supabase.from('game_highscores').upsert(
        { user_id: userId, game_type: gameType, score, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,game_type' }
      );
    }
  } catch (e) { /* silent — table may not exist */ }
}

module.exports = { updateHighscore };
