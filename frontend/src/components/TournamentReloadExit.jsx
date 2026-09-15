import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { RELOADED_OUT_OF, clearTournamentMark, readTournamentMark } from '../utils/tournamentSession';

/**
 * A refresh inside a tournament takes the player out of it.
 *
 * Straight to the tournament bet page — before the bracket or the game can
 * draw — and then the server is told, the same call the Leave button makes:
 * a refund if the pool had not started, a forfeit if it had. See
 * utils/tournamentSession for why the tab has to be the one to say so.
 */
export default function TournamentReloadExit() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const { pathname, state } = useLocation();
  const sent = useRef(false);

  // Leaving the tournament screens any other way leaves the tournament too.
  //
  // Only a refresh did before. A player who clicked Home, Ranked or another
  // game from the waiting room stayed seated: the others still saw them in
  // the seats, and coming back put them in the same seat as if they had never
  // gone. "In the tournament" is now exactly "on its bracket, or in one of its
  // games" (a game entered FROM the bracket carries the pool in its route
  // state). Anywhere else, the server is told the same thing the Leave button
  // says: free before it starts, a forfeit once it has.
  //
  // This is the one place the marker is cleared on the way out, so no screen
  // can clear it first and hide the leave.
  useEffect(() => {
    if (RELOADED_OUT_OF && !sent.current) return;   // the refresh path below handles it
    const mark = readTournamentMark();
    if (!mark) return;
    const inFlow = pathname === `/tournaments/${mark}`
      || (pathname.startsWith('/game/') && state?.tournament?.poolId === mark);
    if (inFlow) return;
    clearTournamentMark();
    api.post(`/tournaments/${mark}/leave`, {}).catch(() => {});
  }, [pathname, state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!RELOADED_OUT_OF) return;
    navigate('/tournaments', { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!RELOADED_OUT_OF || sent.current || !session) return;
    sent.current = true;
    clearTournamentMark();
    // Errors are fine: a pool that finished, or one they were already out of,
    // has nothing to leave.
    api.post(`/tournaments/${RELOADED_OUT_OF}/leave`, {}).catch(() => {});
  }, [session]);

  return null;
}
