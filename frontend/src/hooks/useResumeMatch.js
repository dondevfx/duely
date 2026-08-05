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
 * Pass `active` as a FUNCTION returning true only while a match is actually on
 * screen. It is evaluated lazily at reconnect time, so this hook can sit
 * anywhere in a component without caring whether the state it reads has been
 * declared yet — passing the value directly reads it during render and throws
 * if the hook is above the declaration, which is how three game pages once
 * broke.
 *
 * Timing matters here. The claim is sent on the server's `authenticated`
 * event, NOT on `connect`. The server's authenticate handler is async — it
 * verifies the token and loads the profile — while its resume_match handler
 * checks for an authenticated user synchronously and silently returns if there
 * is not one yet. Claiming on `connect` therefore raced ahead of
 * authentication, got dropped, and the forfeit ran regardless: a player with a
 * brief connection blip lost a match they were still playing.
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

    // The server confirms authentication with this event, so by the time it
    // arrives the socket is known and a claim will be honoured.
    socket.on('authenticated', claim);

    // Also claim once on mount: if the socket authenticated before this page
    // mounted — the common case when navigating into a game — the event above
    // has already been and gone. Harmless if it is early, because the listener
    // will fire again once authentication completes.
    if (socket.connected) claim();

    return () => { socket.off('authenticated', claim); };
  }, [socket]);
}
