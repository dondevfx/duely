// Carries a referral code from a shared link through to signup.
//
// The whole referral reward depends on the code actually being applied, and
// asking a new player to type one manually means almost nobody does. So the
// link carries ?ref=CODE, we stash it the moment they land, and apply it once
// they have a session.
//
// localStorage, not sessionStorage: the common path is land → sign up → confirm
// by email, and the confirmation link usually opens a NEW tab, which starts a
// fresh session store. Same reasoning as pendingInvite.
//
// The TTL is much longer than that one though. A friend invite is used within
// minutes; a referral is marketing attribution — someone clicks today and signs
// up on Thursday. Seven days is the usual window and it still expires, so a
// stale code cannot silently attach itself to an unrelated signup months later.

const KEY = 'duely.pendingReferral';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reads ?ref= from the current URL, stores it, and strips it from the address
 * bar so it is not carried into shares, bookmarks or analytics.
 *
 * Does NOT overwrite an existing pending code: first link wins, so someone
 * cannot hijack an attribution by getting a second link in front of the user
 * before they finish signing up.
 */
export function captureReferralFromUrl() {
  try {
    const url = new URL(window.location.href);
    const code = (url.searchParams.get('ref') || '').trim();
    if (!code) return;

    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
    }

    url.searchParams.delete('ref');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch { /* private mode — the referral just won't be captured */ }
}

/** Reads and clears the pending code. Returns the code, or null. */
export function takePendingReferral() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { code, at } = JSON.parse(raw);
    localStorage.removeItem(KEY);
    if (!code || !at || Date.now() - at > TTL_MS) return null;
    return code;
  } catch { return null; }
}

/** Peek without consuming — for showing "invited by X" before signup. */
export function peekPendingReferral() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { code, at } = JSON.parse(raw);
    if (!code || !at || Date.now() - at > TTL_MS) return null;
    return code;
  } catch { return null; }
}
