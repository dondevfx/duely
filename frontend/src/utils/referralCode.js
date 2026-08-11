// The signed-in user's own invite code, cached so any share button has the
// right link on its FIRST paint.
//
// Without a cache the code only arrived once a ReferralCard had mounted and its
// request had returned, so sharing from another page — or quickly enough on
// first load — handed out a link with no code on it. That failure is invisible:
// a bare site link looks completely normal, and the referrer just never gets
// credited.

const KEY = 'duely.referralCode';

export function getCachedCode() {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}

export function setCachedCode(code) {
  if (!code) return;
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
}

// Cleared on sign-out — the next account must not inherit this one's code and
// start crediting referrals to the wrong person.
export function clearCachedCode() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
