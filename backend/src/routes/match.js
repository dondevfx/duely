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
        game_type,
        played_at,
        winner:profiles!winner_id(username)
      `)
      .not('winner_id', 'is', null)
      .order('played_at', { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });

    // also try to get diamond fee if column exists (added by later migration)
    const rows = (data ?? []).map(r => ({ ...r, entry_fee_diamonds: r.entry_fee_diamonds ?? 0 }));
    res.json(rows);
  });

  router.get('/history/:userId', requireAuth, async (req, res) => {
    const userId = req.user.id; // always use authenticated user's ID — ignore URL param
    const { data, error } = await supabase
      .from('matches')
      .select(`
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
        winner:profiles!winner_id(username)
      `)
      .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
      .order('played_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  return router;
};
