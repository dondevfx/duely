// Remembers a friend invite across sign-in.
//
// The link is shared with people who do not have an account yet, so the common
// path is: open link → sign up → confirm by email → land back here. Router
// location.state does not survive that, and neither does sessionStorage, which
// is per-tab and the confirmation email usually opens a new one. So this uses
// localStorage.
//
// It carries a TTL for the same reason: a value that outlives the flow would
// otherwise sit there and hijack an unrelated login weeks later.

const KEY = 'duely.pendingFriendInvite';
const TTL_MS = 60 * 60 * 1000;   // an hour is plenty for sign-up + email confirm

export function savePendingInvite(username) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ username, at: Date.now() }));
  } catch { /* private mode / storage disabled — the invite just won't resume */ }
}

/** Reads and clears it. Returns a route to send the user to, or null. */
export function takePendingInvite() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const { username, at } = JSON.parse(raw);
    if (!username || !at || Date.now() - at > TTL_MS) return null;
    return { route: `/add-friend/${encodeURIComponent(username)}` };
  } catch { return null; }
}
