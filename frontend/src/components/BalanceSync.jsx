import { useEffect, useRef } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';

// Keeps the displayed balance live. The server emits `balance_changed` on any
// balance movement (match settle, entry fee, tip, deposit, withdrawal, refund),
// and we re-pull the profile — so the balance is never stale and the user never
// has to refresh the page.
export default function BalanceSync() {
  const { socket } = useSocket();
  const { refreshProfile } = useAuth();
  const lastRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    // Coalesce bursts (a settle can fire several changes at once) to at most
    // one profile fetch per second, so this can't burn the API rate limit.
    const onChanged = () => {
      const since = Date.now() - lastRef.current;
      if (since >= 1000) {
        lastRef.current = Date.now();
        refreshProfile();
      } else if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          lastRef.current = Date.now();
          refreshProfile();
        }, 1000 - since);
      }
    };

    socket.on('balance_changed', onChanged);
    return () => {
      socket.off('balance_changed', onChanged);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [socket, refreshProfile]);

  return null;
}
