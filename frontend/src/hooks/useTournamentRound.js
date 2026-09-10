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

    // The one case this still handles. Everything else about where the player
    // goes after a round belongs to the result card, which is the thing on
    // screen and the only thing that knows whether they won: a winner waits on
    // the bracket for the next round, a loser is out and goes to the lobby.
    //
    // An expired match has no result card at all — the deadline passed with
    // nobody finishing — so there is nothing to leave this screen otherwise.
    const onExpired = (r) => {
      if (r?.roomId && r.roomId !== roomId) return;
      if (wentBack.current) return;
      wentBack.current = true;
      setTimeout(() => navigate(`/tournaments/${poolId}`, { replace: true }), 1500);
    };

    socket.on('tournament_match_expired', onExpired);
    return () => socket.off('tournament_match_expired', onExpired);
  }, [socket, poolId, roomId, navigate]);

  return tournament;
}
