const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { validateCode } = require('../services/affiliateService');
const { creditCoins, creditDiamonds } = require('../services/walletService');

const CODE_TTL_DAYS = 30;

module.exports = function affiliateRoutes(supabase) {
  const router = Router();

  // GET /api/affiliate/status — my code, applied code, earnings
  router.get('/status', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('affiliate_code, applied_affiliate_code, applied_code_expires_at, affiliate_earnings_c, affiliate_earnings_diamonds')
      .eq('id', req.user.id)
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const now = Date.now();
    const expiresAt = data.applied_code_expires_at ? new Date(data.applied_code_expires_at).getTime() : 0;
    const appliedActive = data.applied_affiliate_code && expiresAt > now;

    res.json({
      myCode:           data.affiliate_code || null,
      appliedCode:      appliedActive ? data.applied_affiliate_code : null,
      appliedExpiresAt: appliedActive ? data.applied_code_expires_at : null,
      earnings_c:       parseFloat(data.affiliate_earnings_c ?? 0),
      earnings_diamonds: parseInt(data.affiliate_earnings_diamonds ?? 0),
    });
  });

  // POST /api/affiliate/set-code — create or change your own affiliate code
  router.post('/set-code', requireAuth, async (req, res) => {
    const raw = (req.body.code || '').toString().trim().toUpperCase();
    if (!validateCode(raw)) {
      return res.status(400).json({ error: 'Code must be 4–12 uppercase letters/numbers' });
    }

    // Check if another user already owns this code
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('affiliate_code', raw)
      .single();

    if (existing && existing.id !== req.user.id) {
      return res.status(400).json({ error: 'That code is already taken — pick a different one' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({ affiliate_code: raw })
      .eq('id', req.user.id)
      .select('affiliate_code')
      .single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'That code is already taken — pick a different one' });
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, code: data.affiliate_code });
  });

  // POST /api/affiliate/apply-code — use someone else's code
  router.post('/apply-code', requireAuth, async (req, res) => {
    const raw = (req.body.code || '').toString().trim().toUpperCase();
    if (!validateCode(raw)) {
      return res.status(400).json({ error: 'Invalid code format' });
    }

    // Check code exists and doesn't belong to this user
    const { data: owner } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('affiliate_code', raw)
      .single();

    if (!owner) return res.status(404).json({ error: 'Code not found' });
    if (owner.id === req.user.id) return res.status(400).json({ error: 'You cannot use your own code' });

    const expiresAt = new Date(Date.now() + CODE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // referred_by is the PERMANENT link, used by the referral reward. It is set
    // once and never overwritten: applied_affiliate_code expires and can be
    // swapped for someone else's, and if the referral credit moved with it a
    // player could be re-referred repeatedly and pay out over and over.
    const { data: existing } = await supabase
      .from('profiles').select('referred_by').eq('id', req.user.id).single();

    // The OWNER is pinned here, not looked up from the code at settlement time.
    // Codes are re-nameable: resolving the string later paid whoever held it at
    // that moment, so renaming a code handed your whole downstream to whoever
    // claimed the freed string next.
    const patch = {
      applied_affiliate_code: raw,
      applied_code_expires_at: expiresAt,
      applied_code_owner_id: owner.id,
    };
    if (!existing?.referred_by) patch.referred_by = owner.id;

    let { error } = await supabase.from('profiles').update(patch).eq('id', req.user.id);
    // Before PENDING_SQL section 8 the column does not exist. Applying a code
    // must still work — resolveAffiliates falls back to the string lookup.
    if (error && /applied_code_owner_id/i.test(error.message || '')) {
      const { applied_code_owner_id, ...legacy } = patch;
      ({ error } = await supabase.from('profiles').update(legacy).eq('id', req.user.id));
      if (!error) console.warn('[affiliate] applied_code_owner_id missing — run PENDING_SQL section 8');
    }

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, code: raw, ownerUsername: owner.username, expiresAt });
  });

  // POST /api/affiliate/collect-earnings — transfer accumulated earnings to balance
  router.post('/collect-earnings', requireAuth, async (req, res) => {
    // Read first so we know the old value (Supabase .update().select() returns
    // the NEW value after update, so we can't use it to get the pre-zero amount).
    const { data: profile, error: readErr } = await supabase
      .from('profiles')
      .select('affiliate_earnings_c')
      .eq('id', req.user.id)
      .single();

    if (readErr || !profile) return res.status(500).json({ error: 'Failed to read profile' });

    const earningsC = parseFloat(profile.affiliate_earnings_c ?? 0);
    if (earningsC <= 0) return res.status(400).json({ error: 'No earnings to collect' });

    // Zero out — use .gte so floating-point noise doesn't block the update.
    // Return the affected row so we can confirm THIS request is the one that
    // actually zeroed the earnings. Without this check, two concurrent requests
    // both read the same earningsC, both fall through to creditCoins, and the
    // user is credited twice while earnings are deducted once (a mintable race).
    const { data: zeroed, error: zeroErr } = await supabase
      .from('profiles')
      .update({ affiliate_earnings_c: 0 })
      .eq('id', req.user.id)
      .gte('affiliate_earnings_c', earningsC)
      .select('id');

    if (zeroErr) return res.status(500).json({ error: 'Failed to zero earnings' });
    // 0 rows affected → another concurrent request already collected. Abort
    // without crediting so earnings can never be double-collected.
    if (!zeroed || zeroed.length === 0) {
      return res.status(400).json({ error: 'No earnings to collect' });
    }

    try {
      await creditCoins(supabase, req.user.id, earningsC);
    } catch (e) {
      // Credit failed — restore earnings so they aren't lost
      await supabase
        .from('profiles')
        .update({ affiliate_earnings_c: earningsC })
        .eq('id', req.user.id);
      return res.status(500).json({ error: e.message });
    }

    res.json({ success: true, collected_c: earningsC });
  });

  // DELETE /api/affiliate/apply-code — remove applied code
  router.delete('/apply-code', requireAuth, async (req, res) => {
    // Clear the pinned owner too, or the code reads as removed while the
    // earnings keep flowing to whoever it pointed at.
    const patch = { applied_affiliate_code: null, applied_code_expires_at: null, applied_code_owner_id: null };
    const { error } = await supabase.from('profiles').update(patch).eq('id', req.user.id);
    if (error && /applied_code_owner_id/i.test(error.message || '')) {
      await supabase.from('profiles')
        .update({ applied_affiliate_code: null, applied_code_expires_at: null })
        .eq('id', req.user.id);
    }
    res.json({ success: true });
  });

  return router;
};
