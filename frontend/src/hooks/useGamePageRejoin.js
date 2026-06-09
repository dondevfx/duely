import { useEffect, useRef, useState, createElement } from 'react';
import { useSocket } from '../context/SocketContext';
import RejoinPopup from '../components/RejoinPopup';

const ACTIVE_ROOM_KEY = 'c1v1_active_room';

export function useGamePageRejoin(gameType, phase, roomId, onRejoin, onRejoinFailed) {
  const { socket, rejoinResult, clearRejoinResult, attemptSpaRejoin } = useSocket();
  const phaseRef    = useRef(phase);
  const roomIdRef   = useRef(roomId);
  const didAttempt  = useRef(false);
  const [pendingRejoin, setPendingRejoin] = useState(null); // { secondsLeft }

  useEffect(() => { phaseRef.current  = phase;  }, [phase]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

  // On mount: check localStorage and show rejoin popup if a session is pending
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_ROOM_KEY);
      if (!raw) return;
      const { gameType: storedType, ts } = JSON.parse(raw);
      if (storedType !== gameType) return;
      const elapsed     = Math.floor((Date.now() - ts) / 1000);
      const secondsLeft = 30 - elapsed;
      if (secondsLeft <= 1) { localStorage.removeItem(ACTIVE_ROOM_KEY); return; }
      setPendingRejoin({ secondsLeft });
    } catch { localStorage.removeItem(ACTIVE_ROOM_KEY); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function doRejoin() {
    if (didAttempt.current) return;
    didAttempt.current = true;
    setPendingRejoin(null);
    attemptSpaRejoin(gameType);
  }

  function dismissRejoin() {
    setPendingRejoin(null);
    localStorage.removeItem(ACTIVE_ROOM_KEY);
  }

  // On unmount: tell server we left and update localStorage timestamp
  useEffect(() => {
    return () => {
      const p = phaseRef.current;
      const r = roomIdRef.current;
      if ((p === 'game' || p === 'active' || p === 'countdown') && r) {
        socket?.emit('game_page_leave', { roomId: r });
        try {
          const raw = localStorage.getItem(ACTIVE_ROOM_KEY);
          if (raw) {
            const stored = JSON.parse(raw);
            localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ ...stored, ts: Date.now() }));
          }
        } catch {}
      }
    };
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle server rejoin response
  useEffect(() => {
    if (!rejoinResult || rejoinResult.gameType !== gameType) return;
    if (rejoinResult.success) {
      onRejoin?.(rejoinResult.roomId);
    } else {
      onRejoinFailed?.();
    }
    clearRejoinResult();
  }, [rejoinResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const RejoinOverlay = pendingRejoin
    ? createElement(RejoinPopup, {
        secondsLeft: pendingRejoin.secondsLeft,
        onRejoin: doRejoin,
        onDismiss: dismissRejoin,
      })
    : null;

  return { RejoinOverlay };
}
