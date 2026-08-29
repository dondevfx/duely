import { useEffect, useState, useCallback } from 'react';
import DiamondIcon from './DiamondIcon';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import CoinIcon from './CoinIcon';
import Avatar from './Avatar';
import { api } from '../utils/api';
import { playMatchFound } from '../utils/sound';

const GAME_ROUTES = {
  blackjack:   '/game/blackjack',
  'coin-flip': '/game/coin-flip',
  scrabble:    '/game/word-vs',
  blockBlast:  '/game/block-blast',
  carDash:     '/game/car-dash',
  colorRush:   '/game/color-rush',
  tower:       '/game/tower',
};
const GAME_NAMES = {
  blackjack:   'Blackjack',
  'coin-flip': 'Coin Flip',
  scrabble:    'Word VS',
  blockBlast:  'Block Burst',
  carDash:     'Rush Hour',
  colorRush:   'Color Rush',
  tower:       'Tower',
};

// Global top-right stack of incoming friend game invites. Newest sits on top;
// older ones are pushed down beneath it.
export default function InviteToasts() {
  const { socket } = useSocket();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [invites, setInvites] = useState([]);
  const [friendBusy, setFriendBusy] = useState(null);

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

    // Friend requests only existed as a database row, so you found out by
    // happening to open your profile. It is answerable in place now, the same
    // as a game invite — and it carries the sender's picture, because a name on
    // its own is not much to decide on.
    //
    // No auto-dismiss: a game invite expires on its own so letting it fade is
    // honest, but a friend request sits in the inbox until it is answered, and
    // a toast that vanished implied it had gone away when it had not.
    const onFriendRequest = ({ fromUserId, fromUsername, fromAvatar, fromColor }) => {
      const id = 'fr_' + (fromUserId || Date.now());
      setInvites(list => list.some(i => i.inviteId === id) ? list : [{
        inviteId: id, friendRequest: true,
        fromUserId, fromUsername, fromAvatar, fromColor, at: Date.now(),
      }, ...list]);
      playMatchFound();
    };

    socket.on('game_invite', onInvite);
    socket.on('invite_cancelled', onCancelled);
    socket.on('friend_request', onFriendRequest);
    return () => {
      socket.off('game_invite', onInvite);
      socket.off('invite_cancelled', onCancelled);
      socket.off('friend_request', onFriendRequest);
    };
  }, [socket, remove]);

  // Answering happens here rather than on the friends page, so the request is
  // dealt with where it appears. A failure still removes the toast — the row is
  // in the friends panel either way, and a toast that refuses to go away after
  // a network blip is worse than one that closed early.
  async function answerFriend(inv, accept) {
    if (!inv.fromUserId) { remove(inv.inviteId); navigate('/profile'); return; }
    setFriendBusy(inv.inviteId);
    try {
      await api.post(accept ? '/auth/friend-accept-by-user' : '/auth/friend-decline-by-user',
        { userId: inv.fromUserId });
    } catch { /* shown in the friends panel regardless */ }
    setFriendBusy(null);
    remove(inv.inviteId);
  }

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
        // A friend request has nothing to accept in place — it is a heads-up
        // with a way to get to the list, not a two-button decision.
        if (inv.friendRequest) {
          const busy = friendBusy === inv.inviteId;
          return (
            <div key={inv.inviteId} className="pointer-events-auto animate-slide-down bg-surface border border-primary/40 rounded-xl px-4 py-3 shadow-glow w-[260px]">
              <div className="flex items-center gap-2">
                <Avatar username={inv.fromUsername} avatarUrl={inv.fromAvatar}
                  color={inv.fromColor} className="w-9 h-9" textClassName="text-xs" />
                <div className="min-w-0">
                  <div className="text-sm font-black text-white truncate">{inv.fromUsername}</div>
                  <div className="text-xs text-muted">wants to be your friend</div>
                </div>
              </div>
              <div className="flex gap-2 mt-2.5">
                <button
                  disabled={busy}
                  onClick={() => answerFriend(inv, true)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-bold bg-primary text-white hover:bg-blue-500 transition-all disabled:opacity-60"
                >
                  {busy ? '…' : 'Accept'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => answerFriend(inv, false)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-bold border border-border text-muted hover:text-white transition-all disabled:opacity-60"
                >
                  Decline
                </button>
              </div>
            </div>
          );
        }
        const isDiamonds = inv.currency === 'diamonds';
        const bal = isDiamonds ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
        const canAfford = (inv.entryFee ?? 0) <= bal;
        const betEl = (inv.entryFee ?? 0) === 0
          ? <span className="text-muted">Free</span>
          : isDiamonds
            ? <span className="inline-flex items-center gap-1">{Number(inv.entryFee).toLocaleString()} <DiamondIcon /></span>
            : <span className="inline-flex items-center gap-1">{Number(inv.entryFee).toLocaleString()} <CoinIcon size="0.8em" /></span>;
        return (
          <div key={inv.inviteId} className="pointer-events-auto animate-slide-down bg-surface border border-primary/40 rounded-xl px-4 py-3 shadow-glow w-[260px]">
            <div className="flex items-center gap-2">
              <Avatar username={inv.fromUsername} avatarUrl={inv.fromAvatar}
                color={inv.fromColor} className="w-9 h-9" textClassName="text-xs" />
              <div className="min-w-0">
                <div className="text-sm font-black text-white truncate">{inv.fromUsername} invited you</div>
                <div className="text-xs text-muted">{GAME_NAMES[inv.gameType] || 'a game'} · Bet: {betEl}</div>
              </div>
            </div>
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
