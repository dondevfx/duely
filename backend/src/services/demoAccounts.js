// Demo account IDs — set DEMO_ACCOUNT_IDS=uuid1,uuid2 in Railway env vars.
// These accounts are excluded from leaderboards, search, match ticker, and
// can only be tipped/matched by each other.
const DEMO_IDS = (process.env.DEMO_ACCOUNT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const isDemo = (userId) => DEMO_IDS.includes(userId);

// Funny opponent names shown for demo-account matches (vs a rigged bot, or when
// two demo accounts get matched — the opponent is relabelled with one of these).
const FUNNY_NAMES = [
  'SussyBaka420', 'ToiletGoblin', 'MoistBandit', 'SirFartsALot', 'CheekClapper9000',
  'BigChungus', 'GaryGooch', 'DumpsterRaccoon', 'SoggyWaffle', 'PoopSockSteve',
  'ThiccNoodle', 'CrustySock', 'GassyGus', 'BeefusMcGee', 'MayoFingers',
  'NuggetNutz', 'SquishyPancake', 'GrandmaSlayer', 'WetSockWilly', 'ChonkyBoi',
  'SirLoinSteak', 'DiaperDon', 'GurgleMcGoo', 'SlipperyPete', 'FartKnuckle',
  'CheesyGordita', 'MoldyBagel', 'ThighMaster69', 'SmellyMcNugget', 'BoogerBaron',
  'TurboTaco', 'LimpBiscuit', 'GoblinGremlin', 'SweatyBetty', 'ClammyCarl',
];

const randomFunnyName = () => FUNNY_NAMES[Math.floor(Math.random() * FUNNY_NAMES.length)];

// Applies .neq() filters to exclude demo accounts from a Supabase query.
function filterDemos(query, column = 'id') {
  for (const id of DEMO_IDS) query = query.neq(column, id);
  return query;
}

module.exports = { DEMO_IDS, isDemo, filterDemos, FUNNY_NAMES, randomFunnyName };
