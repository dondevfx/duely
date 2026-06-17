const RANKS = [
  { name: 'Bronze',   min: 0,    max: 1099, icon: '🥉', color: '#cd7f32', glow: 'rgba(205,127,50,0.4)'  },
  { name: 'Silver',   min: 1100, max: 1299, icon: '🥈', color: '#a8a9ad', glow: 'rgba(168,169,173,0.4)' },
  { name: 'Gold',     min: 1300, max: 1499, icon: '🥇', color: '#ffd700', glow: 'rgba(255,215,0,0.4)'   },
  { name: 'Platinum', min: 1500, max: 1699, icon: '💠', color: '#00e5ff', glow: 'rgba(0,229,255,0.4)'   },
  { name: 'Diamond',  min: 1700, max: 1899, icon: '✦',  color: '#b388ff', glow: 'rgba(179,136,255,0.4)' },
  { name: 'Champion', min: 1900, max: Infinity, icon: '👑', color: '#ff1744', glow: 'rgba(255,23,68,0.5)' },
];

export function getRank(elo = 1000) {
  return RANKS.find(r => elo >= r.min && elo <= r.max) ?? RANKS[0];
}

/** True once a player has completed 3 matches (any mode) */
export function isRanked(profile) {
  return ((profile?.wins ?? 0) + (profile?.losses ?? 0)) >= 3;
}

/** How many placement matches completed (0–3) */
export function placementMatches(profile) {
  return Math.min(3, (profile?.wins ?? 0) + (profile?.losses ?? 0));
}

const UNRANKED = { name: 'Unranked', min: 0, max: Infinity, icon: '❔', color: '#64748b', glow: 'rgba(100,116,139,0.3)' };

/** Returns Unranked badge if player hasn't completed placement (needs profile object) */
export function getDisplayRank(profile) {
  if (!isRanked(profile)) return UNRANKED;
  return getRank(profile?.elo ?? 1000);
}

export { RANKS };
