// The single list of playable games — title, icon, route, and the clip slug
// used to find its video and poster under /game-clips/.
//
// This used to be two separate copies: one in Home.jsx, one inline in
// Games.jsx, with slightly different wording for the same games. They had
// already drifted apart. One list now; both pages read from it.
//
// clipPosition (optional): where object-cover anchors its crop for THIS
// clip, passed straight through to CSS object-position. Square cards force a
// non-square recording to lose something off two opposite edges — this picks
// which edge is safe to lose it from, and it is genuinely per-clip: there is
// no universal "safe" side, only what happens to be near the edge of THAT
// recording. Omitted entirely uses the CSS default, 'center' (crop evenly
// from both edges), which is the right choice whenever nothing important
// sits near either edge.
export const GAMES = [
  {
    slug:  'quick-match',
    title: 'Quick Match',
    icon:  '⚡',
    route: '/game/quick-match',
  },
  {
    slug:     'block-blast',
    title:    'Block Burst',
    icon:     '🟦',
    route:    '/game/block-blast',
    countKey: 'block-blast',
  },
  {
    slug:     'coin-flip',
    title:    'Coin Flip',
    icon:     '🟡',
    route:    '/game/coin-flip',
    countKey: 'coin-flip',
  },
  {
    slug:     'scrabble',
    title:    'Word VS',
    icon:     '🔤',
    route:    '/game/scrabble',
    countKey: 'scrabble',
    // The recording is 456×480 — only a mild portrait mismatch, but the top
    // letter row sits flush against the top edge, so even that small a crop
    // was clipping straight through it. Anchoring to the top spends the
    // entire crop budget (~5%) on the bottom instead, which is empty guess
    // rows for most of a match.
    clipPosition: 'center top',
  },
  {
    slug:     'car-dash',
    title:    'Rush Hour',
    icon:     '🚗',
    route:    '/game/car-dash',
    countKey: 'car-dash',
  },
  {
    slug:     'tower',
    title:    'Tower',
    icon:     '🗼',
    route:    '/game/tower',
    countKey: 'tower',
  },
  {
    slug:     'blackjack',
    title:    'Blackjack',
    icon:     '🃏',
    route:    '/game/blackjack',
    countKey: 'blackjack',
    // clipPosition deliberately removed, back to the plain center crop.
    //
    // A prior attempt set this to '36% 50%' after testing candidate crops
    // against real extracted frames from the clip — every one of them looked
    // balanced. Confirmed the value was genuinely deployed (live DOM, live
    // video bytes both checked directly against production). Reported back
    // as looking WORSE on a real device regardless — HIT effectively gone.
    //
    // That is a real disagreement between what this environment can verify
    // (frame math, deployed bytes, computed CSS) and what an actual screen
    // shows, and there is no way to get a true rendered screenshot here to
    // settle it. Reverting to the known-safe baseline rather than guessing
    // again. If this still isn't centered, it needs a fresh real screenshot
    // to work from rather than another blind attempt.
  },
];
