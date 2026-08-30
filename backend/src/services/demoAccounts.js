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

// The colours a real player picks from (see Profile.jsx). Kept here because
// anyone shown under a fake name has to look like an ordinary player, and an
// ordinary player with no picture falls back to a circle in THEIR colour.
const PROFILE_COLORS = [
  '#1250B4', '#00BFFF', '#22c55e', '#ef4444', '#f97316', '#a855f7',
  '#ec4899', '#eab308', '#06b6d4', '#14b8a6', '#f43f5e', '#e2e8f0',
];

// The face to show alongside a disguised name.
//
// Disguised players were sent with profileColor null, so every one of them
// rendered in the same default blue while real players vary — which is exactly
// how you spot a fake opponent at a glance. The colour is derived from the name
// so it is stable for the whole match and across reconnects, and so two
// different names rarely land on the same one.
//
// The picture is dropped on purpose: a fake name beside a real photograph is a
// worse disguise than no disguise, and it leaks the real account.
function disguisedFace(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return { avatarUrl: null, profileColor: PROFILE_COLORS[h % PROFILE_COLORS.length] };
}

// What another player is allowed to see of this one. A demo account plays under
// a random name so it is not identifiable in a live match; everyone else is
// shown as themselves.
function shownAs(p) {
  if (!p || !p.isDemo) {
    return {
      username:     p && p.username,
      avatarUrl:    (p && p.avatarUrl) ?? null,
      profileColor: (p && p.profileColor) ?? null,
    };
  }
  const username = randomFunnyName();
  return { username, ...disguisedFace(username) };
}

// Applies .neq() filters to exclude demo accounts from a Supabase query.
function filterDemos(query, column = 'id') {
  for (const id of DEMO_IDS) query = query.neq(column, id);
  return query;
}

module.exports = { DEMO_IDS, isDemo, filterDemos, FUNNY_NAMES, randomFunnyName, disguisedFace, shownAs, PROFILE_COLORS };
