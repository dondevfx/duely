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

    const { error } = await supabase
      .from('profiles')
      .update({ applied_affiliate_code: raw, applied_code_expires_at: expiresAt })
      .eq('id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, code: raw, ownerUsername: owner.username, expiresAt });
  });

  // POST /api/affiliate/collect-earnings — transfer accumulated earnings to balance
  router.post('/collect-earnings', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('affiliate_earnings_c, affiliate_earnings_diamonds')
      .eq('id', req.user.id)
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const earningsC = parseFloat(data.affiliate_earnings_c ?? 0);

    if (earningsC <= 0) {
      return res.status(400).json({ error: 'No earnings to collect' });
    }

    const { error: resetError } = await supabase
      .from('profiles')
      .update({ affiliate_earnings_c: 0 })
      .eq('id', req.user.id);
    if (resetError) return res.status(500).json({ error: resetError.message });

    try {
      await creditCoins(supabase, req.user.id, earningsC);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    res.json({ success: true, collected_c: earningsC });
  });

  // DELETE /api/affiliate/apply-code — remove applied code
  router.delete('/apply-code', requireAuth, async (req, res) => {
    await supabase
      .from('profiles')
      .update({ applied_affiliate_code: null, applied_code_expires_at: null })
      .eq('id', req.user.id);
    res.json({ success: true });
  });

  return router;
};
