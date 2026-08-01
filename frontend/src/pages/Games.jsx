import { Link } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { usePageReady } from '../hooks/usePageReady';

const GAMES = [
  {
    title: 'Quick Match',
    description: 'Pick your bet and get matched instantly — we choose the game.',
    icon: '⚡',
    route: '/game/quick-match',
  },
  {
    title: 'Block Burst',
    description: 'Drag blocks to clear rows and columns. Outscore your opponent.',
    icon: '🟦',
    route: '/game/block-blast',
    countKey: 'block-blast',
  },
  {
    title: 'Coin Flip',
    description: 'Pick a side. Instant result. Pure 50/50.',
    icon: '🟡',
    route: '/game/coin-flip',
    countKey: 'coin-flip',
  },
  {
    title: 'Word VS',
    description: 'Guess the 5-letter word before your opponent does.',
    icon: '🔤',
    route: '/game/scrabble',
    countKey: 'scrabble',
  },
  {
    title: 'Rush Hour',
    description: 'Dodge traffic at full speed. Same road for both — longest run wins.',
    icon: '🚗',
    route: '/game/car-dash',
    countKey: 'car-dash',
  },
  {
    title: 'Blackjack',
    description: 'Get closer to 21 than your opponent. No waiting on turns.',
    icon: '🃏',
    route: '/game/blackjack',
    countKey: 'blackjack',
  },
];

export default function Games() {
  const ready = usePageReady();
  const { playerCounts } = useSocket();

  return (
    <div
      className="min-h-[calc(100dvh-56px)] bg-bg px-4 py-10"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <h1 className="text-4xl sm:text-5xl font-black text-white mb-2">Games</h1>
          <p className="text-muted">Pick a game, set your bet, and play.</p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {GAMES.map(game => {
            const live = game.countKey ? (playerCounts?.[game.countKey] ?? 0) : 0;
            return (
              <div
                key={game.title}
                className="bg-surface border border-surfaceLight rounded-2xl p-3 sm:p-6 flex flex-col hover:border-primary transition-all"
              >
                <div className="flex items-start justify-between mb-1.5 sm:mb-3">
                  <div className="text-2xl sm:text-4xl">{game.icon}</div>
                  {live > 0 && (
                    <span className="inline-flex items-center gap-1 text-[9px] sm:text-[11px] font-bold text-primary whitespace-nowrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                      {live} playing
                    </span>
                  )}
                </div>
                <h2 className="text-sm sm:text-lg font-black text-white mb-0.5 sm:mb-1 leading-tight">{game.title}</h2>
                <p className="text-[11px] sm:text-sm text-muted leading-snug sm:leading-relaxed mb-2 sm:mb-5 flex-1 line-clamp-3 sm:line-clamp-none">{game.description}</p>
                <Link
                  to={game.route}
                  className="block w-full text-center text-sm sm:text-base py-2 sm:py-3 rounded-xl bg-primary hover:bg-blue-500 text-white font-black transition-all"
                >
                  Play
                </Link>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
