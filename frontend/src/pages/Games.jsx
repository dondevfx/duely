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

        {/* 2 up to lg, 3 from lg, 4 from xl.
            Sized against the width this grid ACTUALLY gets, not the
            viewport: the left nav takes 240px from md — and md is 720px in
            this project, not Tailwind's 768 (see tailwind.config.js), so it
            applies to every iPad including portrait. An 834px iPad portrait
            leaves only ~562px here. Measured card sizes:

              iPad portrait  810-834    2 cols -> 259-271px  (3 would be ~170)
              iPad landscape 1080-1194   2 cols               (3 measured 186px)
              xl 1280-1535              3 cols
              2xl 1536+                 4 cols

            The whole iPad range stays at 2 — the 240px left nav, not
            max-w-5xl, is what limits this grid, so 3 columns anywhere in
            that range produces cards smaller than a phone's. */}
        <div className="grid grid-cols-2 gap-4 sm:gap-5 xl:grid-cols-3 2xl:grid-cols-4">
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
