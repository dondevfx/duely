import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';

/**
 * What the result card needs to know when the match it is showing was a
 * tournament round.
 *
 * Read here rather than passed down from the pages. There are five game
 * screens and a dozen places between them that render a result, and threading
 * a prop through all of them is how one gets missed — the card would offer
 * "Play Again" in the middle of a bracket, which either does nothing or
 * quietly queues the player into an ordinary match while their tournament
 * carries on without them. The card already knows how to find out for itself:
 * it is on a screen that was entered with tournament state.
 *
 * Returns null for an ordinary match, so everything else is untouched.
 */
export default function useTournamentResult() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const { socket } = useSocket();
  const { session } = useAuth();
  const tournament = state?.tournament || null;
  const poolId = tournament?.poolId || null;

  // Set when the whole tournament has finished, which is the difference
  // between "next game" and "you have won it".
  const [over, setOver] = useState(null);

  useEffect(() => {
    if (!socket || !poolId) return;
    const onOver = (p) => { if (p?.poolId === poolId) setOver(p); };
    socket.on('tournament_over', onOver);
    return () => socket.off('tournament_over', onOver);
  }, [socket, poolId]);

  if (!poolId) return null;

  return {
    poolId,
    round: tournament.round,
    over,
    // Their own placing, if it is finished. Everyone sees the podium; only the
    // three who placed have a payout to be told about.
    award: over?.awards?.find(a => a.userId === session?.user?.id) || null,
    awards: over?.awards || [],
    free: !!over?.free,
    toBracket: () => navigate(`/tournaments/${poolId}`, { replace: true }),
    toLobby: () => navigate('/tournaments', { replace: true }),
  };
}
