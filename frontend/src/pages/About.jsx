import { Link } from 'react-router-dom';
import { usePageReady } from '../hooks/usePageReady';
import { GAMES } from '../data/games';

/**
 * What Duely is, in plain words.
 *
 * Built the same way as the Terms and Privacy pages — one column, an h1 and
 * h2 sections — so it reads as part of the site rather than a new design.
 *
 * Everything here describes how the site actually works today. It says what
 * the games, tournaments, currencies and rules are; it makes no claims about
 * winnings, returns or legality. If a rule changes, change it here too.
 */
const GAME_LINES = {
  'block-blast': 'Place blocks and clear lines against the clock. Highest score wins.',
  'color-rush':  'Tap to climb through spinning shapes, passing only through your own colour. Both players get the identical course.',
  'car-dash':    'Weave through highway traffic as it speeds up. Both players get the identical road; whoever goes furthest wins.',
  'coin-flip':   'Call heads or tails against another player.',
  'tower':       'Drop sliding blocks to stack as high as you can. Every overhang is cut off, so precision decides it.',
  'scrabble':    'A head-to-head word-guessing race. Solve the word in fewer guesses than your opponent.',
  'blackjack':   'Blackjack played head to head.',
};

const SECTIONS = [
  {
    title: 'What Duely is',
    body: 'Duely is a site for 1v1 games. Every match is two players, live, playing the same game at the same time — against another player, against a friend you invite, or against a bot for practice.',
  },
  {
    title: 'How a match works',
    body: 'Pick a game and choose how to play: for free, for Diamonds, or for Coins. You are matched with an opponent, a short countdown starts, and you both play. The server keeps score and decides the result — neither player\'s device reports its own win. Leaving a match part way through counts as a forfeit.',
  },
  {
    title: 'Playing with friends',
    body: 'Any game can be played privately: create a room and share its code, send an invite to a friend on Duely, or share a challenge link with someone who has not signed up yet.',
  },
  {
    title: 'Tournaments',
    body: 'A tournament opens every twenty minutes, with five minutes to enter. Sixteen players, four knockout rounds, and a different game each round. A drawn match goes to a thirty-second sudden-death replay of the same game. Entry is 1, 5 or 10 Coins, and the top three places share the prize pool after a 5% platform fee — 50%, 30% and 20%. A tournament that does not fill is cancelled and every entry is returned.',
  },
  {
    title: 'Ratings and the leaderboard',
    body: 'Ranked matches move your ELO rating, which is what the leaderboard orders players by. Your first three matches are placement matches.',
  },
  {
    title: 'Coins and Diamonds',
    body: 'Diamonds are free — claim them on the Rewards page — and exist so anyone can play for something without spending money. Coins are the paid currency: one Coin is one US dollar, deposited on the Wallet page. Deposited Coins must be played through before they can be withdrawn. Playing for Coins requires accepting the Terms of Service, including its age requirement.',
  },
];

export default function About() {
  const ready = usePageReady();
  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">About Duely</h1>
        <p className="text-muted text-sm mb-10">1v1 games, tournaments and how it all works.</p>

        {SECTIONS.slice(0, 1).map(({ title, body }) => (
          <section key={title} className="mb-8">
            <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
            <p className="text-muted text-sm leading-relaxed">{body}</p>
          </section>
        ))}

        <section className="mb-8">
          <h2 className="text-lg font-bold text-white mb-2">The games</h2>
          <ul className="space-y-2">
            {GAMES.filter(g => GAME_LINES[g.slug]).map(g => (
              <li key={g.slug} className="text-muted text-sm leading-relaxed">
                <Link to={g.route} className="text-white font-semibold hover:text-primary transition-colors">{g.title}</Link>
                {' — '}{GAME_LINES[g.slug]}
              </li>
            ))}
          </ul>
        </section>

        {SECTIONS.slice(1).map(({ title, body }) => (
          <section key={title} className="mb-8">
            <h2 className="text-lg font-bold text-white mb-2">{title}</h2>
            <p className="text-muted text-sm leading-relaxed">{body}</p>
          </section>
        ))}

        <div className="mt-12 pt-6 border-t border-border flex flex-wrap gap-x-4 gap-y-2 text-xs">
          <Link to="/games" className="text-muted hover:text-white underline underline-offset-2">All games</Link>
          <Link to="/tournaments" className="text-muted hover:text-white underline underline-offset-2">Tournaments</Link>
          <Link to="/tos" className="text-muted hover:text-white underline underline-offset-2">Terms of Service</Link>
          <Link to="/privacy" className="text-muted hover:text-white underline underline-offset-2">Privacy Policy</Link>
          <Link to="/support" className="text-muted hover:text-white underline underline-offset-2">Support</Link>
        </div>
      </div>
    </div>
  );
}
