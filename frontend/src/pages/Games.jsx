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

        {/* 2 columns up to lg, 3 from lg — the desktop layout this page has
            always had. The iPad range (720-1023, since md is 720px here, not
            Tailwind's 768 — see tailwind.config.js) sits in the 2-column
            band, which is what it needs: the 240px left nav, not max-w-5xl,
            is the real constraint, and 3 columns at an 834px iPad measured
            ~170px per card against 259-271px at 2. */}
        <div className="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-3">
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
