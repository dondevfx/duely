const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { isDemo, DEMO_IDS } = require('../services/demoAccounts');

module.exports = function authRoutes(supabase) {
  const router = Router();

  // Upsert profile on first login
  router.post('/profile', requireAuth, async (req, res) => {
    const { username, wallet_address } = req.body;
    const userId = req.user.id;

    if (!username || typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 20) {
      return res.status(400).json({ error: 'Username must be 3–20 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      return res.status(400).json({ error: 'Username may only contain letters, numbers, and underscores' });
    }

    // Check if profile already exists (username conflict returns cleaner error)
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    let data, error;
    if (existing) {
      ({ data, error } = await supabase
        .from('profiles')
        .update({ username: username.trim(), wallet_address: wallet_address || null })
        .eq('id', userId)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('profiles')
        .insert({ id: userId, username: username.trim(), wallet_address: wallet_address || null })
        .select()
        .single());
    }

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already taken' });
      return res.status(400).json({ error: error.message });
    }
    res.json(data);
  });

  // Get current user profile
  router.get('/me', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) return res.status(404).json({ error: 'Profile not found' });
    res.json({ ...data, is_admin: req.user.id === process.env.ADMIN_USER_ID });
  });

  const VALID_COLORS = new Set([
    '#1E90FF','#00BFFF','#22c55e','#ef4444','#f97316',
    '#a855f7','#ec4899','#eab308','#06b6d4','#14b8a6','#f43f5e','#e2e8f0',
  ]);

  // Update username, wallet address, profile color, or privacy setting
  router.patch('/me', requireAuth, async (req, res) => {
    const { username, wallet_address, profile_color, is_private } = req.body;
    const updates = {};
    if (username) {
      const u = username.trim();
      if (u.length < 3 || u.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
      if (!/^[a-zA-Z0-9_]+$/.test(u)) return res.status(400).json({ error: 'Username may only contain letters, numbers, and underscores' });
      updates.username = u;
    }
    if (wallet_address !== undefined) updates.wallet_address = wallet_address;
    if (profile_color !== undefined) {
      if (!VALID_COLORS.has(profile_color)) return res.status(400).json({ error: 'Invalid color' });
      updates.profile_color = profile_color;
    }
    if (is_private !== undefined) updates.is_private = !!is_private;

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Username already taken' });
      return res.status(400).json({ error: error.message });
    }
    res.json(data);
  });

  // Public profile (for chat popup) — returns rank + total_wagered
  router.get('/public/:userId', requireAuth, async (req, res) => {
    const { userId } = req.params;

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, elo, wins, losses, created_at, profile_color')
      .eq('id', userId)
      .single();

    if (!profile) return res.status(404).json({ error: 'User not found' });

    const adminId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';

    const [{ count: eloAbove }, { data: wagered }, { data: diaTxs }] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true })
        .neq('id', adminId).neq('is_private', true).gt('elo', profile.elo ?? 0),
      supabase.from('matches').select('entry_fee_c').or(`player1_id.eq.${userId},player2_id.eq.${userId}`),
      supabase.from('transactions')
        .select('amount_c, crypto_amount, type, crypto_symbol')
        .eq('user_id', userId)
        .in('type', ['match_loss', 'match_win']),
    ]);

    const rank = (eloAbove ?? 0) + 1;

    const totalWagered = parseFloat(
      ((wagered || []).reduce((s, m) => s + (Number(m.entry_fee_c) || 0), 0)).toFixed(4)
    );

    // Diamond wagered: losses = entry fee directly; wins = payout / 1.9 (reverse 95% of 2x)
    let totalWageredDiamonds = 0;
    for (const tx of (diaTxs || [])) {
      if (tx.crypto_symbol !== 'diamonds') continue;
      const amt = Number(tx.crypto_amount) || 0;
      if (tx.type === 'match_loss') totalWageredDiamonds += amt;
      else if (tx.type === 'match_win') totalWageredDiamonds += Math.round(amt / 1.9);
    }

    res.json({ ...profile, rank, total_wagered: totalWagered, total_wagered_diamonds: totalWageredDiamonds });
  });

  // Per-game stats for profile highscores section
  router.get('/game-stats', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('matches')
      .select('game_type, winner_id')
      .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
      .not('game_type', 'is', null);

    if (error) return res.status(500).json({ error: error.message });

    const stats = {};
    for (const m of (data || [])) {
      const gt = m.game_type;
      if (!stats[gt]) stats[gt] = { gameType: gt, played: 0, wins: 0 };
      stats[gt].played++;
      if (m.winner_id === userId) stats[gt].wins++;
    }

    res.json(Object.values(stats));
  });

  // Coin balance history (reconstructed from transactions). ?days=7|30|90 (default 90)
  router.get('/coin-history/:userId', requireAuth, async (req, res) => {
    const { userId } = req.params;
    const DAYS = Math.min(90, Math.max(1, parseInt(req.query.days) || 90));
    const startDate = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    const [{ data: prof }, { data: txs }] = await Promise.all([
      supabase.from('profiles').select('c_coins').eq('id', userId).single(),
      supabase.from('transactions')
        .select('amount_c, type, created_at')
        .eq('user_id', userId)
        .gte('created_at', startDate.toISOString())
        .order('created_at', { ascending: true }),
    ]);

    if (!prof) return res.status(404).json({ error: 'Not found' });

    // Plot one point per transaction (not bucketed by day) so individual
    // wins/losses within the same day show as real ups/downs instead of
    // being netted into a single flat daily step.
    const DEBITS = new Set(['withdrawal', 'match_loss']);
    let running = 0;
    const points = [{ date: startDate.toISOString(), balance: 0 }];
    for (const tx of (txs || [])) {
      const amt = parseFloat(tx.amount_c) || 0;
      if (amt === 0) continue; // diamond-only entries don't move the coin balance
      const signed = DEBITS.has(tx.type) ? -amt : amt;
      running += signed;
      points.push({ date: tx.created_at, balance: parseFloat(running.toFixed(2)) });
    }

    // Cap payload size for very active accounts — keep the starting point
    // plus the most recent MAX_POINTS transactions.
    const MAX_POINTS = 800;
    const trimmed = points.length > MAX_POINTS
      ? [points[0], ...points.slice(points.length - (MAX_POINTS - 1))]
      : points;

    res.json(trimmed);
  });

  // Personal best highscores for profile page
  router.get('/highscores', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { data } = await supabase
      .from('game_highscores')
      .select('game_type, score, updated_at')
      .eq('user_id', userId)
      .order('score', { ascending: false });
    res.json(data || []);
  });

  // ── Friends ─────────────────────────────────────────────────────────

  router.get('/friends', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { data, error } = await supabase
      .from('friends')
      .select(`
        id, status, created_at,
        requester:requester_id(id, username, elo, profile_color, current_streak),
        addressee:addressee_id(id, username, elo, profile_color, current_streak)
      `)
      .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  const ADMIN_ID = process.env.ADMIN_USER_ID;

  // Send by username (from profile friends panel)
  router.post('/friend-request', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const { data: target } = await supabase.from('profiles').select('id').eq('username', username.trim()).maybeSingle();
    if (!target || target.id === ADMIN_ID || isDemo(target.id)) return res.status(404).json({ error: 'User not found' });
    if (target.id === myId) return res.status(400).json({ error: 'Cannot friend yourself' });
    const { data: existing } = await supabase.from('friends').select('id,status')
      .or(`and(requester_id.eq.${myId},addressee_id.eq.${target.id}),and(requester_id.eq.${target.id},addressee_id.eq.${myId})`)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already sent' });
    const { error } = await supabase.from('friends').insert({ requester_id: myId, addressee_id: target.id });
    if (error) return res.status(400).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  // Send by userId (from chat popup)
  router.post('/friend-request-by-id', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (userId === myId) return res.status(400).json({ error: 'Cannot friend yourself' });
    if (userId === ADMIN_ID || isDemo(userId)) return res.status(404).json({ error: 'User not found' });
    const { data: existing } = await supabase.from('friends').select('id,status')
      .or(`and(requester_id.eq.${myId},addressee_id.eq.${userId}),and(requester_id.eq.${userId},addressee_id.eq.${myId})`)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already sent' });
    const { error } = await supabase.from('friends').insert({ requester_id: myId, addressee_id: userId });
    if (error) return res.status(400).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  router.post('/friend-accept/:id', requireAuth, async (req, res) => {
    const { error } = await supabase.from('friends')
      .update({ status: 'accepted' })
      .eq('id', req.params.id)
      .eq('addressee_id', req.user.id)
      .eq('status', 'pending');
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  });

  router.delete('/friend/:id', requireAuth, async (req, res) => {
    const myId = req.user.id;
    const { error } = await supabase.from('friends').delete()
      .eq('id', req.params.id)
      .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  });

  return router;
};
