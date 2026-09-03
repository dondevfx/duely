import { useEffect, useState } from 'react';
import UiIcon from './UiIcon';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import GlowButton from './GlowButton';

// Centered "Create a Room" modal shared by all game pages. Offers a shareable
// code (existing flow) or a direct friend invite. On a successful invite the
// parent page moves to its waiting screen via the `invite_sent` socket event.
export default function CreateRoomModal({ open, onClose, gameType, entryFee = 0, currency = 'coins', onCreateCode }) {
  const { socket } = useSocket();
  const { profile } = useAuth();
  const [friends, setFriends] = useState([]);
  const [online, setOnline] = useState([]);
  const [invitedId, setInvitedId] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) { setInvitedId(null); setErr(''); }
  }, [open]);

  // Load accepted friends + their online status whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    api.get('/auth/friends').then(list => {
      const accepted = (list || []).filter(f => f.status === 'accepted');
      const fr = accepted
        .map(f => (f.requester?.id === profile?.id ? f.addressee : f.requester))
        .filter(Boolean);
      setFriends(fr);
      if (socket && fr.length) socket.emit('check_online', { userIds: fr.map(f => f.id) });
    }).catch(() => setFriends([]));
  }, [open, socket, profile?.id]);

  useEffect(() => {
    if (!socket) return;
    const onOnline = ({ online }) => setOnline(online || []);
    const onFailed = ({ message }) => { setErr(message); setInvitedId(null); };
    socket.on('online_status', onOnline);
    socket.on('invite_failed', onFailed);
    return () => { socket.off('online_status', onOnline); socket.off('invite_failed', onFailed); };
  }, [socket]);

  if (!open) return null;

  const bal = currency === 'diamonds' ? (profile?.diamonds ?? 0) : (profile?.c_coins ?? 0);
  const canAfford = entryFee <= bal;

  function invite(friendId) {
    if (!socket) return;
    setErr('');
    setInvitedId(friendId);
    socket.emit('invite_friend', { friendId, gameType, entryFee, currency });
    // The page's `invite_sent` listener closes this modal and shows the waiting screen.
  }

  const onlineFriends = friends.filter(f => online.includes(f.id));

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl p-5 w-full max-w-sm animate-slide-up" onClick={e => e.stopPropagation()}>
        {/* A title, the link, and the friends who can take it. The sentence
            that used to sit under the title explained what a link is, which
            the button below it already says — and on a dialog this short an
            explanation is most of the dialog. */}
        <div className="text-lg font-black text-white mb-4">Invite</div>

        {err && <p className="text-danger text-xs mb-2 font-medium">{err}</p>}

        <GlowButton variant="primary" className="w-full" onClick={() => { onCreateCode?.(); onClose(); }}>
          <span className="inline-flex items-center justify-center gap-2 whitespace-nowrap">
            <UiIcon name="share" size={18} />Invite Link
          </span>
        </GlowButton>

        {/* Said out loud rather than left as a gap. With no heading and no
            list, an empty space under the button reads as something that
            failed to load — "no friends online" is a state, and states are
            worth naming. */}
        {onlineFriends.length === 0 && (
          <p className="text-xs text-muted text-center mt-4">No friends online</p>
        )}

        {/* Online friends — one tap to invite directly */}
        {onlineFriends.length > 0 && (
          <>
            <div className="mt-5 mb-2" />
            <div className="max-h-56 overflow-y-auto flex flex-col gap-1.5 -mr-1 pr-1">
              {onlineFriends.map(f => {
                const isOnline = online.includes(f.id);
                const invited = invitedId === f.id;
                const disabled = !isOnline || !canAfford || invited;
                return (
                  <div key={f.id} className="flex items-center gap-2 p-2 rounded-xl bg-bg border border-border">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black shrink-0"
                      style={{ backgroundColor: `${f.profile_color || '#1250B4'}22`, border: `1.5px solid ${f.profile_color || '#1250B4'}`, color: f.profile_color || '#1250B4' }}>
                      {(f.username || '?')[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-white truncate">{f.username}</div>
                      <div className="text-[0.625rem] text-muted">{isOnline ? '🟢 Online' : '⚫ Offline'}</div>
                    </div>
                    <button
                      onClick={() => invite(f.id)}
                      disabled={disabled}
                      className={`shrink-0 text-[0.6875rem] font-bold px-3 py-1.5 rounded-lg transition-all ${
                        disabled
                          ? 'bg-surfaceLight text-muted cursor-not-allowed opacity-60'
                          : 'bg-primary text-white hover:bg-blue-500'
                      }`}
                    >
                      {invited ? 'Invited' : !canAfford ? 'Low balance' : !isOnline ? 'Offline' : 'Invite'}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <button
          onClick={onClose}
          className="w-full mt-4 py-2.5 rounded-xl text-sm font-semibold text-muted hover:text-white transition-all"
        >
          Exit
        </button>
      </div>
    </div>
  );
}
