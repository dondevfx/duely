import { useEffect, useRef } from 'react';

/**
 * Forfeit the current match when the player leaves — every way they can leave,
 * and none of the ways they have not.
 *
 * There are four ways out of a live game, and they do not all look the same to
 * the browser:
 *
 *   refresh            beforeunload fires, then the socket drops
 *   close tab/browser  pagehide fires, then the socket drops
 *   navigate in-app    NOTHING fires. The socket stays connected and the
 *                      server never finds out, so unmount is the only signal
 *                      there is — hence the forfeit in the cleanup.
 *   lose network/quit  no event at all; the server's disconnect grace catches it
 *
 * ── The one that must NOT forfeit ──
 *
 * pagehide also fires when the page enters the back/forward cache: switching
 * apps on iOS, or a back navigation. `persisted` is what tells the two apart,
 * and nothing checked it — so backgrounding Safari mid-match forfeited the
 * game. Taking a phone call lost you the stake.
 *
 * That is also why it was intermittent rather than constant: the emit races the
 * browser freezing the page, so it only sometimes got out. Checking persisted
 * removes the race entirely, and coming back is already handled — SocketContext
 * re-probes the connection on pageshow.
 *
 * Switching to another TAB is not a leave either. It fires visibilitychange,
 * which is deliberately not listened to here: the match is still running, the
 * clock is server-side, and the player can come back to it.
 *
 * ── Why the socket is held in a ref ──
 *
 * So the effect can have an empty dependency list. Keyed on the socket instead,
 * the cleanup runs whenever the socket identity changes — which would fire a
 * forfeit in the middle of a match the player is still playing.
 *
 * Safe to call on a lobby screen: with no active room the server treats it as
 * leaving the queue, which is what you want anyway.
 */
export function useLeaveGuard(socket) {
  const socketRef = useRef(socket);
  socketRef.current = socket;

  useEffect(() => {
    const forfeit = () => {
      const s = socketRef.current;
      if (s?.connected) s.emit('player_forfeit');
    };

    // Going into the bfcache is a pause, not a departure.
    const onPageHide = (e) => { if (!e.persisted) forfeit(); };

    window.addEventListener('beforeunload', forfeit);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', forfeit);
      window.removeEventListener('pagehide', onPageHide);
      forfeit();   // in-app navigation — the only notice the server gets
    };
  }, []);
}

export default useLeaveGuard;
