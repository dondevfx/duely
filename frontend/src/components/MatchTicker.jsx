import { useState, useEffect, useRef } from 'react';
import GameIcon from './GameIcon';
import DiamondIcon from './DiamondIcon';
import CoinIcon from './CoinIcon';
import { useSocket } from '../context/SocketContext';

const MAX = 14;
const MOBILE_MAX = 6;

function fmtPayout(payout, diamonds) {
  if (diamonds) {
    const n = payout >= 1000
      ? `+${(payout / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : `+${payout}`;
    return <span className="inline-flex items-center gap-0.5">{n}<DiamondIcon size="0.9em" /></span>;
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
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 639px)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = e => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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
    // Re-request the seed every time the component mounts (handles SPA navigation)
    socket.emit('request_ticker_seed');
    return () => {
      socket.off('ticker_seed', onSeed);
      socket.off('ticker_item', onItem);
    };
  }, [socket]);

  const card = (item, i) => (
    <div
      key={item.id}
      className={`flex flex-col items-center justify-center gap-1.5 sm:gap-1 lg:gap-1.5 py-4 sm:py-2 lg:py-3 px-0.5 sm:px-0.5 bg-surface border border-primary/50 rounded-lg sm:rounded-lg lg:rounded-xl overflow-hidden min-w-0${
        i === 0 && item.id === latestIdRef.current ? ' animate-pop-in' : ''
      }`}
    >
      <GameIcon game={item.game.key} size={26} className="shrink-0" />
      <span className="text-[8px] sm:text-[8px] lg:text-[9px] text-muted font-medium leading-none w-full text-center truncate px-0.5">
        {item.game.name}
      </span>
      {/* whitespace-nowrap, not truncate: six cards on a 375px screen leave
          roughly 45px inside each one, and "+100k 💎" was being clipped to an
          ellipsis. Overflow is hidden by the card, so the text is sized to fit
          instead of being cut. */}
      <span className="text-[9px] sm:text-[9px] lg:text-[10px] font-bold text-success leading-none w-full text-center whitespace-nowrap px-0">
        {fmtPayout(item.payout, item.diamonds)}
      </span>
    </div>
  );

  if (items.length === 0) return null;

  const visible = isMobile ? items.slice(0, MOBILE_MAX) : items;
  const cols = isMobile ? MOBILE_MAX : MAX;

  return (
    <div className="grid gap-1 sm:gap-1.5 lg:gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {visible.map((item, i) => card(item, i))}
    </div>
  );
}
