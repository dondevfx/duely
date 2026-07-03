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

      const INSTANT_COOLDOWN = 5 * 60 * 1000;
      const DAILY_COOLDOWN   = 24 * 60 * 60 * 1000;

      function nextMondayUTC(from) {
        const d = new Date(from);
        const day = d.getUTCDay(); // 0=Sun
        const daysUntilMonday = (8 - day) % 7 || 7;
        d.setUTCDate(d.getUTCDate() + daysUntilMonday);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      }

      // A countdown timer is shown ONLY when the user is on cooldown from a
      // PRIOR claim (the *_at timestamp is set and still within the window).
      // If they've never claimed — or have nothing to claim — there is no timer;
      // they just see "Claim" (disabled when the balance is 0). The timer only
      // starts once a claim is made.

      // Instant — 5 minute cooldown
      const instantAt = p?.rakeback_instant_at ? new Date(p.rakeback_instant_at) : null;
      const instantOnCooldown = instantAt !== null && (now - instantAt) < INSTANT_COOLDOWN;
      const instantClaimable  = Math.floor(instant) >= 1 && !instantOnCooldown;
      const instantNextAt = instantOnCooldown ? new Date(instantAt.getTime() + INSTANT_COOLDOWN).toISOString() : null;

      // Daily — 24 hour cooldown
      const dailyAt = p?.rakeback_daily_at ? new Date(p.rakeback_daily_at) : null;
      const dailyOnCooldown = dailyAt !== null && (now - dailyAt) < DAILY_COOLDOWN;
      const dailyClaimable  = Math.floor(daily) >= 1 && !dailyOnCooldown;
      const dailyNextAt = dailyOnCooldown ? new Date(dailyAt.getTime() + DAILY_COOLDOWN).toISOString() : null;

      // Weekly — resets each Monday 00:00 UTC. On cooldown means already claimed
      // at or after the most recent Monday (never-claimed = weeklyAt null = no timer).
      const weeklyAt = p?.rakeback_weekly_at ? new Date(p.rakeback_weekly_at) : null;
      const lastMonday = lastMondayUTC(now);
      const weeklyOnCooldown = weeklyAt !== null && weeklyAt >= lastMonday;
      const weeklyClaimable  = Math.floor(weekly) >= 1 && !weeklyOnCooldown;
      const weeklyNextAt = weeklyOnCooldown ? nextMondayUTC(now).toISOString() : null;

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
