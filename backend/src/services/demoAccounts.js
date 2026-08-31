// Demo account IDs — set DEMO_ACCOUNT_IDS=uuid1,uuid2 in Railway env vars.
// These accounts are excluded from leaderboards, search, match ticker, and
// can only be tipped/matched by each other.
const DEMO_IDS = (process.env.DEMO_ACCOUNT_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const isDemo = (userId) => DEMO_IDS.includes(userId);

// Funny opponent names shown for demo-account matches (vs a rigged bot, or when
// two demo accounts get matched — the opponent is relabelled with one of these).
// The names a disguised opponent plays under.
//
// These were joke names — ToiletGoblin, SirFartsALot, PoopSockSteve. Every one
// of them read as a bot, because no real account is called that, and a lobby
// full of them made the whole opponent list look generated.
//
// Written as tags now: the shapes people actually pick. Handle plus number,
// two words jammed together, a deliberate misspelling, an initial-and-word, the
// occasional lowercase one. A couple of plain first-name handles are in there
// on purpose — a list with no ordinary names in it is its own kind of tell.
const FUNNY_NAMES = [
  'Vantiq', 'zeroCool', 'mBaker', 'Krypto_7', 'NoScopeNate', 'drifty',
  'Halcyon', 'TKM', 'sh4dow', 'Renn', 'Quickscope', 'PixelJay',
  'OmenX', 'lowkeyjay', 'Trevn', 'Bl1tz', 'SaltyRook', 'Vex',
  'nightowl_', 'Kaz', 'RiftWalker', 'jonas', 'Prowl', 'M4verick',
  'Slipstream', 'ttv_Kobe', 'ghostmode', 'Ardyn', 'Nyx', 'Cardinal',
  'Dez', 'frostbyte', 'AceOfSpvdes', 'Loop', 'Kestrel', 'winterborn',
  'Tycho', 'Rook', 'sable', 'NVR', 'Halfstep', 'Mako',
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
function shownAs(p, viewer) {
  const plain = () => ({
    username:     p && p.username,
    avatarUrl:    (p && p.avatarUrl) ?? null,
    profileColor: (p && p.profileColor) ?? null,
  });
  if (!p || !p.isDemo) return plain();

  // Two demo accounts matched against each other see each other AS THEMSELVES.
  //
  // The disguise exists so a demo account is not identifiable to a real player
  // in a live match. Between two demos there is no one to hide from, and the
  // fake name made the demo look like it was playing a bot — which is the
  // opposite of what the demo is for, since a demo-vs-demo match is the only
  // genuinely real PvP either of them will play.
  if (viewer && viewer.isDemo) return plain();

  const username = randomFunnyName();
  return { username, ...disguisedFace(username) };
}

// Applies .neq() filters to exclude demo accounts from a Supabase query.
function filterDemos(query, column = 'id') {
  for (const id of DEMO_IDS) query = query.neq(column, id);
  return query;
}

module.exports = { DEMO_IDS, isDemo, filterDemos, FUNNY_NAMES, randomFunnyName, disguisedFace, shownAs, PROFILE_COLORS };
