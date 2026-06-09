const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { creditDiamonds } = require('../services/walletService');

module.exports = function adminRoutes(supabase) {
  const router = Router();

  function requireAdmin(req, res, next) {
    if (req.user.id !== process.env.ADMIN_USER_ID)
      return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  // ── Stats overview ────────────────────────────────────────────────────
  router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      { count: totalUsers },
      { count: totalMatches },
      { count: matchesToday },
      { count: newUsersToday },
      { data: adminProfile },
      { data: matchData },
      { count: pendingWithdrawals },
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }),
      supabase.from('matches').select('id', { count: 'exact', head: true }).gte('played_at', todayStart.toISOString()),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString()),
      supabase.from('profiles').select('c_coins, diamonds').eq('id', process.env.ADMIN_USER_ID).single(),
      supabase.from('matches').select('entry_fee_c, prize_pool_c'),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('type', 'withdrawal').eq('status', 'pending'),
    ]);

    const totalWagered = (matchData || []).reduce((s, m) => s + (Number(m.entry_fee_c) || 0), 0);

    res.json({
      total_users:        totalUsers   ?? 0,
      total_matches:      totalMatches ?? 0,
      matches_today:      matchesToday ?? 0,
      new_users_today:    newUsersToday ?? 0,
      fees_coins:         parseFloat((adminProfile?.c_coins ?? 0).toFixed(2)),
      fees_diamonds:      adminProfile?.diamonds ?? 0,
      total_wagered:      parseFloat(totalWagered.toFixed(2)),
      pending_withdrawals: pendingWithdrawals ?? 0,
    });
  });

  // ── Recent transactions ───────────────────────────────────────────────
  router.get('/transactions', requireAuth, requireAdmin, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('transactions')
      .select('*, profiles(username, profile_color)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── Users list ────────────────────────────────────────────────────────
  router.get('/users', requireAuth, requireAdmin, async (req, res) => {
    const { search } = req.query;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);

    let query = supabase
      .from('profiles')
      .select('id, username, elo, wins, losses, c_coins, diamonds, created_at, profile_color')
      .neq('id', process.env.ADMIN_USER_ID)
      .order('c_coins', { ascending: false })
      .limit(limit);

    if (search) query = query.ilike('username', `%${search}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── Clear admin coins ─────────────────────────────────────────────────
  router.post('/clear-coins', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase
      .from('profiles')
      .update({ c_coins: 0 })
      .eq('id', process.env.ADMIN_USER_ID);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  // ── Add 5M diamonds to admin account ─────────────────────────────────
  router.post('/add-diamonds', requireAuth, requireAdmin, async (req, res) => {
    try {
      await creditDiamonds(supabase, process.env.ADMIN_USER_ID, 5_000_000);
      const { data } = await supabase.from('profiles').select('diamonds').eq('id', process.env.ADMIN_USER_ID).single();
      res.json({ success: true, diamonds: data?.diamonds });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Set creator code on a user ────────────────────────────────────────
  // SQL required once: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_creator_code boolean DEFAULT false;
  router.post('/set-creator-code', requireAuth, requireAdmin, async (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: 'username and code are required' });

    const raw = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(raw)) return res.status(400).json({ error: 'Code must be 4-12 alphanumeric characters' });

    // Find target user
    const { data: target, error: findErr } = await supabase
      .from('profiles').select('id, username').ilike('username', username.trim()).single();
    if (findErr || !target) return res.status(404).json({ error: 'User not found' });

    // Check code not already taken by someone else
    const { data: taken } = await supabase
      .from('profiles').select('id').eq('affiliate_code', raw).single();
    if (taken && taken.id !== target.id) return res.status(400).json({ error: 'Code already in use by another user' });

    const { error: updErr } = await supabase
      .from('profiles')
      .update({ affiliate_code: raw, is_creator_code: true })
      .eq('id', target.id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    res.json({ success: true, userId: target.id, username: target.username, code: raw });
  });

  // ── Adjust admin's own ELO by delta ──────────────────────────────────
  router.post('/adjust-elo', requireAuth, requireAdmin, async (req, res) => {
    const delta = parseInt(req.body.delta, 10);
    if (!delta || isNaN(delta)) return res.status(400).json({ error: 'delta required' });

    const { data: current } = await supabase
      .from('profiles')
      .select('elo')
      .eq('id', req.user.id)
      .single();

    const newElo = Math.max(0, (current?.elo ?? 1000) + delta);

    const { error } = await supabase
      .from('profiles')
      .update({ elo: newElo })
      .eq('id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ elo: newElo, delta });
  });

  // ── Remove admin's own coin balance ──────────────────────────────────
  router.post('/remove-coins', requireAuth, requireAdmin, async (req, res) => {
    const { error } = await supabase
      .from('profiles')
      .update({ c_coins: 0 })
      .eq('id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  });

  // ── Remove creator code from a user ──────────────────────────────────
  router.post('/remove-creator-code', requireAuth, requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const { data: target } = await supabase
      .from('profiles').select('id').ilike('username', username.trim()).single();
    if (!target) return res.status(404).json({ error: 'User not found' });

    const { error } = await supabase
      .from('profiles')
      .update({ is_creator_code: false })
      .eq('id', target.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  });

  return router;
};
