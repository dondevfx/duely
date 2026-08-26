import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Rematch handling for a match that came from an invite or a code.
 *
 * One hook rather than six copies. Every game page needs exactly the same
 * three things — remember that the current match is private, track the
 * two-sided handshake, and clear both when the match is over — and the times
 * this codebase has written a shared pattern out by hand per page are the
 * times one page got missed.
 *
 * The handshake is deliberately two-sided: these are staked matches, so one
 * player clicking Rematch must not put the other player's coins into a game
 * they have not agreed to. First click parks an acceptance and notifies the
 * opponent; the second starts it.
 *
 * @param socket    the socket.io client
 * @param matchFoundEvent  e.g. 'coin_flip_match_found' — carries isPrivate
 * @returns { isPrivate, rematchState, requestRematch, declineRematch, notice, reset }
 */
export function usePrivateRematch(socket, matchFoundEvent) {
  const [isPrivate, setIsPrivate]       = useState(false);
  const [rematchState, setRematchState] = useState('idle'); // idle | waiting | requested
  const [notice, setNotice]             = useState('');
  // The room the offer belongs to. A ref, not state: it is read inside
  // callbacks and must not make them stale.
  const roomIdRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    // The server marks a match private, not the page. A reload or a rejoin
    // loses page state, and a button that silently re-queues you into the
    // public pool when you meant to rematch a friend is worse than none.
    const onFound = (payload) => {
      setIsPrivate(!!payload?.isPrivate);
      roomIdRef.current = payload?.roomId ?? null;
      setRematchState('idle');
      setNotice('');
    };

    const onRequested = ({ from }) => {
      setRematchState('requested');
      setNotice(`${from || 'Your opponent'} wants a rematch`);
    };

    const onWaiting = () => {
      setRematchState('waiting');
      setNotice('Waiting for your opponent…');
    };

    const onUnavailable = ({ reason, message }) => {
      // Falls back to the ordinary Play Again rather than stranding anyone:
      // the button becomes the normal queue again and says why.
      setIsPrivate(false);
      setRematchState('idle');
      setNotice(
        message
        || (reason === 'opponent_left' ? 'Your opponent left — Play Again enters the normal queue.'
        : reason === 'declined'        ? 'Your opponent declined the rematch.'
        : reason === 'expired'         ? 'The rematch offer expired.'
        : ''));
    };

    socket.on(matchFoundEvent, onFound);
    socket.on('rematch_requested', onRequested);
    socket.on('rematch_waiting', onWaiting);
    socket.on('rematch_unavailable', onUnavailable);
    return () => {
      socket.off(matchFoundEvent, onFound);
      socket.off('rematch_requested', onRequested);
      socket.off('rematch_waiting', onWaiting);
      socket.off('rematch_unavailable', onUnavailable);
    };
  }, [socket, matchFoundEvent]);

  const requestRematch = useCallback(() => {
    if (!socket || !roomIdRef.current) return;
    socket.emit('request_rematch', { roomId: roomIdRef.current });
  }, [socket]);

  // Called when the player leaves the result screen, so the opponent is told
  // immediately instead of waiting out the offer's full lifetime.
  const declineRematch = useCallback(() => {
    if (!socket || !roomIdRef.current) return;
    socket.emit('decline_rematch', { roomId: roomIdRef.current });
    roomIdRef.current = null;
    setIsPrivate(false);
    setRematchState('idle');
  }, [socket]);

  const reset = useCallback(() => {
    roomIdRef.current = null;
    setIsPrivate(false);
    setRematchState('idle');
    setNotice('');
  }, []);

  return { isPrivate, rematchState, requestRematch, declineRematch, notice, reset };
}
