const express = require('express');
const { requireAuth } = require('../middleware/auth');

/**
 * Player reports.
 *
 * The half of moderation that automation cannot do. Sightengine catches
 * explicit imagery on upload; it cannot tell that an avatar is a photo of a
 * real person being impersonated, or that someone is cheating. Those only
 * surface because another player says so.
 */

const REASONS = new Set(['pfp', 'cheating', 'other']);
const MAX_DETAILS = 500;

module.exports = function reportRoutes(supabase) {
  const router = express.Router();

  router.post('/', requireAuth, async (req, res) => {
    const reporterId = req.user.id;
    const reportedId = String(req.body?.userId || '');
    const reason     = String(req.body?.reason || '');
    const details    = String(req.body?.details || '').trim().slice(0, MAX_DETAILS) || null;

    if (!REASONS.has(reason)) {
      return res.status(400).json({ error: 'Choose a reason for the report.' });
    }
    if (!reportedId) {
      return res.status(400).json({ error: 'No player specified.' });
    }
    // Also enforced by a CHECK constraint — this is only for a clearer message.
    if (reportedId === reporterId) {
      return res.status(400).json({ error: 'You cannot report yourself.' });
    }

    // Confirm the target exists, so a typo'd or guessed id becomes a clean
    // 404 rather than a foreign-key error surfacing as a 500.
    const { data: target } = await supabase
      .from('profiles').select('id').eq('id', reportedId).maybeSingle();
    if (!target) return res.status(404).json({ error: 'Player not found.' });

    const { error } = await supabase.from('player_reports').insert({
      reporter_id: reporterId,
      reported_id: reportedId,
      reason,
      details,
    });

    if (error) {
      // uniq_open_report_per_reporter. Reported as success on purpose: from
      // the player's side the outcome is identical — this person is already
      // reported for this — and saying "duplicate" invites them to work out
      // what else they can file to make the count go up.
      if (error.code === '23505') return res.json({ ok: true, duplicate: true });
      console.error('[reports] insert failed:', error.message);
      return res.status(500).json({ error: 'Could not file that report.' });
    }

    res.json({ ok: true });
  });

  return router;
};

module.exports.REASONS = REASONS;
