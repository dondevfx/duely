// The single list of playable games — title, icon, route, and the clip slug
// used to find its video and poster under /game-clips/.
//
// This used to be two separate copies: one in Home.jsx, one inline in
// Games.jsx, with slightly different wording for the same games. They had
// already drifted apart. One list now; both pages read from it.
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
  },
];
