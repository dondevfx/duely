const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

module.exports = function matchRoutes(supabase) {
  const router = Router();

  // Public — recent matches across all players for the home ticker
  router.get('/recent', async (req, res) => {
    const { data, error } = await supabase
      .from('matches')
      .select(`
        id,
        winner_id,
        entry_fee_c,
        entry_fee_diamonds,
        game_type,
        played_at,
        winner:profiles!winner_id(username)
      `)
      .not('winner_id', 'is', null)
      .order('played_at', { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });

    const rows = (data ?? []).map(r => ({ ...r, entry_fee_diamonds: r.entry_fee_diamonds ?? 0 }));
    res.json(rows);
  });

  // The columns the history needs. ended_by_forfeit is listed separately
  // because it arrives with a migration, and this route must keep working if
  // the code ships before the SQL is run — an unknown column makes PostgREST
  // reject the whole select, which would empty every player's match history
  // rather than just drop one label.
  const HISTORY_COLUMNS = `
        id,
        player1_id,
        player2_id,
        winner_id,
        entry_fee_c,
        entry_fee_diamonds,
        prize_pool_c,
        prize_pool_diamonds,
        platform_fee_c,
        reaction_time_ms,
        early_click,
        game_type,
        played_at,
        player1:profiles!player1_id(username),
        player2:profiles!player2_id(username),
        winner:profiles!winner_id(username)`;

  router.get('/history/:userId', requireAuth, async (req, res) => {
    const userId = req.user.id; // always use authenticated user's ID — ignore URL param

    const query = (columns) => supabase
      .from('matches')
      .select(columns)
      .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
      .order('played_at', { ascending: false })
      .limit(50);

    let { data, error } = await query(`${HISTORY_COLUMNS},\n        ended_by_forfeit`);

    if (error && /ended_by_forfeit/.test(error.message || '')) {
      console.warn('[match] ended_by_forfeit is missing — run PENDING_SQL section 12. Serving history without it.');
      ({ data, error } = await query(HISTORY_COLUMNS));
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  return router;
};
