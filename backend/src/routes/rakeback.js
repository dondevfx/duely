const express = require('express');
const { requireAuth } = require('../middleware/auth');

/**
 * Returns the most recent Monday midnight UTC on or before `date`.
 */
function lastMondayUTC(date = new Date()) {
  const d = new Date(date);
  // getUTCDay(): 0=Sun,1=Mon,...,6=Sat
  const day = d.getUTCDay();
  // Days since last Monday (Monday=0 offset, Sun=6 days back, Mon=0, Tue=1, ...)
  const daysSinceMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

module.exports = function rakebackRoutes(supabase) {
  const router = express.Router();

  // GET /api/rakeback — return rakeback balances and claimability for current user
  router.get('/', requireAuth, async (req, res) => {
    try {
      const { data: p, error } = await supabase
        .from('profiles')
        .select('rakeback_instant, rakeback_daily, rakeback_daily_at, rakeback_weekly, rakeback_weekly_at, rakeback_instant_at')
        .eq('id', req.user.id)
        .single();

      if (error) return res.status(500).json({ error: error.message });

      const now = new Date();
      const instant = p?.rakeback_instant ?? 0;
      const daily   = p?.rakeback_daily   ?? 0;
      const weekly  = p?.rakeback_weekly  ?? 0;

      // Instant claimable: balance > 0 AND (no prior claim OR 5 minutes have passed)
      const instantAt = p?.rakeback_instant_at ? new Date(p.rakeback_instant_at) : null;
      const INSTANT_COOLDOWN = 5 * 60 * 1000;
      const instantClaimable = Math.floor(instant) >= 1 && (instantAt === null || (now - instantAt) >= INSTANT_COOLDOWN);
      const instantNextAt = !instantClaimable && instantAt ? new Date(instantAt.getTime() + INSTANT_COOLDOWN).toISOString() : null;

      // Daily claimable: daily_at is null OR more than 24h ago, AND balance > 0
      const dailyAt = p?.rakeback_daily_at ? new Date(p.rakeback_daily_at) : null;
      const dailyClaimable = Math.floor(daily) >= 1 && (dailyAt === null || (now - dailyAt) >= 24 * 60 * 60 * 1000);
      const dailyNextAt = !dailyClaimable && dailyAt ? new Date(dailyAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null;

      // Weekly claimable: weekly_at is null OR before the most recent Monday midnight UTC, AND balance > 0
      const weeklyAt = p?.rakeback_weekly_at ? new Date(p.rakeback_weekly_at) : null;
      const lastMonday = lastMondayUTC(now);
      const weeklyClaimable = Math.floor(weekly) >= 1 && (weeklyAt === null || weeklyAt < lastMonday);

      function nextMondayUTC(from) {
        const d = new Date(from);
        const day = d.getUTCDay(); // 0=Sun
        const daysUntilMonday = (8 - day) % 7 || 7;
        d.setUTCDate(d.getUTCDate() + daysUntilMonday);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      }
      const weeklyNextAt = !weeklyClaimable ? nextMondayUTC(now).toISOString() : null;

      return res.json({ instant, instantClaimable, instantNextAt, daily, dailyClaimable, dailyNextAt, weekly, weeklyClaimable, weeklyNextAt });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/rakeback/claim/instant — atomic via Postgres RPC (no race condition)
  router.post('/claim/instant', requireAuth, async (req, res) => {
    try {
      const { data: amount, error } = await supabase
        .rpc('claim_rakeback_instant', { p_user_id: req.user.id });
      if (error) {
        const msg = error.message || '';
        if (msg.includes('nothing_to_claim')) return res.status(400).json({ error: 'No instant rakeback to claim' });
        if (msg.includes('cooldown_active')) return res.status(400).json({ error: 'Instant rakeback on cooldown' });
        return res.status(500).json({ error: msg });
      }
      return res.json({ claimed: amount });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/rakeback/claim/daily — atomic via Postgres RPC (no race condition)
  router.post('/claim/daily', requireAuth, async (req, res) => {
    try {
      const { data: amount, error } = await supabase
        .rpc('claim_rakeback_daily', { p_user_id: req.user.id });
      if (error) {
        const msg = error.message || '';
        if (msg.includes('nothing_to_claim')) return res.status(400).json({ error: 'No daily rakeback to claim' });
        if (msg.includes('cooldown_active')) return res.status(400).json({ error: 'Daily rakeback not yet claimable' });
        return res.status(500).json({ error: msg });
      }
      return res.json({ claimed: amount });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/rakeback/claim/weekly — atomic via Postgres RPC (no race condition)
  router.post('/claim/weekly', requireAuth, async (req, res) => {
    try {
      const { data: amount, error } = await supabase
        .rpc('claim_rakeback_weekly', { p_user_id: req.user.id });
      if (error) {
        const msg = error.message || '';
        if (msg.includes('nothing_to_claim')) return res.status(400).json({ error: 'No weekly rakeback to claim' });
        if (msg.includes('cooldown_active')) return res.status(400).json({ error: 'Weekly rakeback not yet claimable' });
        return res.status(500).json({ error: msg });
      }
      return res.json({ claimed: amount });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
