import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { api } from '../utils/api';
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
  // And set when there is demonstrably another round coming. Until ONE of the
  // two is known, this card does not know whether the player is on their way
  // back to the bracket or looking at the last screen of a tournament — so it
  // must not leave on a timer, which is how a winner was carried off the
  // result before the payout had been worked out.
  const [nextRound, setNextRound] = useState(false);
  // What the match being played is worth, taken from the socket as well as
  // from the route.
  //
  // The route is how it normally arrives, and it is also the thing most easily
  // lost — a reload, a screen reached another way, or a field somebody forgot
  // to forward. The socket is where the number came from, so it is asked
  // directly too.
  const [pays, setPays] = useState(tournament?.pays || null);

  useEffect(() => {
    if (!socket || !poolId) return;
    const onOver = (p) => { if (p?.poolId === poolId) setOver(p); };
    const onNext = (p) => { if (p?.poolId === poolId) setNextRound(true); };
    const onMatch = (m) => { if (m?.poolId === poolId && m.pays !== undefined) setPays(m.pays); };
    socket.on('tournament_over', onOver);
    socket.on('tournament_round_starting', onNext);
    socket.on('tournament_match', onMatch);
    return () => {
      socket.off('tournament_over', onOver);
      socket.off('tournament_round_starting', onNext);
      socket.off('tournament_match', onMatch);
    };
  }, [socket, poolId]);

  // What the pool says, for a card that is on screen either side of
  // settlement.
  //
  // Asked repeatedly, not once. The final's result card and the settlement
  // that pays it out happen within the same second, in either order: a single
  // request made a moment too early found the tournament still running, got
  // nothing, and never looked again — so the card sat there with no placing
  // and no payout, which is the one thing the last screen of a tournament has
  // to show. It stops the moment it has an answer.
  useEffect(() => {
    if (!poolId || over) return;
    let alive = true;
    let tries = 0;
    let timer = null;

    const ask = async () => {
      tries += 1;
      try {
        const d = await api.get(`/tournaments/${poolId}`);
        if (!alive) return;
        if (d?.pool?.state === 'complete' && d.pool.awards) {
          setOver({ poolId, awards: d.pool.awards, free: !!d.pool.free });
          return;
        }
        // Still running with a round drawn: there is another game coming, and
        // the card is free to send them back to the bracket for it.
        if (d?.pool?.state === 'running' && d.pool.phase === 'intermission') setNextRound(true);
      } catch { /* gone, or not ready — the retry covers both */ }
      if (alive && tries < 12) timer = setTimeout(ask, 1000);
    };
    ask();
    return () => { alive = false; clearTimeout(timer); };
  }, [poolId, over]);

  if (!poolId) return null;

  return {
    poolId,
    round: tournament.round,
    // What this match itself pays — set only for the final and the playoff for
    // third, where both outcomes have a price the moment the game starts.
    pays,
    over,
    // Safe to leave on a timer: either the tournament is over, or the next
    // round has been drawn.
    settled: !!over || nextRound,
    // Their own placing, if it is finished. Everyone sees the podium; only the
    // three who placed have a payout to be told about.
    award: over?.awards?.find(a => a.userId === session?.user?.id) || null,
    awards: over?.awards || [],
    free: !!over?.free,
    toBracket: () => navigate(`/tournaments/${poolId}`, { replace: true }),
    toLobby: () => navigate('/tournaments', { replace: true }),
  };
}
