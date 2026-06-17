import { useState, useEffect, useRef } from 'react';
import CoinIcon from './CoinIcon';
import { useSocket } from '../context/SocketContext';

const MAX = 14;

function fmtPayout(payout, diamonds) {
  if (diamonds) {
    if (payout >= 1000) return `+${(payout / 1000).toFixed(1).replace(/\.0$/, '')}k 💎`;
    return `+${payout} 💎`;
  }
  const amt = payout >= 1000
    ? `+${(payout / 1000).toFixed(1).replace(/\.0$/, '')}k`
    : `+${payout % 1 === 0 ? payout : payout.toFixed(2)}`;
  return <span className="inline-flex items-center gap-0.5">{amt} <CoinIcon size="0.85em" /></span>;
}

export default function MatchTicker() {
  const { socket } = useSocket();
  const [items, setItems] = useState([]);
  // Track latest item id to drive the pop-in animation on the newest card only
  const latestIdRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    function onSeed(seed) {
      setItems(seed.slice(0, MAX));
    }

    function onItem(item) {
      latestIdRef.current = item.id;
      setItems(prev => [item, ...prev].slice(0, MAX));
    }

    socket.on('ticker_seed', onSeed);
    socket.on('ticker_item', onItem);
    return () => {
      socket.off('ticker_seed', onSeed);
      socket.off('ticker_item', onItem);
    };
  }, [socket]);

  const card = (item, i) => (
    <div
      key={item.id}
      className={`flex flex-col items-center justify-center gap-1.5 py-3 px-1 bg-surface border rounded-xl overflow-hidden shrink-0${
        i === 0 && item.id === latestIdRef.current ? ' animate-pop-in' : ''
      }`}
      style={{ height: 90, width: 80 }}
    >
      <span className="text-3xl leading-none shrink-0">{item.game.icon}</span>
      <span className="text-[9px] text-muted font-medium leading-none w-full text-center truncate px-1">
        {item.game.name}
      </span>
      <span className="text-[10px] font-bold text-success leading-none truncate w-full text-center px-1">
        {fmtPayout(item.payout, item.diamonds)}
      </span>
    </div>
  );

  if (items.length === 0) return null;

  return (
    <>
      <div className="lg:hidden flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {items.map((item, i) => card(item, i))}
      </div>
      <div className="hidden lg:grid gap-2" style={{ gridTemplateColumns: `repeat(${MAX}, 1fr)` }}>
        {items.map((item, i) => card(item, i))}
      </div>
    </>
  );
}
