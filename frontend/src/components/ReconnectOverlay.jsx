import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';

const GAME_ROUTES = {
  connectFour: '/game/c4', chess: '/game/chess',
  checkers: '/game/checkers', uno: '/game/uno', rps: '/game/rps',
  type: '/game/type',
};

export default function ReconnectOverlay() {
  const { opponentReconnecting, rejoinResult, clearRejoinResult } = useSocket();
  const { refreshProfile } = useAuth();
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);

  // Tick the countdown down from the initial value
  useEffect(() => {
    if (opponentReconnecting) {
      setCountdown(opponentReconnecting);
      const interval = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
      return () => clearInterval(interval);
    }
  }, [opponentReconnecting]);

  // On successful rejoin: navigate back to the game page
  useEffect(() => {
    if (rejoinResult?.success) {
      const route = GAME_ROUTES[rejoinResult.gameType] || `/game/${rejoinResult.gameType}`;
      const roomId = rejoinResult.roomId;
      const gameType = rejoinResult.gameType;
      setShowSuccess(true);
      const t = setTimeout(() => {
        setShowSuccess(false);
        clearRejoinResult();
        navigate(route, { state: { rejoin: true, roomId, gameType } });
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [rejoinResult]);

  // Refresh balance on forfeit loss
  useEffect(() => {
    if (rejoinResult && !rejoinResult.success) refreshProfile();
  }, [rejoinResult]);

  if (!opponentReconnecting && !rejoinResult && !showSuccess) return null;

  // Rejoined successfully
  if (showSuccess) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-surface border border-green-500/40 rounded-2xl px-8 py-6 shadow-glow text-center max-w-sm mx-4">
          <div className="text-4xl mb-3">✅</div>
          <div className="text-white font-black text-xl mb-1">Rejoined!</div>
          <div className="text-muted text-sm">Returning to your game…</div>
        </div>
      </div>
    );
  }

  // Opponent disconnected — show countdown to stayer
  if (opponentReconnecting) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-surface border border-yellow-500/40 rounded-2xl px-8 py-6 shadow-glow text-center max-w-sm mx-4">
          <div className="text-4xl mb-3">⏳</div>
          <div className="text-white font-black text-xl mb-1">Opponent Disconnected</div>
          <div className="text-muted text-sm mb-4">Waiting for them to reconnect…</div>
          <div className="text-yellow-400 font-black text-5xl">{countdown}</div>
          <div className="text-muted text-xs mt-2">They have 10s to return</div>
        </div>
      </div>
    );
  }

  if (rejoinResult && !rejoinResult.success) {
    clearRejoinResult();
  }

  return null;
}
