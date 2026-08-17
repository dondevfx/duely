import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { getCurrentSession, readSessionFromStorage, onSessionChange } from '../utils/supabase';

const SocketContext = createContext(null);
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

// Master switch for the live player-count badges ("X playing", "X Live",
// "X at this bet size"). Set to true to show them everywhere again.
const SHOW_LIVE_COUNTS = false;

export function SocketProvider({ children }) {
  const socketRef = useRef(null);
  // The socket is also held in STATE, not only in the ref.
  //
  // The context used to publish `socket: socketRef.current`. The ref is filled
  // in the effect below, which runs after the first render, and assigning a ref
  // does not re-render anything — so every consumer read `socket: null` until
  // some OTHER piece of state happened to change. In practice that was the
  // 'connect' event, so for the entire time the server took to answer (a cold
  // start on Railway is tens of seconds) the whole app held a null socket.
  //
  // Anything that emits once on mount silently did nothing at all, and the page
  // sat on "Connecting…" until it was reloaded by hand.
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [forfeitWin, setForfeitWin] = useState(null); // kept for backward compat, unused after migration
  const [playerCounts, setPlayerCounts] = useState({});
  const [betCounts, setBetCounts] = useState({});
  // Same data as betCounts but never blanked by SHOW_LIVE_COUNTS — matchmaking
  // only, never rendered. See the bet_counts handler below.
  const [queueCounts, setQueueCounts] = useState({});
  const [queueEntries, setQueueEntries] = useState([]);
  const [activeGames, setActiveGames] = useState([]);

  function doAuth(socket) {
    // getCurrentSession() may be null during init() — fall back to sessionStorage
    const sess = getCurrentSession() || readSessionFromStorage();
    if (sess?.access_token) {
      socket.emit('authenticate', { token: sess.access_token });
    }
  }

  useEffect(() => {
    // timeout 8s (not the 20s default) + fast reconnection so a cold-started /
    // waking server is picked up within a couple seconds instead of the user
    // staring at "connecting" for a full 20s. Polling is kept as a fallback for
    // networks where the WebSocket upgrade is slow or blocked.
    const socket = io(SOCKET_URL, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
      timeout: 8000,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    socketRef.current = socket;
    setSocket(socket);   // publish it to consumers on this commit, not on connect

    socket.on('connect', () => {
      setConnected(true);
      doAuth(socket);
    });

    socket.on('authenticated', () => {
      setAuthenticated(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setAuthenticated(false);
    });

    // Live player counts are hidden site-wide for now. Every "X playing / X Live /
    // X at this bet size" badge reads from these two maps and only renders when the
    // count is > 0 — so feeding them empty hides them all without removing any
    // display code. Flip SHOW_LIVE_COUNTS back to true to bring them all back.
    socket.on('player_counts', ({ counts }) => setPlayerCounts(SHOW_LIVE_COUNTS ? counts : {}));
    socket.on('bet_counts', ({ counts }) => {
      setBetCounts(SHOW_LIVE_COUNTS ? counts : {});
      // Kept ungated: Quick Match uses this to land you in a game where someone
      // is already waiting at your bet. SHOW_LIVE_COUNTS is about not SHOWING
      // counts, and blanking this too would silently make Quick Match random
      // again. Nothing renders from it.
      setQueueCounts(counts || {});
    });

    socket.on('queue_entry_added', (entry) => {
      setQueueEntries(prev => {
        if (prev.find(e => e.id === entry.id)) return prev;
        return [{ ...entry, addedAt: Date.now() }, ...prev].slice(0, 24);
      });
    });
    socket.on('queue_entry_removed', ({ id }) => {
      setQueueEntries(prev => prev.filter(e => e.id !== id));
    });

    socket.on('active_game_started', (game) => {
      setActiveGames(prev => {
        if (prev.find(g => g.id === game.id)) return prev;
        return [game, ...prev].slice(0, 20);
      });
    });
    socket.on('active_game_ended', ({ id }) => {
      setActiveGames(prev => prev.filter(g => g.id !== id));
    });
    socket.on('active_game_score', ({ id, score1, score2 }) => {
      setActiveGames(prev => prev.map(g => g.id === id ? { ...g, score1, score2 } : g));
    });

    // Re-authenticate whenever the session changes: after init() sets the session,
    // after a token refresh, or after the user signs in.
    // This covers the race where the socket connects before init() has set _currentSession.
    const unsubSessionChange = onSessionChange((sess) => {
      if (sess?.access_token && socket.connected) {
        socket.emit('authenticate', { token: sess.access_token });
      }
    });

    // ── Coming back from the background ────────────────────────────────────
    //
    // iOS Safari freezes a backgrounded tab's socket without closing it. On
    // return the client still reports `connected` while the server timed the
    // session out long ago, so nothing reconnects until Socket.IO's own ping
    // eventually notices — that wait is the 5-10 seconds of "Connecting…" or
    // "Authenticating…" under the play buttons after switching back to Safari.
    //
    // Nothing here can detect that by inspecting local state, because local
    // state is exactly what is wrong. The only way to know is to ask the server
    // and put a deadline on the answer.
    let probing = false;
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      const s = socketRef.current;
      if (!s) return;

      // Genuinely disconnected: reconnect now rather than sitting out the
      // remainder of the backoff, which can be seconds on a later attempt.
      if (!s.connected) { s.connect(); return; }

      if (probing) return;
      probing = true;
      // Ask, with a deadline. A live socket answers in well under 2s; a frozen
      // one never answers at all, and the ack timeout is what tells them apart.
      s.timeout(2000).emit('ping_check', (err) => {
        probing = false;
        if (!err) {
          // Alive. The session can still have lapsed while backgrounded, so
          // re-assert it — doAuth is a no-op without a token.
          doAuth(s);
          return;
        }
        // No answer: the connection is dead but does not know it. Tear it down
        // so a fresh one starts immediately instead of waiting for the ping
        // timeout to work it out.
        s.disconnect();
        s.connect();
      });
    };

    document.addEventListener('visibilitychange', resume);
    // pageshow also fires when Safari restores a page from the back/forward
    // cache, where visibilitychange does not.
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);

    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      socket.disconnect();
      setSocket(null);
      unsubSessionChange();
    };
  }, []);

  const clearForfeitWin = useCallback(() => setForfeitWin(null), []);

  return (
    <SocketContext.Provider value={{
      socket,
      connected,
      authenticated,
      doAuth: () => doAuth(socketRef.current),
      forfeitWin,
      clearForfeitWin,
      playerCounts,
      betCounts,
      queueCounts,
      queueEntries,
      activeGames,
    }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
