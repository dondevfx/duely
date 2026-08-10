import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { captureReferralFromUrl, takePendingReferral } from '../utils/pendingReferral';

// Applies a referral code carried in a shared link.
//
// Two steps, deliberately decoupled, because they almost never happen in the
// same page view: the code is captured the instant someone lands on ?ref=CODE
// (usually logged out), and applied later once they have a session — which may
// be after a signup, an email confirmation in a fresh tab, or a plain login.
//
// Mounted once at the app root so it covers every entry path rather than only
// the signup page.
export default function ReferralCapture() {
  const { session, refreshProfile } = useAuth();
  const applied = useRef(false);

  // Capture immediately, before anything can navigate and drop the query string.
  useEffect(() => { captureReferralFromUrl(); }, []);

  useEffect(() => {
    if (!session || applied.current) return;
    applied.current = true;   // one attempt per page load, whatever the outcome

    const code = takePendingReferral();
    if (!code) { applied.current = false; return; }   // nothing pending; stay armed

    // The server rejects a self-referral, an unknown code, and a second code
    // for someone already referred, so there is nothing to validate here. A
    // failure is silent by design: this is a background nicety and a new player
    // should never see an error about it on their first screen.
    api.post('/affiliate/apply-code', { code })
      .then(() => refreshProfile?.())
      .catch(() => {});
  }, [session, refreshProfile]);

  return null;
}
