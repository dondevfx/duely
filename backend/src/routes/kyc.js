const express = require('express');
const { requireAuth } = require('../middleware/auth');

/**
 * Identity verification.
 *
 * Every withdrawal is gated on this — see withdrawalGuards in routes/wallet.js,
 * which both the crypto and the fiat route run before touching a balance.
 *
 * ── What this deliberately does NOT collect ──
 *
 * No SSN, no government ID images, no selfies. Those are what a real KYC
 * provider (Persona, Veriff, Sumsub) collects behind their own compliance and
 * encryption, and holding them ourselves would be a serious liability for data
 * we have no licence to store and no secure way to handle. What is here — legal
 * name, date of birth, address — is the minimum needed to review a payout and
 * to answer a provider's "who is this person" question.
 *
 * That means approval is a HUMAN decision made in the admin screen, not an
 * automated identity check. It is honest about what it is: a manual review
 * queue. When a provider is integrated, `kyc_status` stays the gate and only
 * the thing that sets it changes.
 */

// A person must be 18 to stake money. Checked here rather than trusted from
// the client, which can send any date it likes.
const MIN_AGE_YEARS = 18;

// Full names in a form are messy on purpose — apostrophes, hyphens, accents
// and spaces are all legitimate. Length and the presence of a letter are the
// only things worth asserting.
const NAME_MAX = 120;

function ageOn(dobString, now = new Date()) {
  const dob = new Date(`${dobString}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Validates a submission and returns { fields } or { error }.
 *
 * Kept separate from the route so the rules are readable in one place and can
 * be tested without a request.
 */
function validateSubmission(body) {
  const legal_name    = clean(body?.legalName,    NAME_MAX);
  const address_line1 = clean(body?.addressLine1, 200);
  const address_line2 = clean(body?.addressLine2, 200) || null;
  const city          = clean(body?.city,         100);
  const region        = clean(body?.region,       100);
  const postal_code   = clean(body?.postalCode,    20);
  // NOT sliced to 2. Truncating turned "USA" into "US" and accepted it — a
  // wrong code silently becoming a plausible one is worse than a rejection,
  // because nobody ever finds out the country was guessed.
  const country       = clean(body?.country,       10).toUpperCase();
  const dob           = clean(body?.dateOfBirth,   10);

  if (legal_name.length < 2 || !/\p{L}/u.test(legal_name)) {
    return { error: 'Enter your full legal name.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return { error: 'Enter your date of birth.' };
  }

  const age = ageOn(dob);
  if (age === null) return { error: 'That date of birth is not valid.' };
  // A future date reads as a huge negative age, so this catches both.
  if (age < MIN_AGE_YEARS) {
    return { error: `You must be at least ${MIN_AGE_YEARS} to withdraw.` };
  }
  if (age > 120) return { error: 'That date of birth is not valid.' };

  if (!address_line1) return { error: 'Enter your street address.' };
  if (!city)          return { error: 'Enter your city.' };
  if (!region)        return { error: 'Enter your state or region.' };
  if (!postal_code)   return { error: 'Enter your postal code.' };
  if (!/^[A-Z]{2}$/.test(country)) {
    return { error: 'Select your country.' };
  }

  return {
    fields: {
      legal_name, date_of_birth: dob, address_line1, address_line2,
      city, region, postal_code, country,
    },
  };
}

module.exports = function kycRoutes(supabase) {
  const router = express.Router();

  /**
   * What the player is allowed to see about their own verification.
   *
   * Deliberately does not return the submitted personal data. The page needs to
   * know the STATE, and echoing name, address and date of birth back on every
   * poll spreads that data further for no benefit.
   */
  router.get('/status', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('kyc_status, kyc_reviewed_at, kyc_rejection_reason')
      .eq('id', req.user.id)
      .single();

    if (error) {
      // The column is missing until PENDING_SQL section 13 is run. Reporting
      // 'unverified' keeps the page usable and honest — nobody IS verified.
      if (/kyc_status/.test(error.message || '')) {
        console.warn('[kyc] profiles.kyc_status is missing — run PENDING_SQL section 13.');
        return res.json({ status: 'unverified', reviewedAt: null, rejectionReason: null });
      }
      return res.status(500).json({ error: error.message });
    }

    res.json({
      status:          data?.kyc_status ?? 'unverified',
      reviewedAt:      data?.kyc_reviewed_at ?? null,
      rejectionReason: data?.kyc_rejection_reason ?? null,
    });
  });

  router.post('/submit', requireAuth, async (req, res) => {
    const userId = req.user.id;

    const { fields, error: invalid } = validateSubmission(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    // Read the gate first. An approved player resubmitting would otherwise
    // knock themselves back to 'pending' and block their own withdrawals.
    const { data: profile, error: readErr } = await supabase
      .from('profiles').select('kyc_status').eq('id', userId).single();

    if (readErr) return res.status(500).json({ error: readErr.message });

    const current = profile?.kyc_status ?? 'unverified';
    if (current === 'approved') {
      return res.status(400).json({ error: 'You are already verified.' });
    }
    if (current === 'pending') {
      // Not an error — they are editing details while waiting. The existing row
      // is updated rather than a second one inserted, which is also what keeps
      // uniq_kyc_pending_per_user from ever being hit.
      const { error: updErr } = await supabase
        .from('kyc_submissions')
        .update({ ...fields, submitted_at: new Date().toISOString() })
        .eq('user_id', userId).eq('status', 'pending');

      if (updErr) return res.status(500).json({ error: updErr.message });
      return res.json({ status: 'pending', updated: true });
    }

    const { error: insErr } = await supabase
      .from('kyc_submissions')
      .insert({ user_id: userId, ...fields, status: 'pending' });

    if (insErr) return res.status(500).json({ error: insErr.message });

    // The gate moves only after the submission is safely stored. The other
    // order would mark somebody pending with nothing for an admin to review.
    const { error: gateErr } = await supabase
      .from('profiles')
      .update({ kyc_status: 'pending', kyc_rejection_reason: null })
      .eq('id', userId);

    if (gateErr) {
      console.error(`[kyc] submission stored for ${userId} but the gate did not move:`, gateErr.message);
      return res.status(500).json({ error: 'Submitted, but we could not update your status. Contact support.' });
    }

    res.json({ status: 'pending' });
  });

  return router;
};

module.exports.validateSubmission = validateSubmission;
module.exports.ageOn = ageOn;
