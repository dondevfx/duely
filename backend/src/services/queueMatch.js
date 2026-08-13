/**
 * Opponent selection for the PvP queues.
 *
 * Every queue used to take the FIRST eligible player, so the pairing was
 * whoever happened to be waiting longest — rating played no part at all. With
 * more than two people queued at the same stake that is a coin toss between a
 * fair match and a hopeless one.
 *
 * This picks the closest rating among the players already eligible. It does not
 * gate on a rating band: refusing a match because nobody near your rating is
 * around is worse than an uneven one, especially at low traffic where the
 * alternative is not playing. A bronze can still be handed a champion — but only
 * when the champion is genuinely the closest player waiting.
 */

// Matches the profile default, so a player whose elo failed to load is treated
// as unrated-average rather than as the strongest or weakest person in the queue.
const DEFAULT_ELO = 1000;

const eloOf = (p) => {
  const n = Number(p?.elo);
  return Number.isFinite(n) ? n : DEFAULT_ELO;
};

/**
 * Index of the eligible queue entry closest in rating to `player`, or -1.
 *
 * @param {Array}    queue     players waiting
 * @param {Object}   player    the player being matched
 * @param {Function} eligible  (entry) => bool — the queue's own rules (stake,
 *                             currency, demo/real, not self). Applied first, so
 *                             rating can only choose BETWEEN valid opponents and
 *                             never make an invalid one valid.
 */
function closestByElo(queue, player, eligible) {
  const mine = eloOf(player);
  let bestIdx = -1;
  let bestGap = Infinity;

  for (let i = 0; i < queue.length; i++) {
    if (!eligible(queue[i])) continue;
    const gap = Math.abs(eloOf(queue[i]) - mine);
    // Strictly less-than, so an exact tie keeps the earlier index — equally
    // rated players stay first-come-first-served rather than being reordered.
    if (gap < bestGap) {
      bestGap = gap;
      bestIdx = i;
      if (gap === 0) break;   // nothing can beat an exact match
    }
  }
  return bestIdx;
}

module.exports = { closestByElo, DEFAULT_ELO };
