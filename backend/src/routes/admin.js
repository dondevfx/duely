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
      supabase.from('profiles').select('c_coins, diamonds, fee_balance').eq('id', process.env.ADMIN_USER_ID).single(),
      supabase.from('matches').select('prize_pool_c'),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('type', 'withdrawal').eq('status', 'pending'),
    ]);

    // Sum prize_pool_c (both players' fees combined) so total_wagered matches what admin fee is calculated against
    const totalWagered = (matchData || []).reduce((s, m) => s + (Number(m.prize_pool_c) || 0), 0);

    res.json({
      total_users:        totalUsers   ?? 0,
      total_matches:      totalMatches ?? 0,
      matches_today:      matchesToday ?? 0,
      new_users_today:    newUsersToday ?? 0,
      fees_coins:         parseFloat((adminProfile?.c_coins ?? 0).toFixed(2)),
      fees_diamonds:      adminProfile?.diamonds ?? 0,
      fee_balance:        parseFloat((adminProfile?.fee_balance ?? 0).toFixed(4)),
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

  // ── Set a player's ELO by username ──────────────────────────────────
  router.post('/set-player-elo', requireAuth, requireAdmin, async (req, res) => {
    const { username, elo } = req.body;
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username required' });
    const newElo = parseInt(elo, 10);
    if (isNaN(newElo) || newElo < 0) return res.status(400).json({ error: 'elo must be a non-negative number' });

    const { data: player, error: lookupErr } = await supabase
      .from('profiles')
      .select('id, username, elo')
      .ilike('username', username.trim())
      .single();

    if (lookupErr || !player) return res.status(404).json({ error: `No player found with username "${username}"` });

    const { error } = await supabase
      .from('profiles')
      .update({ elo: newElo })
      .eq('id', player.id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ username: player.username, oldElo: player.elo, newElo });
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

  // ── Collect accumulated platform fees into admin's coin balance ──────
  router.post('/collect-fees', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data: collected, error } = await supabase.rpc('collect_admin_fees', {
        admin_id: process.env.ADMIN_USER_ID,
      });
      if (error) return res.status(500).json({ error: error.message });

      const amount = parseFloat(collected ?? 0);
      if (amount > 0) {
        // Log it as a transaction for record-keeping
        await supabase.from('transactions').insert({
          user_id:  process.env.ADMIN_USER_ID,
          type:     'fee_collection',
          amount_c: amount,
          status:   'confirmed',
        }).catch(() => {});
      }

      // Return fresh balances
      const { data: profile } = await supabase
        .from('profiles')
        .select('c_coins, fee_balance')
        .eq('id', process.env.ADMIN_USER_ID)
        .single();

      res.json({
        success:     true,
        collected:   parseFloat(amount.toFixed(4)),
        c_coins:     parseFloat((profile?.c_coins ?? 0).toFixed(4)),
        fee_balance: parseFloat((profile?.fee_balance ?? 0).toFixed(4)),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
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

  // ── Total coins in circulation ────────────────────────────────────────
  router.get('/coin-supply', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .rpc('sum_c_coins');
      if (error) {
        // fallback if RPC doesn't exist
        const { data: rows } = await supabase.from('profiles').select('c_coins');
        const total = (rows || []).reduce((sum, r) => sum + (parseFloat(r.c_coins) || 0), 0);
        return res.json({ total: Math.round(total * 100) / 100 });
      }
      res.json({ total: Math.round((data || 0) * 100) / 100 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
