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
// Where the clock goes, per game.
//
// Block Burst and Word VS have an empty centre at the top of the board — the
// scores sit either side of it — so the clock lives there. The other three
// fill that strip: Tower and Rush Hour run their score across it and Colour
// Rush puts the diamond count in the middle. On those it goes to the bottom
// left, which is out of the play area on all three and out of the way of the
// controls, which are centred.
const TOP_CENTRE = new Set(['block-blast', 'scrabble']);

export default function TournamentClock() {
  const { state, pathname } = useLocation();
  const { socket } = useSocket();
  const t = state?.tournament;
  const seeded = t?.deadline
    ? { deadline: t.deadline, sudden: !!t.sudden, poolId: t.poolId, round: t.round, match: t.match, roomId: t.roomId }
    : null;

  const [match, setMatch] = useState(seeded);
  const [now, setNow] = useState(Date.now());

  // A new match seeds it again — the same screen is reused round after round.
  useEffect(() => { if (seeded) setMatch(seeded); }, [seeded?.deadline]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket) return;
    const onMatch = (m) => {
      if (!m?.deadline) return;
      setMatch({
        deadline: m.deadline, sudden: !!m.sudden,
        // Which match this clock belongs to, so somebody else's result does
        // not stop it.
        poolId: m.poolId, round: m.round, match: m.match, roomId: m.roomId,
      });
    };

    // MY match ending stops the clock. Not anybody's.
    //
    // tournament_result is broadcast to everyone in the pool, so the first of
    // the eight first-round matches to finish was clearing the clock for the
    // seven still being played — which is the timer vanishing part way
    // through, every time.
    const onResult = (r) => setMatch(m => (
      m && r?.poolId === m.poolId && r?.round === m.round && r?.match === m.match ? null : m
    ));
    const onExpired = (r) => setMatch(m => (
      m && (!r?.roomId || r.roomId === m.roomId) ? null : m
    ));
    const onOver = (r) => setMatch(m => (m && r?.poolId === m.poolId ? null : m));

    socket.on('tournament_match', onMatch);
    socket.on('tournament_result', onResult);
    socket.on('tournament_match_expired', onExpired);
    socket.on('tournament_over', onOver);
    return () => {
      socket.off('tournament_match', onMatch);
      socket.off('tournament_result', onResult);
      socket.off('tournament_match_expired', onExpired);
      socket.off('tournament_over', onOver);
    };
  }, [socket]);

  useEffect(() => {
    if (!match) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [match]);

  // Only on a game screen.
  //
  // Leaving a tournament — knocked out, kicked, or simply walking away — sends
  // no event that ends the match, so the clock carried on counting down over
  // the lobby. The route is the honest answer to "is a game being played": if
  // this is not a game screen, there is no round to time.
  const game = pathname?.startsWith('/game/') ? pathname.slice('/game/'.length) : null;
  if (!match || !game) return null;

  const left = Math.max(0, match.deadline - now);
  const urgent = left <= 30_000;

  const top = TOP_CENTRE.has(game);

  return (
    <div
      className={`fixed pointer-events-none select-none ${top ? 'left-1/2 -translate-x-1/2' : 'left-3'}`}
      // Never above the navbar. It is fixed at the top, 3.5rem tall, at z-50;
      // sitting over it put the clock across the balance, which is the one
      // number on the page nobody wants covered. z-40 clears the games' own
      // overlays, which live in the 20s and 30s, without reaching the bar.
      style={top
        ? { top: 'calc(env(safe-area-inset-top, 0px) + 3.5rem + 0.25rem)', zIndex: 40 }
        : { bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)', zIndex: 40 }}
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
