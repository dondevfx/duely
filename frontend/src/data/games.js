// The single list of playable games — title, route, and the clip slug used to
// find its video and poster under /game-clips/.
//
// No icon field: the slug already names the game, and <GameIcon game={slug}/>
// draws it. A second place to spell the icon is a second place for it to go
// stale.
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
    route: '/game/quick-match',
  },
  {
    slug:     'block-blast',
    title:    'Block Burst',
    route:    '/game/block-blast',
    countKey: 'block-blast',
  },
  {
    slug:     'car-dash',
    title:    'Rush Hour',
    route:    '/game/car-dash',
    countKey: 'car-dash',
  },
  {
    slug:     'coin-flip',
    title:    'Coin Flip',
    route:    '/game/coin-flip',
    countKey: 'coin-flip',
  },
  {
    slug:     'color-rush',
    title:    'Color Rush',
    route:    '/game/color-rush',
    countKey: 'color-rush',
    // The poster is a full 1284x2778 phone screenshot while the clip is a
    // near-square 480x476 recording. In a square card, object-cover shows only
    // the middle 46% of a frame that tall, which lands below the obstacles
    // entirely — the still would show empty black and then snap to the game
    // the moment the video started. Anchoring to the top keeps the rings and
    // the ball, which sit in the upper third of that screenshot.
    clipPosition: 'center top',
  },
  {
    slug:     'tower',
    title:    'Tower',
    route:    '/game/tower',
    countKey: 'tower',
  },
  {
    slug:     'scrabble',
    title:    'Word VS',
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
    slug:     'blackjack',
    title:    'Blackjack',
    route:    '/game/blackjack',
    countKey: 'blackjack',
    // 72% — dialed in on a real phone via the ?cropdebug=1 slider
    // (GameVideoCard.jsx), same as the 68% before it. Two earlier offline
    // attempts (default 50%, then 36%) each checked out under every method
    // available here — extracted frames, simulated canvas crops, the
    // deployed CSS read straight off production — and both still came back
    // wrong on a real screen. canvas drawImage does not reproduce what
    // object-fit:cover actually paints, so that verification meant nothing;
    // the slider reads the real computed style off the real render, which is
    // the only thing that has turned out reliable for this.
    clipPosition: '72% 50%',
  },
];
