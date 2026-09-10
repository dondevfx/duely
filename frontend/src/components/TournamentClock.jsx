import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';

/**
 * The round's clock, over whatever game is being played.
 *
 * A tournament round has three minutes. Nothing on a game screen said so, and
 * a deadline a player cannot see is one they find out about by losing to it.
 *
 * It listens to the SOCKET rather than reading the route's state. The state is
 * there — the bracket navigates with it — but a game screen that reloads, or
 * one reached any other way, has none, and a clock that silently does not
 * appear is worse than no clock. The socket is where the deadline came from in
 * the first place, and it is the same on every screen. Route state is still
 * read, as the value to start from when the match began before this mounted.
 *
 * Mounted once at the app's root rather than added to five game screens. It is
 * fixed to the top centre: each of the five puts its score at the top left and
 * right, and the middle is empty on all of them.
 */
export default function TournamentClock() {
  const { state } = useLocation();
  const { socket } = useSocket();
  const seeded = state?.tournament?.deadline
    ? { deadline: state.tournament.deadline, sudden: !!state.tournament.sudden }
    : null;

  const [match, setMatch] = useState(seeded);
  const [now, setNow] = useState(Date.now());

  // A new match seeds it again — the same screen is reused round after round.
  useEffect(() => { if (seeded) setMatch(seeded); }, [seeded?.deadline]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket) return;
    const onMatch = (m) => {
      if (!m?.deadline) return;
      setMatch({ deadline: m.deadline, sudden: !!m.sudden });
    };
    // Anything that ends the match takes the clock with it, so it is never
    // left counting down over a result card.
    const clear = () => setMatch(null);

    socket.on('tournament_match', onMatch);
    socket.on('tournament_result', clear);
    socket.on('tournament_match_expired', clear);
    socket.on('tournament_over', clear);
    return () => {
      socket.off('tournament_match', onMatch);
      socket.off('tournament_result', clear);
      socket.off('tournament_match_expired', clear);
      socket.off('tournament_over', clear);
    };
  }, [socket]);

  useEffect(() => {
    if (!match) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [match]);

  if (!match) return null;
  const left = Math.max(0, match.deadline - now);
  const urgent = left <= 30_000;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 pointer-events-none select-none"
      // BELOW the navbar, which is fixed at the top with a height of 3.5rem
      // and a z-index of 50. Sitting above it put the clock across the balance
      // — the one number on the page nobody wants covered.
      //
      // Under it, the centre of every game's top strip is free: all five put
      // their scores at the left and right of that row and leave the middle
      // empty. z-40 clears the games' own overlays, which live in the 20s and
      // 30s, without ever reaching the bar.
      style={{
        top: 'calc(env(safe-area-inset-top, 0px) + 3.5rem + 0.25rem)',
        zIndex: 40,
      }}
      aria-live="off"
    >
      <div
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
        style={{
          background: 'rgba(0,0,0,0.78)',
          backdropFilter: 'blur(4px)',
          border: `1px solid ${urgent ? 'rgba(239,68,68,0.55)' : 'rgba(255,255,255,0.10)'}`,
        }}
      >
        {match.sudden && (
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
