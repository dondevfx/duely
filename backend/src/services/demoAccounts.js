// Demo account IDs — set DEMO_ACCOUNT_IDS=uuid1,uuid2 in Railway env vars.
// These accounts are excluded from leaderboards, search, match ticker, and
// can only be tipped/matched by each other.
const DEMO_IDS = (process.env.DEMO_ACCOUNT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const isDemo = (userId) => DEMO_IDS.includes(userId);

// Applies .neq() filters to exclude demo accounts from a Supabase query.
function filterDemos(query, column = 'id') {
  for (const id of DEMO_IDS) query = query.neq(column, id);
  return query;
}

module.exports = { DEMO_IDS, isDemo, filterDemos };
