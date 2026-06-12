import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { getCurrentSession, readSessionFromStorage, onSessionChange } from '../utils/supabase';

const SocketContext = createContext(null);
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

const ACTIVE_ROOM_KEY = 'c1v1_active_room';

export function SocketProvider({ children }) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [forfeitWin, setForfeitWin] = useState(null); // kept for backward compat, unused after migration
  const [opponentReconnecting, setOpponentReconnecting] = useState(false);
  const [rejoinResult, setRejoinResult] = useState(null); // { success: bool, roomId, gameType }
  const [playerCounts, setPlayerCounts] = useState({});
  const [betCounts, setBetCounts] = useState({});
  const [queueEntries, setQueueEntries] = useState([]);
  const [activeGames, setActiveGames] = useState([]);
  const reconnectTimerRef = useRef(null);

  function doAuth(socket) {
    // getCurrentSession() may be null during init() — fall back to sessionStorage
    const sess = getCurrentSession() || readSessionFromStorage();
    if (sess?.access_token) {
      socket.emit('authenticate', { token: sess.access_token });
    }
  }

  function setActiveRoom(roomId, gameType) {
    if (roomId) {
      localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ roomId, gameType, ts: Date.now() }));
    } else {
      localStorage.removeItem(ACTIVE_ROOM_KEY);
    }
  }

  function clearActiveRoom() {
    localStorage.removeItem(ACTIVE_ROOM_KEY);
  }

  function tryRejoin(socket) {
    try {
      const raw = localStorage.getItem(ACTIVE_ROOM_KEY);
      if (!raw) return;
      const { roomId, gameType, ts } = JSON.parse(raw);
      // Only attempt rejoin if stored within 33 seconds (30s window + buffer)
      if (Date.now() - ts > 33000) { localStorage.removeItem(ACTIVE_ROOM_KEY); return; }
      socket.emit('rejoin_game', { roomId });
      // If no rejoin_success within 5s, treat as forfeited
      reconnectTimerRef.current = setTimeout(() => {
        setRejoinResult({ success: false, roomId, gameType });
        localStorage.removeItem(ACTIVE_ROOM_KEY);
      }, 5000);
    } catch { localStorage.removeItem(ACTIVE_ROOM_KEY); }
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, { autoConnect: true, transports: ['websocket'] });
    socketRef.current = socket;

    // Explicit mapping from socket event → hook gameType (camelCase)
    const MATCH_EVENT_MAP = {
      'match_found':            'reaction',
      'chess_match_found':      'chess',
      'checkers_match_found':   'checkers',
      'ttt_match_found':        'tictactoe',
      'c4_match_found':         'connectFour',
      'rps_match_found':        'rps',
      'uno_match_found':        'uno',
      'tetris_match_found':     'tetris',
      'snake_match_found':      'snake',
      'g2048_match_found':      'twoFortyEight',
      'block_blast_match_found':'blockBlast',
      'galaga_match_found':     'galaga',
      'asteroid_match_found':   'asteroids',
      'piano_match_found':      'piano',
      'type_match_found':       'type',
      'click_match_found':      'clickRace',
    };

    // Auto-track active room for rejoin support
    socket.onAny((event, data) => {
      if (data?.roomId && MATCH_EVENT_MAP[event]) {
        localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({
          roomId: data.roomId,
          gameType: MATCH_EVENT_MAP[event],
          ts: Date.now(),
        }));
      }
      // Clear when game is over
      if (event.endsWith('_result') || event === 'type_result') {
        localStorage.removeItem(ACTIVE_ROOM_KEY);
      }
    });

    socket.on('connect', () => {
      setConnected(true);
      doAuth(socket);
    });

    socket.on('authenticated', () => {
      setAuthenticated(true);
      tryRejoin(socket);
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setAuthenticated(false);
      setOpponentReconnecting(false);
      // Update timestamp to now so rejoin window is measured from disconnect time
      const raw = localStorage.getItem(ACTIVE_ROOM_KEY);
      if (raw) {
        try {
          const stored = JSON.parse(raw);
          localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ ...stored, ts: Date.now() }));
        } catch { localStorage.removeItem(ACTIVE_ROOM_KEY); }
      }
    });

    // opponent_forfeited is no longer emitted by the backend — opponent_disconnected now carries payout data
    socket.on('opponent_disconnected', () => {
      localStorage.removeItem(ACTIVE_ROOM_KEY);
    });

    socket.on('opponent_reconnecting', ({ countdown }) => {
      setOpponentReconnecting(countdown ?? 10);
      // Clear after countdown + 1s buffer
      setTimeout(() => setOpponentReconnecting(false), ((countdown ?? 10) + 1) * 1000);
    });

    socket.on('opponent_reconnected', () => {
      setOpponentReconnecting(false);
    });

    socket.on('rejoin_success', ({ roomId, gameType }) => {
      clearTimeout(reconnectTimerRef.current);
      setRejoinResult({ success: true, roomId, gameType });
      localStorage.removeItem(ACTIVE_ROOM_KEY);
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

    return () => { socket.disconnect(); unsubSessionChange(); };
  }, []);


  const clearForfeitWin = useCallback(() => setForfeitWin(null), []);
  const clearRejoinResult = useCallback(() => setRejoinResult(null), []);

  const requestGameState = useCallback((roomId, gameType) => {
    socketRef.current?.emit('request_game_state', { roomId, gameType });
  }, []);

  // For SPA navigation: attempt rejoin without socket disconnect
  const attemptSpaRejoin = useCallback((gameType) => {
    try {
      const raw = localStorage.getItem(ACTIVE_ROOM_KEY);
      if (!raw) return false;
      const { roomId, gameType: storedType, ts } = JSON.parse(raw);
      if (storedType !== gameType) return false;
      if (Date.now() - ts > 33000) { localStorage.removeItem(ACTIVE_ROOM_KEY); return false; }
      socketRef.current?.emit('rejoin_game', { roomId });
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        setRejoinResult({ success: false, roomId, gameType });
        localStorage.removeItem(ACTIVE_ROOM_KEY);
      }, 5000);
      return true;
    } catch { return false; }
  }, []);

  return (
    <SocketContext.Provider value={{
      socket: socketRef.current,
      connected,
      authenticated,
      doAuth: () => doAuth(socketRef.current),
      forfeitWin,
      clearForfeitWin,
      opponentReconnecting,
      rejoinResult,
      clearRejoinResult,
      requestGameState,
      setActiveRoom,
      clearActiveRoom,
      attemptSpaRejoin,
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
