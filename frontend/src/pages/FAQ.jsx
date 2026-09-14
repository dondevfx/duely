import { Link } from 'react-router-dom';
import { usePageReady } from '../hooks/usePageReady';

/**
 * Frequently asked questions.
 *
 * Laid out like the Terms and Privacy pages so it reads as one of them. Every
 * answer describes how the site actually works; if a rule changes, change the
 * answer here too.
 */
const SECTIONS = [
  {
    title: 'The basics',
    items: [
      {
        q: 'What is Duely?',
        a: 'Duely is a site for 1v1 games. Every match is two players, live, playing the same game at the same time: against another player, against a friend you invite, or against a bot for practice.',
      },
      {
        q: 'Which games can I play?',
        a: 'Block Burst, Color Rush, Rush Hour, Coin Flip, Tower, Word VS and Blackjack, plus tournaments.',
      },
      {
        q: 'Who decides who won?',
        a: 'The server. It keeps the score and the time for both players, so neither player\'s device reports its own result.',
      },
      {
        q: 'What happens if I leave a match?',
        a: 'Leaving a match part way through, closing the tab or refreshing counts as a forfeit, and your opponent wins.',
      },
      {
        q: 'Can I play with a friend?',
        a: 'Yes. Create a private room and share its code, send an invite to a friend on Duely, or share a challenge link with someone who has not signed up yet.',
      },
    ],
  },
  {
    title: 'Coins and Diamonds',
    items: [
      {
        q: 'What is the difference between Coins and Diamonds?',
        a: 'Diamonds are free: claim them on the Rewards page. Coins are the paid currency: one Coin is one US dollar, deposited on the Wallet page.',
      },
      {
        q: 'Can I withdraw my Coins straight away?',
        a: 'Deposited Coins have to be played through before they can be withdrawn. Your Wallet shows how much is left to play through.',
      },
      {
        q: 'Can I play for free?',
        a: 'Yes. Every game can be played for free, and Diamonds let you play for something without spending money.',
      },
    ],
  },
  {
    title: 'Ranking',
    items: [
      {
        q: 'How does ELO work?',
        a: 'Your first three matches are placement matches, and any match counts towards them. When they are done you start at 1000 ELO and appear on the leaderboard. Until then you show as Unranked.',
      },
      {
        q: 'Which matches change my ELO?',
        a: 'Only matches against another player with Coins or Diamonds on it. Free matches, solo runs and matches against a bot do not move your rating.',
      },
      {
        q: 'What counts towards a win streak?',
        a: 'The same matches as ELO: against another player, with Coins or Diamonds on it.',
      },
    ],
  },
  {
    title: 'Tournaments',
    items: [
      {
        q: 'How do tournaments work?',
        a: 'A tournament opens every twenty minutes, with five minutes to enter. Sixteen players play four knockout rounds, with a different game each round.',
      },
      {
        q: 'What does it cost and what can I win?',
        a: 'Entry is 1, 5 or 10 Coins. The top three places share the prize pool after a 5% platform fee: 50%, 30% and 20%.',
      },
      {
        q: 'What if the tournament does not fill?',
        a: 'It is cancelled and every entry is returned.',
      },
      {
        q: 'What happens on a draw?',
        a: 'The match goes to a thirty-second sudden-death replay of the same game.',
      },
      {
        q: 'How many tournaments can I enter?',
        a: 'Two per tournament slot. Refreshing or leaving a tournament screen takes you out of that tournament.',
      },
    ],
  },
  {
    title: 'Your account',
    items: [
      {
        q: 'Can I take a break from playing?',
        a: 'Yes. In Settings, use Self-exclusion to lock your account until a date you choose. While it is locked you cannot play, enter tournaments, tip or deposit, but you can still sign in and withdraw. A lock can be extended but not lifted early.',
      },
      {
        q: 'How do I get help?',
        a: 'Use the Support page to contact us about your account, a match or a payment.',
      },
    ],
  },
];

export default function FAQ() {
  const ready = usePageReady();
  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="max-w-2xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-black text-white mb-2">FAQ</h1>
        <p className="text-muted text-sm mb-10">Answers to common questions about Duely.</p>

        {SECTIONS.map(({ title, items }) => (
          <section key={title} className="mb-10">
            <h2 className="text-lg font-bold text-white mb-4">{title}</h2>
            {items.map(({ q, a }) => (
              <div key={q} className="mb-5">
                <h3 className="text-sm font-bold text-white mb-1">{q}</h3>
                <p className="text-muted text-sm leading-relaxed">{a}</p>
              </div>
            ))}
          </section>
        ))}

        <div className="mt-12 pt-6 border-t border-border">
          <p className="text-xs text-muted">
            Still stuck? <Link to="/support" className="underline underline-offset-2 hover:text-white">Contact support</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
