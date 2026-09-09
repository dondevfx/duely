import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * The three lines every game screen needs to be playable inside a bracket.
 *
 * A tournament round is an ordinary match on an ordinary game screen. The
 * only two things that differ are at the edges:
 *
 * Arriving. The server cannot send the match_found this screen listens for
 * until the screen exists, and it has no way of knowing when a route change
 * finishes. So the screen says when it is ready, and the countdown starts on
 * that. If it never does — a crash, a slow load — the server starts anyway a
 * few seconds later and the match deadline settles it.
 *
 * Leaving. There is nowhere for a result card to go afterwards: the player is
 * mid-tournament and the next thing that happens is the next round. So once
 * their match is decided, the screen takes them back to the bracket to watch
 * it fill in — after a pause long enough to read who won.
 *
 * Returns the tournament this screen was entered for, or null for an ordinary
 * match, so a screen can label itself.
 */
export default function useTournamentRound(socket) {
  const { state } = useLocation();
  const navigate = useNavigate();
  const tournament = state?.tournament || null;
  const wentBack = useRef(false);

  const poolId = tournament?.poolId;
  const roomId = tournament?.roomId;

  useEffect(() => {
    if (!socket || !poolId || !roomId) return;
    socket.emit('tournament_ready', { poolId, roomId });
  }, [socket, poolId, roomId]);

  useEffect(() => {
    if (!socket || !poolId) return;

    const back = (delay) => {
      if (wentBack.current) return;
      wentBack.current = true;
      setTimeout(() => navigate(`/tournaments/${poolId}`, { replace: true }), delay);
    };

    // Their own match being decided is the cue — not any result in the round,
    // which would pull them off a game they are still playing the moment
    // somebody else finished theirs first.
    const onResult = (r) => {
      if (r?.poolId !== poolId) return;
      if (r?.round !== tournament?.round || r?.match !== tournament?.match) return;
      back(4000);
    };
    const onOver = (r) => { if (r?.poolId === poolId) back(4000); };
    // The deadline passed with nobody having finished. Nothing more is coming
    // on this screen, so it does not sit there.
    const onExpired = (r) => { if (!r?.roomId || r.roomId === roomId) back(1500); };

    socket.on('tournament_result', onResult);
    socket.on('tournament_over', onOver);
    socket.on('tournament_match_expired', onExpired);
    return () => {
      socket.off('tournament_result', onResult);
      socket.off('tournament_over', onOver);
      socket.off('tournament_match_expired', onExpired);
    };
  }, [socket, poolId, roomId, tournament?.round, tournament?.match, navigate]);

  return tournament;
}
