import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { captureReferralFromUrl, takePendingReferral } from '../utils/pendingReferral';
import { getCachedCode, setCachedCode, clearCachedCode } from '../utils/referralCode';

// All the referral plumbing that has to run site-wide, mounted once at the app
// root so it covers every entry path rather than only the pages with a card.
//
// Three jobs:
//   1. Capture ?ref=CODE the instant someone lands, usually logged out.
//   2. Apply it once they have a session — which may be a signup, an email
//      confirmation in a fresh tab, or a plain login much later.
//   3. Warm the signed-in user's OWN code, so any share button already has the
//      right link on its first paint instead of waiting for a card to mount.
export default function ReferralCapture() {
  const { session, refreshProfile } = useAuth();
  const applied = useRef(false);
  const warmed = useRef(false);

  // Capture immediately, before anything can navigate and drop the query string.
  useEffect(() => { captureReferralFromUrl(); }, []);

  useEffect(() => {
    if (!session) {
      // Signed out: drop the cached code so the next account to sign in here
      // cannot inherit it and credit its referrals to the wrong person.
      clearCachedCode();
      warmed.current = false;
      applied.current = false;
      return;
    }

    // ── Apply an incoming referral ──────────────────────────────────────
    if (!applied.current) {
      const code = takePendingReferral();
      if (code) {
        applied.current = true;
        // The server rejects self-referral, unknown codes, and a second code
        // for someone already referred, so there is nothing to validate here.
        // Silent on failure by design: a new player should not meet an error
        // about referral bookkeeping on their first screen.
        api.post('/affiliate/apply-code', { code })
          .then(() => refreshProfile?.())
          .catch(() => {});
      }
    }

    // ── Warm this user's own invite code ────────────────────────────────
    if (!warmed.current && !getCachedCode()) {
      warmed.current = true;
      api.get('/rewards/referral-code')
        .then(({ code }) => setCachedCode(code))
        .catch(() => { warmed.current = false; });   // retry on the next mount
    }
  }, [session, refreshProfile]);

  return null;
}
