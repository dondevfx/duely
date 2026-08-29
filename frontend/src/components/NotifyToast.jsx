import { useEffect, useState, useCallback } from 'react';
import DiamondIcon from './DiamondIcon';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';
import { playTip, playDeposit } from '../utils/sound';

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let idCounter = 0;

// Top-right toasts for money events (tips received, deposits credited).
// Plays a sound and refreshes the profile so the balance updates live.
export default function NotifyToast() {
  const { socket } = useSocket();
  const { refreshProfile } = useAuth();
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), []);

  const push = useCallback((toast) => {
    const id = ++idCounter;
    setToasts(t => [...t, { id, ...toast }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onTip = ({ amount, currency, from }) => {
      playTip();
      push({ kind: 'tip', amount, currency: currency || 'coins', from });
      refreshProfile();
      setTimeout(refreshProfile, 1500);
    };
    const onDeposit = ({ amount, currency }) => {
      playDeposit();
      push({ kind: 'deposit', amount, currency: currency || 'coins' });
      refreshProfile();
      setTimeout(refreshProfile, 1500);
    };

    socket.on('tip_received', onTip);
    socket.on('deposit_credited', onDeposit);
    return () => {
      socket.off('tip_received', onTip);
      socket.off('deposit_credited', onDeposit);
    };
  }, [socket, refreshProfile, push]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => {
        const isDiamonds = t.currency === 'diamonds';
        const amountEl = isDiamonds
          ? <span className="inline-flex items-center gap-1">{Number(t.amount).toLocaleString()} <DiamondIcon /></span>
          : <span className="inline-flex items-center gap-1">{fmt(t.amount)} <CoinIcon size="0.85em" /></span>;
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className="pointer-events-auto cursor-pointer animate-slide-down bg-surface border border-success/40 rounded-xl px-4 py-3 shadow-glow min-w-[220px] max-w-[300px]"
          >
            <div className="text-sm font-black text-white">
              {t.kind === 'deposit' ? '💰 Deposit received' : `💸 Tip from ${t.from || 'Someone'}`}
            </div>
            <div className="text-success font-bold text-base mt-0.5">+{amountEl}</div>
          </div>
        );
      })}
    </div>
  );
}
