/**
 * The Ranked (ELO) board's rules, in one place.
 *
 * Used by GET /api/leaderboard and by the public content feed, so the feed's
 * top five are exactly the site's top five and cannot drift from it.
 *
 *   - the admin account, private profiles and demo accounts are not listed
 *     (the admin and private filters are applied in the query);
 *   - placed accounts only: three rated results (wins + losses) first;
 *   - a placed account whose stored rating was never written is shown at 1000.
 */
const { DEMO_IDS } = require('./demoAccounts');

const PLACEMENT = 3;

function rankEloBoard(rows, { demoIds = DEMO_IDS } = {}) {
  const placed = (p) => ((p.wins ?? 0) + (p.losses ?? 0)) >= PLACEMENT;
  const rated = (p) => ({ ...p, elo: Number(p.elo) > 0 ? Number(p.elo) : 1000 });
  return (rows || [])
    .filter(p => !demoIds.includes(p.id))
    .filter(placed)
    .map(rated)
    .sort((a, b) => b.elo - a.elo)
    .map((p, i) => ({ rank: i + 1, ...p }));
}

module.exports = { rankEloBoard, PLACEMENT };
