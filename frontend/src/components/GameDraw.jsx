import { useEffect, useRef, useState } from 'react';
import GameIcon from './GameIcon';

/**
 * The draw: which game this round is played on.
 *
 * The game is decided on the server when the pool is created — every round of
 * it, at once, so that every client is told the same rotation and nobody can
 * be shown one game and given another. This is only the reveal.
 *
 * It cycles the candidates quickly and slows to a stop on the real one, which
 * is a slot machine and is meant to be: the point is the half-second where
 * everybody in the bracket is looking at the same thing not yet knowing what
 * it is. It always lands on `game`, however long it runs — the animation
 * cannot change the answer, only take its time arriving at it.
 */
const EASE = [70, 70, 80, 90, 100, 120, 145, 175, 215, 265, 330, 410, 520, 660];

export default function GameDraw({ game, games = [], onDone, className = '' }) {
  const [shown, setShown] = useState(games[0] || game);
  const [settled, setSettled] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (!game) return;
    const pool = games.length ? games : [game];
    let step = 0;
    let timer = null;

    const next = () => {
      if (step >= EASE.length) {
        setShown(game);
        setSettled(true);
        if (!done.current) { done.current = true; onDone?.(); }
        return;
      }
      // The last few frames walk towards the answer rather than staying
      // random, so it decelerates ONTO it instead of snapping at the end.
      setShown(pool[(step * 3 + 1) % pool.length]);
      timer = setTimeout(next, EASE[step++]);
    };
    next();
    return () => clearTimeout(timer);
  }, [game]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!game) return null;

  return (
    <div className={`flex flex-col items-center justify-center gap-3 py-6 ${className}`}>
      <div className="text-[0.625rem] uppercase tracking-widest text-muted font-bold">
        {settled ? 'This round' : 'Drawing the game'}
      </div>
      <div
        key={shown}
        className={`flex flex-col items-center gap-2 ${settled ? 'animate-slide-up' : ''}`}
        style={{ transform: settled ? 'scale(1)' : 'scale(0.92)', transition: 'transform 180ms ease-out' }}
      >
        <GameIcon game={shown} size={settled ? 56 : 44} />
        <div className={`font-black leading-none ${settled ? 'text-2xl text-white' : 'text-xl text-muted'}`}>
          {TITLES[shown] || shown}
        </div>
      </div>
    </div>
  );
}

const TITLES = {
  'block-blast': 'Block Burst',
  'car-dash': 'Rush Hour',
  'color-rush': 'Color Rush',
  tower: 'Tower',
  scrabble: 'Word VS',
};
