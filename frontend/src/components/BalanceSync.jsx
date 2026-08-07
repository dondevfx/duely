import { useEffect, useRef } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { isBalanceHeld, onBalanceRelease } from '../utils/balanceHold';

// Keeps the displayed balance live. The server emits `balance_changed` on any
// balance movement (match settle, entry fee, tip, deposit, withdrawal, refund),
// and we re-pull the profile — so the balance is never stale and the user never
// has to refresh the page.
//
// One exception: while a reveal is playing, a refresh is deferred rather than
// dropped. Coin Flip settles the moment the server picks a side, so without this
// the navbar balance moved while the coin was still spinning — which both spoils
// the animation and gives away the result. See utils/balanceHold.
export default function BalanceSync() {
  const { socket } = useSocket();
  const { refreshProfile } = useAuth();
  const lastRef = useRef(0);
  const timerRef = useRef(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!socket) return;

    // Coalesce bursts (a settle can fire several changes at once) to at most
    // one profile fetch per second, so this can't burn the API rate limit.
    const doRefresh = () => {
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

    const onChanged = () => {
      // Deferred, never dropped — the balance still lands, just after the reveal.
      if (isBalanceHeld()) { pendingRef.current = true; return; }
      doRefresh();
    };

    const offRelease = onBalanceRelease(() => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      doRefresh();
    });

    socket.on('balance_changed', onChanged);
    return () => {
      socket.off('balance_changed', onChanged);
      offRelease();
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [socket, refreshProfile]);

  return null;
}
