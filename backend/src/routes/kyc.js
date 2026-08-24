const express = require('express');
const { requireAuth } = require('../middleware/auth');
const didit = require('../services/diditService');

/**
 * Identity verification.
 *
 * Gates BANK withdrawals only — see the note in withdrawalGuards. Crypto
 * withdrawals are not gated, so a player who never cashes out to a bank never
 * triggers a verification and never costs us one.
 *
 * Verification itself is Didit's job: the player uploads an ID, takes a selfie,
 * and Didit checks the document is genuine, the face matches it and the person
 * is live. We never see or store the document. This route starts a session and
 * hands back a link; the answer arrives at /api/webhooks/didit.
 *
 * There is no manual identity form any more. The one that existed collected a
 * name, address and date of birth for an admin to eyeball, which verified
 * nothing — anyone could type a plausible name and be approved.
 */
module.exports = function kycRoutes(supabase) {
  const router = express.Router();

  // Where Didit sends the player when they are done. Their browser lands back
  // on the wallet; the actual decision arrives separately by webhook, which is
  // why this carries no result in the URL — a client-supplied "I passed" is not
  // something to trust.
  const returnUrl = () =>
    `${process.env.PUBLIC_APP_URL || 'https://duely.us'}/wallet?verified=1`;

  router.get('/status', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('kyc_status, kyc_reviewed_at, kyc_rejection_reason')
      .eq('id', req.user.id)
      .single();

    if (error) {
      if (/kyc_status/.test(error.message || '')) {
        console.warn('[kyc] profiles.kyc_status is missing — run PENDING_SQL section 13.');
        return res.json({ status: 'unverified', reviewedAt: null, rejectionReason: null, configured: didit.isConfigured() });
      }
      return res.status(500).json({ error: error.message });
    }

    res.json({
      status:          data?.kyc_status ?? 'unverified',
      reviewedAt:      data?.kyc_reviewed_at ?? null,
      rejectionReason: data?.kyc_rejection_reason ?? null,
      // The page needs to know whether verification can even be started, so it
      // can say "not available yet" rather than offering a button that fails.
      configured:      didit.isConfigured(),
    });
  });

  /**
   * Starts a verification and returns the URL to send the player to.
   */
  router.post('/session', requireAuth, async (req, res) => {
    const userId = req.user.id;

    const { data: profile, error: readErr } = await supabase
      .from('profiles').select('kyc_status').eq('id', userId).single();
    if (readErr) return res.status(500).json({ error: readErr.message });

    // Already verified: do not start a second session. Verification is once,
    // and each one costs money past the free allowance.
    if (profile?.kyc_status === 'approved') {
      return res.status(400).json({ error: 'You are already verified.' });
    }

    // A session already waiting on Didit or on their reviewer — reuse its link
    // rather than paying for another check the player has not finished.
    const { data: open } = await supabase
      .from('kyc_submissions')
      .select('didit_session_id, didit_url, status')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (open?.didit_url) {
      return res.json({ url: open.didit_url, reused: true });
    }

    let session;
    try {
      session = await didit.createSession(userId, { callbackUrl: returnUrl() });
    } catch (e) {
      if (e.notConfigured) {
        return res.status(503).json({ error: 'Identity verification is not switched on yet. Please try again later.' });
      }
      console.error('[kyc] could not create a Didit session:', e.message);
      return res.status(502).json({ error: 'Could not start verification. Try again shortly.' });
    }

    // Recorded BEFORE the player is sent anywhere. If the row failed to write,
    // the webhook would arrive with a session id matching nothing and the
    // decision would land on no account.
    const { error: insErr } = await supabase.from('kyc_submissions').insert({
      user_id:          userId,
      didit_session_id: session.sessionId,
      didit_url:        session.url,
      status:           'pending',
    });

    if (insErr) {
      console.error(`[kyc] CRITICAL: Didit session ${session.sessionId} created for ${userId} but not recorded:`, insErr.message);
      return res.status(500).json({ error: 'Could not start verification. Contact support.' });
    }

    const { error: gateErr } = await supabase
      .from('profiles')
      .update({ kyc_status: 'pending', kyc_rejection_reason: null })
      .eq('id', userId);

    if (gateErr) console.error('[kyc] gate did not move to pending:', gateErr.message);

    res.json({ url: session.url });
  });

  /**
   * Asks Didit directly, rather than waiting for a webhook that may never come.
   *
   * The webhook is the normal path. This is the recovery one: a delivery that
   * was dropped, retried past its window, or discarded leaves a player finished
   * at Didit and 'pending' here forever, with nothing able to move them. It is
   * safe to call at any time — it reads Didit's answer and applies exactly the
   * same mapping the webhook does, so it can only ever agree with it.
   */
  router.post('/refresh', requireAuth, async (req, res) => {
    const userId = req.user.id;

    const { data: row, error: rowErr } = await supabase
      .from('kyc_submissions')
      .select('id, didit_session_id')
      .eq('user_id', userId)
      .not('didit_session_id', 'is', null)
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (rowErr) return res.status(500).json({ error: rowErr.message });
    if (!row?.didit_session_id) {
      return res.status(400).json({ error: 'You have not started a verification yet.' });
    }

    let session;
    try {
      session = await didit.fetchSession(row.didit_session_id);
    } catch (e) {
      if (e.notConfigured) return res.status(503).json({ error: 'Identity verification is not switched on yet.' });
      console.error('[kyc] refresh lookup failed:', e.message);
      return res.status(502).json({ error: 'Could not reach the verification provider.' });
    }

    // Same mapping as the webhook. Two places deciding what "In Review" means
    // is how they end up disagreeing.
    const status = didit.mapStatus(session.status);
    const reason = status === 'rejected' ? (session.reason || 'Your verification was not approved.') : null;

    await supabase.from('kyc_submissions').update({
      didit_status: session.status,
      status:       status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'pending',
      decision:     session ?? null,
      reviewed_at:  new Date().toISOString(),
    }).eq('id', row.id);

    const { error: gateErr } = await supabase
      .from('profiles')
      .update({
        kyc_status:           status,
        kyc_reviewed_at:      new Date().toISOString(),
        kyc_rejection_reason: reason,
      })
      .eq('id', userId);

    if (gateErr) {
      console.error(`[kyc] refresh read ${session.status} for ${userId} but the gate did not move:`, gateErr.message);
      return res.status(500).json({ error: 'Could not update your status. Contact support.' });
    }

    console.log(`[kyc] refresh: ${userId} -> ${session.status} (${status})`);
    res.json({ status, diditStatus: session.status });
  });

  return router;
};
