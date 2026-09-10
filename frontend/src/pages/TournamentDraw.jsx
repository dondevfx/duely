import { useEffect, useState } from 'react';
import GameDraw from '../components/GameDraw';

/**
 * The screen between the bracket and the game.
 *
 * It is two moments, one after the other, and it takes the whole screen for
 * both. The bracket was behind it before, dimmed, which made the draw read as
 * a notice on top of the waiting room rather than as the thing that was
 * happening — and the reel, which is the one moment where everyone in the
 * tournament is looking at the same unknown, was competing with sixteen names
 * for attention.
 *
 * Five seconds of countdown, so nobody is dropped into a game they were not
 * looking at, and then the reel. Both are driven from instants the server
 * sent, not from durations counted here: a tab that slept through half of it
 * lands where it should instead of starting the sequence again.
 */
export default function TournamentDraw({ round, rounds, game, games, reelAt, at, entryFee }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);

  const counting = reelAt ? now < reelAt : false;
  const secondsLeft = Math.max(1, Math.ceil((reelAt - now) / 1000));

  return (
    <div className="fixed inset-0 z-40 bg-bg flex flex-col items-center justify-center px-6">
      <div className="text-[0.625rem] sm:text-xs uppercase tracking-widest text-muted font-bold">
        {roundName(round, rounds)}
      </div>

      {counting ? (
        <>
          {/* Keyed on the number so each one animates in on its own rather
              than the digit quietly swapping in place. */}
          <div
            key={secondsLeft}
            className="font-mono font-black text-white leading-none animate-slide-up"
            style={{ fontSize: 'min(38vw, 9rem)', textShadow: '0 0 40px rgba(18,80,180,0.55)' }}
          >
            {secondsLeft}
          </div>
          <p className="mt-4 text-sm text-muted">Get ready</p>
        </>
      ) : (
        <>
          <GameDraw game={game} games={games} />
          <p className="mt-2 text-sm text-muted">
            {at && at > now ? 'Starting…' : 'Loading the game…'}
          </p>
        </>
      )}

      {entryFee != null && (
        <div className="absolute bottom-8 text-xs text-muted">{entryFee} coin entry</div>
      )}
    </div>
  );
}

function roundName(index, total) {
  const fromEnd = total - index;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semi-finals';
  if (fromEnd === 3) return 'Quarter-finals';
  return `Round ${index + 1}`;
}
