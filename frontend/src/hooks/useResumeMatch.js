import { useEffect, useRef } from 'react';

/**
 * Re-claim an in-progress match after the socket drops and comes back.
 *
 * The server no longer treats "this user authenticated again" as proof they are
 * still playing, because a page refresh looks identical to a reconnect at that
 * level and used to leave the player bound to a match they had actually left.
 * A pending forfeit is therefore only cancelled when a client that is genuinely
 * still rendering an active match says so — which is this hook.
 *
 * Pass `active` as true only while a match is actually being played. If it is
 * false when the socket reconnects, the forfeit runs and the opponent wins,
 * which is the intended outcome for a refresh, a closed tab, or a navigation
 * away.
 *
 * `active` is a FUNCTION, not a boolean, on purpose: it is evaluated lazily at
 * reconnect time, so this hook can be called anywhere in a component without
 * caring whether the state it reads has been declared yet. Passing the value
 * directly reads it during render and throws if the hook sits above the
 * declaration — which is exactly how three game pages got broken once.
 *
 * @param {import('socket.io-client').Socket|null} socket
 * @param {() => boolean} active — returns true while a live match is on screen
 */
export function useResumeMatch(socket, active) {
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!socket) return;
    const claim = () => {
      const on = typeof activeRef.current === 'function' ? activeRef.current() : activeRef.current;
      if (on) socket.emit('resume_match');
    };
    // 'connect' covers a dropped-and-restored socket. Authentication is emitted
    // by the socket layer on the same event, and the server tolerates the two
    // arriving in either order.
    socket.on('connect', claim);
    // Also claim on mount, to cover a socket that reconnected while this page
    // was still initialising.
    if (socket.connected) claim();
    return () => { socket.off('connect', claim); };
  }, [socket]);
}
