// Tracks users currently in a queue or active paid match.
// Wallet operations (withdraw, tip) are blocked while locked to prevent
// draining funds between queue-join balance check and match settlement.
// Auto-expires after 10 minutes to prevent permanent lock on server crash/bug.
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const locked = new Map(); // userId → timer

function lockUser(userId) {
  const existing = locked.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => locked.delete(userId), LOCK_TIMEOUT_MS);
  locked.set(userId, timer);
}

function unlockUser(userId) {
  const timer = locked.get(userId);
  if (timer) clearTimeout(timer);
  locked.delete(userId);
}

function isLocked(userId) {
  return locked.has(userId);
}

module.exports = { lockUser, unlockUser, isLocked };
