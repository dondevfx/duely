// What the email-verification popups show, from when the account was made.
//
//   day 3    one reminder, the next time they open the site
//   day 14   a popup on every visit, counting down to deletion
//   day 21   the account is deleted (backend/src/services/unverifiedAccounts.js)
//
// The numbers MUST match the backend's; a test holds them together. Accounts
// that existed before this shipped get at least seven days of countdown from
// LAUNCH, so nobody is deleted without seeing it.
export const DAY = 24 * 60 * 60 * 1000;
export const SOFT_AT   = 3 * DAY;
export const HARD_AT   = 14 * DAY;
export const DELETE_AT = 21 * DAY;
export const MIN_COUNTDOWN = 7 * DAY;
export const LAUNCH = Date.UTC(2026, 8, 14);

export function deadlineFor(createdMs) {
  return Math.max(createdMs + DELETE_AT, LAUNCH + MIN_COUNTDOWN);
}

/**
 * 'none' | 'soft' | 'hard' for this user, and when the account is deleted.
 * Only unverified email sign-ups get anything: a Google account's email is
 * already verified by Google.
 */
export function verificationStage(user, now = Date.now()) {
  if (!user || user.email_confirmed_at) return { stage: 'none' };
  const provider = user.app_metadata?.provider;
  if (provider && provider !== 'email') return { stage: 'none' };
  const created = Date.parse(user.created_at);
  if (!Number.isFinite(created)) return { stage: 'none' };
  const deadline = deadlineFor(created);
  // The countdown shows for the last seven days before deletion. That is day
  // 14 onward for a new account, and from launch for one that already existed.
  if (now >= deadline - MIN_COUNTDOWN) return { stage: 'hard', deadline };
  if (now >= created + SOFT_AT) return { stage: 'soft', deadline };
  return { stage: 'none', deadline };
}
