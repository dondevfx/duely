// Tracks users currently in a queue or active paid match.
// Wallet operations (withdraw, tip) are blocked while locked to prevent
// draining funds between queue-join balance check and match settlement.
const locked = new Set();

module.exports = {
  lockUser:   (userId) => locked.add(userId),
  unlockUser: (userId) => locked.delete(userId),
  isLocked:   (userId) => locked.has(userId),
};
