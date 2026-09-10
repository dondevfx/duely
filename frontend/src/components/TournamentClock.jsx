import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * The round's clock, over whatever game is being played.
 *
 * A tournament round has three minutes. Nothing on a game screen said so, and
 * a deadline a player cannot see is one they only find out about by losing to
 * it — so it is here, on every game, in the same place on every game.
 *
 * Mounted once at the app's root rather than added to five different screens.
 * It is fixed to the top centre and renders nothing at all outside a
 * tournament, so it cannot collide with a game's own layout: each of the five
 * puts its score at the top LEFT and right, and the middle is empty on all of
 * them. Positioned under the header's height and inside the safe area, so it
 * clears a phone's notch.
 *
 * It goes red under thirty seconds, and it does not claim to be authoritative:
 * the server decides the deadline and the server enforces it. This is a
 * readout of an instant the server sent.
 */
export default function TournamentClock() {
  const { state } = useLocation();
  const t = state?.tournament || null;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!t?.deadline) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [t?.deadline]);

  if (!t?.deadline) return null;

  const left = Math.max(0, t.deadline - now);
  const urgent = left <= 30_000;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-30 pointer-events-none select-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.375rem)' }}
      aria-live="off"
    >
      <div
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 backdrop-blur-sm"
        style={{
          background: 'rgba(0,0,0,0.72)',
          border: `1px solid ${urgent ? 'rgba(239,68,68,0.55)' : 'rgba(255,255,255,0.10)'}`,
        }}
      >
        {t.sudden && (
          <span className="text-[0.5rem] font-black uppercase tracking-widest text-danger">
            Sudden death
          </span>
        )}
        <span
          className="font-mono font-black text-sm leading-none tabular-nums"
          style={{ color: urgent ? '#F87171' : '#FFFFFF' }}
        >
          {fmt(left)}
        </span>
      </div>
    </div>
  );
}

export function fmt(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
