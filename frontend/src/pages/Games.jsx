import { useSocket } from '../context/SocketContext';
import { usePageReady } from '../hooks/usePageReady';
import GameVideoCard from '../components/GameVideoCard';
import { GAMES } from '../data/games';

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
          {GAMES.map(game => (
            <GameVideoCard
              key={game.slug}
              {...game}
              liveCount={game.countKey ? (playerCounts?.[game.countKey] ?? 0) : 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
