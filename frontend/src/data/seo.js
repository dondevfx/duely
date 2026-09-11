// What search engines and link previews are told about each public page.
//
// One list, read in two places: the build writes a static HTML file per page
// from it (scripts/prerender-seo.mjs — the head tags and a plain-text summary
// for readers that do not run JavaScript), and <PageMeta/> applies the same
// title and description in the running app as the route changes. Keeping it
// in one place is what stops the two from disagreeing.
//
// Plain data, no JSX, so the Node build script can import it directly.
//
// Wording: skill games and tournaments. Stakes are described on the pages
// themselves; search snippets lead with the games.

export const SITE = 'https://www.duely.us';
export const SITE_NAME = 'Duely';
export const DEFAULT_IMAGE = `${SITE}/og-image.png`;

export const SEO_PAGES = [
  {
    path: '/',
    title: 'Duely — 1v1 Skill Games & Tournaments',
    description: 'Play real-time 1v1 skill games against real players. Block Burst, Rush Hour, Color Rush, Tower, Word VS and more — plus tournaments three times an hour.',
    heading: 'Duely — 1v1 skill games',
    body: 'Duely is a head-to-head gaming platform. Pick a game and play a live 1v1 match against another player or a bot. Most games are pure skill — reaction, accuracy and speed decide them. Tournaments run three times an hour: sixteen players, four rounds, a different game each round.',
    priority: 1.0,
  },
  {
    path: '/games',
    title: 'All Games — Duely',
    description: 'Every game on Duely: Block Burst, Rush Hour, Color Rush, Tower, Word VS, Coin Flip and Blackjack. Play solo, against a bot, or ranked 1v1.',
    heading: 'All games',
    body: 'Seven games, each playable solo, against a bot, or ranked against another player: Block Burst, Rush Hour, Color Rush, Tower, Word VS, Coin Flip and Blackjack.',
    priority: 0.9,
  },
  {
    path: '/tournaments',
    title: 'Tournaments — 16-Player Knockout | Duely',
    description: 'Sixteen players, four rounds, a new game every round. Duely tournaments start three times an hour, with prizes for the top three.',
    heading: 'Tournaments',
    body: 'A Duely tournament is a sixteen-player knockout. Each round is a different game drawn at random, a draw goes to a thirty-second sudden death, and the top three places are paid. Entry opens every twenty minutes.',
    priority: 0.9,
  },
  {
    path: '/game/block-blast',
    title: 'Block Burst — 1v1 Block Puzzle | Duely',
    description: 'Place blocks, clear lines and outscore your opponent in a live 1v1 block puzzle. Play Block Burst free or ranked on Duely.',
    heading: 'Block Burst',
    body: 'Block Burst is a block-placing puzzle played head to head. Fit pieces onto the board, clear full rows and columns, and finish with the higher score.',
    priority: 0.8,
  },
  {
    path: '/game/color-rush',
    title: 'Color Rush — Tap Through Colour Gates 1v1 | Duely',
    description: 'Tap to climb through spinning obstacles — pass only where the colour matches yours. Race a real opponent in Color Rush on Duely.',
    heading: 'Color Rush',
    body: 'Color Rush is a reaction game: tap to fly upward through spinning obstacles, passing only through the part that matches your colour. Both players get the identical course, and diamonds collected decide the match.',
    priority: 0.8,
  },
  {
    path: '/game/car-dash',
    title: 'Rush Hour — 1v1 Highway Dodge | Duely',
    description: 'Weave through traffic at speed and survive longer than your opponent. Rush Hour is a live 1v1 highway game on Duely.',
    heading: 'Rush Hour',
    body: 'Rush Hour is a highway survival game. Switch lanes through oncoming traffic as the speed climbs; both players face the same road, and the further run wins.',
    priority: 0.8,
  },
  {
    path: '/game/coin-flip',
    title: 'Coin Flip — Heads or Tails 1v1 | Duely',
    description: 'Call heads or tails against another player in a live 1v1 coin flip on Duely.',
    heading: 'Coin Flip',
    body: 'Coin Flip is the simplest game on Duely: two players, one coin, heads or tails.',
    priority: 0.7,
  },
  {
    path: '/game/tower',
    title: 'Tower — 1v1 Block Stacking | Duely',
    description: 'Drop each block square on the last and build the tallest tower. Perfect drops multiply your score. Play Tower 1v1 on Duely.',
    heading: 'Tower',
    body: 'Tower is a timing game: drop each sliding block onto the stack. Anything that overhangs is cut away, perfect drops build a multiplier, and the taller tower wins.',
    priority: 0.8,
  },
  {
    path: '/game/scrabble',
    title: 'Word VS — 1v1 Word Guessing | Duely',
    description: 'Guess the hidden word in fewer tries than your opponent. Word VS is a live head-to-head word game on Duely.',
    heading: 'Word VS',
    body: 'Word VS is a head-to-head word guessing game. Both players chase the same hidden word, and the one who solves it in fewer guesses — or faster — wins.',
    priority: 0.8,
  },
  {
    path: '/game/blackjack',
    title: 'Blackjack — 1v1 | Duely',
    description: 'Play blackjack head to head on Duely — get closer to 21 than your opponent without going bust.',
    heading: 'Blackjack',
    body: 'Blackjack on Duely is played player against player: get closer to 21 than your opponent without going over.',
    priority: 0.7,
  },
  {
    path: '/game/quick-match',
    title: 'Quick Match — Random 1v1 Game | Duely',
    description: 'Jump straight into a random 1v1 skill game against the next available player on Duely.',
    heading: 'Quick Match',
    body: 'Quick Match puts you straight into a random game against the next available player.',
    priority: 0.6,
  },
  {
    path: '/leaderboard',
    title: 'Leaderboard — Top Players | Duely',
    description: 'The top-ranked players on Duely, by rating and wins.',
    heading: 'Leaderboard',
    body: 'The highest-rated players on Duely. Ranked matches move your rating after your first three placement games.',
    priority: 0.6,
  },
  {
    path: '/rewards',
    title: 'Rewards — Daily Bonuses | Duely',
    description: 'Daily bonuses, rakeback and rewards for playing on Duely.',
    heading: 'Rewards',
    body: 'Daily bonuses and rewards for playing on Duely.',
    priority: 0.5,
  },
  {
    path: '/signup',
    title: 'Sign Up — Duely',
    description: 'Create a free Duely account and start playing 1v1 skill games and tournaments.',
    heading: 'Create your account',
    body: 'Create a free Duely account to play ranked matches and enter tournaments.',
    priority: 0.5,
  },
  {
    path: '/login',
    title: 'Log In — Duely',
    description: 'Log in to Duely to play 1v1 skill games and tournaments.',
    heading: 'Log in',
    body: 'Log in to your Duely account.',
    priority: 0.3,
  },
  {
    path: '/support',
    title: 'Support — Duely',
    description: 'Get help with your Duely account, matches and payments.',
    heading: 'Support',
    body: 'Contact Duely support about your account, a match or a payment.',
    priority: 0.3,
  },
  {
    path: '/tos',
    title: 'Terms of Service — Duely',
    description: 'The terms of service for Duely: accounts, matches, tournaments, deposits and withdrawals.',
    heading: 'Terms of Service',
    body: 'The terms that apply to using Duely.',
    priority: 0.2,
  },
  {
    path: '/privacy',
    title: 'Privacy Policy — Duely',
    description: 'How Duely collects, uses and protects your information.',
    heading: 'Privacy Policy',
    body: 'How Duely collects, uses and protects your information.',
    priority: 0.2,
  },
];

// Routes that are the same page as a listed one under another name.
export const ALIASES = { '/game/word-vs': '/game/scrabble' };

// Personal or short-lived pages: kept out of the index by the running app as
// well as by robots.txt.
export const NOINDEX_PREFIXES = [
  '/wallet', '/admin', '/auth/', '/profile', '/transactions', '/tip',
  '/reset-password', '/tournaments/', '/spectate/', '/challenge/', '/add-friend/',
];

export function seoFor(pathname) {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';
  const path = ALIASES[clean] || clean;
  return SEO_PAGES.find(p => p.path === path) || null;
}
