import { useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ForfeitToast() {
  const { forfeitWin, clearForfeitWin } = useSocket();
  const { refreshProfile } = useAuth();

  useEffect(() => {
    if (forfeitWin) refreshProfile();
  }, [forfeitWin]);

  if (!forfeitWin) return null;

  const sym = forfeitWin.currency === 'diamonds' ? '💎' : <CoinIcon size="0.85em" />;

  return (
    <div
      className="fixed top-20 left-1/2 -translate-x-1/2 z-50 animate-slide-down"
      onClick={clearForfeitWin}
    >
      <div className="bg-surface border border-success/40 rounded-2xl px-6 py-4 shadow-glow text-center min-w-72 cursor-pointer">
        <div className="text-2xl mb-1">🏆</div>
        <div className="text-white font-black text-lg">Opponent Disconnected!</div>
        <div className="text-success font-bold text-base mt-1">
          +{fmt(forfeitWin.winnerPayout)} {sym}
        </div>
        <div className="text-muted text-xs mt-1">Tap to dismiss</div>
      </div>
    </div>
  );
}
