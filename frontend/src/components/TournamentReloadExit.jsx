import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { RELOADED_OUT_OF, clearTournamentMark } from '../utils/tournamentSession';

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
  const sent = useRef(false);

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
