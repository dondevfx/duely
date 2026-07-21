import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';
import { playMatchFound } from '../utils/sound';

const GAME_ROUTES = {
  blackjack:   '/game/blackjack',
  'coin-flip': '/game/coin-flip',
  scrabble:    '/game/word-vs',
  blockBlast:  '/game/block-blast',
};
const GAME_NAMES = {
  blackjack:   'Blackjack',
  'coin-flip': 'Coin Flip',
  scrabble:    'Word VS',
  blockBlast:  'Block Burst',
};

// Global top-right stack of incoming friend game invites. Newest sits on top;
// older ones are pushed down beneath it.
export default function InviteToasts() {
  const { socket } = useSocket();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [invites, setInvites] = useState([]);

  const remove = useCallback((id) => setInvites(list => list.filter(i => i.inviteId !== id)), []);

  useEffect(() => {
    if (!socket) return;
    const onInvite = (inv) => {
      setInvites(list => {
        if (list.some(i => i.inviteId === inv.inviteId)) return list; // dedupe
        return [{ ...inv, at: Date.now() }, ...list];
      });
      playMatchFound();
    };
    const onCancelled = ({ inviteId }) => remove(inviteId);
    socket.on('game_invite', onInvite);
    socket.on('invite_cancelled', onCancelled);
    return () => { socket.off('game_invite', onInvite); socket.off('invite_cancelled', onCancelled); };
  }, [socket, remove]);

  function join(inv) {
    const route = GAME_ROUTES[inv.gameType];
    remove(inv.inviteId);
    if (route) navigate(route, { state: { joinCode: inv.code, autoJoin: true, entryFee: inv.entryFee, currency: inv.currency } });
  }
  function decline(inv) {
    socket?.emit('invite_decline', { inviteId: inv.inviteId });
    remove(inv.inviteId);
  }

  if (invites.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 z-[110] flex flex-col gap-2 pointer-events-none">
      {invites.map(inv => {
        const isDiamonds = inv.currency === 'diamonds';
        const bal = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
        const canAfford = (inv.entryFee ?? 0) <= bal;
        const betEl = (inv.entryFee ?? 0) === 0
          ? <span className="text-muted">Free</span>
          : isDiamonds
            ? <>{Number(inv.entryFee).toLocaleString()} 💎</>
            : <span className="inline-flex items-center gap-1">{Number(inv.entryFee).toLocaleString()} <CoinIcon size="0.8em" /></span>;
        return (
          <div key={inv.inviteId} className="pointer-events-auto animate-slide-down bg-surface border border-primary/40 rounded-xl px-4 py-3 shadow-glow w-[260px]">
            <div className="text-sm font-black text-white">🎮 {inv.fromUsername} invited you</div>
            <div className="text-xs text-muted mt-0.5">{GAME_NAMES[inv.gameType] || 'a game'} · Bet: {betEl}</div>
            <div className="flex gap-2 mt-2.5">
              <button
                onClick={() => join(inv)}
                disabled={!canAfford}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  canAfford ? 'bg-primary text-white hover:bg-blue-500' : 'bg-surfaceLight text-muted cursor-not-allowed opacity-60'
                }`}
              >
                {canAfford ? 'Join' : 'Insufficient'}
              </button>
              <button
                onClick={() => decline(inv)}
                className="flex-1 py-1.5 rounded-lg text-xs font-bold border border-border text-muted hover:text-white transition-all"
              >
                Decline
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
