import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { getCurrentSession, readSessionFromStorage, onSessionChange } from '../utils/supabase';

const SocketContext = createContext(null);
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

export function SocketProvider({ children }) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [forfeitWin, setForfeitWin] = useState(null); // kept for backward compat, unused after migration
  const [playerCounts, setPlayerCounts] = useState({});
  const [betCounts, setBetCounts] = useState({});
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

    socket.on('player_counts', ({ counts }) => setPlayerCounts(counts));
    socket.on('bet_counts', ({ counts }) => setBetCounts(counts));

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

    return () => {
      socket.disconnect();
      unsubSessionChange();
    };
  }, []);

  const clearForfeitWin = useCallback(() => setForfeitWin(null), []);

  return (
    <SocketContext.Provider value={{
      socket: socketRef.current,
      connected,
      authenticated,
      doAuth: () => doAuth(socketRef.current),
      forfeitWin,
      clearForfeitWin,
      playerCounts,
      betCounts,
      queueEntries,
      activeGames,
    }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
