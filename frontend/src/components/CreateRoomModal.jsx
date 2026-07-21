import { useEffect, useState } from 'react';
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
  const [view, setView] = useState('main'); // 'main' | 'friends'
  const [friends, setFriends] = useState([]);
  const [online, setOnline] = useState([]);
  const [invitedId, setInvitedId] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) { setView('main'); setInvitedId(null); setErr(''); }
  }, [open]);

  // Load accepted friends + their online status when the friends view opens.
  useEffect(() => {
    if (!open || view !== 'friends') return;
    api.get('/auth/friends').then(list => {
      const accepted = (list || []).filter(f => f.status === 'accepted');
      const fr = accepted
        .map(f => (f.requester?.id === profile?.id ? f.addressee : f.requester))
        .filter(Boolean);
      setFriends(fr);
      if (socket && fr.length) socket.emit('check_online', { userIds: fr.map(f => f.id) });
    }).catch(() => setFriends([]));
  }, [open, view, socket, profile?.id]);

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

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl p-5 w-full max-w-sm animate-slide-up" onClick={e => e.stopPropagation()}>
        {view === 'main' ? (
          <>
            <div className="text-lg font-black text-white mb-1">🔒 Create a Room</div>
            <p className="text-xs text-muted mb-4">Play a private match with a friend.</p>
            <div className="flex flex-col gap-2.5">
              <GlowButton variant="primary" className="w-full" onClick={() => { onCreateCode?.(); onClose(); }}>
                Create &amp; Get Code
              </GlowButton>
              <button
                onClick={() => setView('friends')}
                className="w-full py-3 rounded-xl text-sm font-bold border border-border bg-surfaceLight text-white hover:border-primary transition-all"
              >
                👥 Invite Friend
              </button>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-muted hover:text-white transition-all"
              >
                Exit
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-black text-white">Invite a Friend</div>
              <button onClick={() => setView('main')} className="text-xs text-muted hover:text-white">← Back</button>
            </div>
            {err && <p className="text-danger text-xs mb-2 font-medium">{err}</p>}
            <div className="max-h-72 overflow-y-auto flex flex-col gap-1.5 -mr-1 pr-1">
              {friends.length === 0 && (
                <p className="text-muted text-xs text-center py-6">No friends yet. Add some on your profile!</p>
              )}
              {friends.map(f => {
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
                      <div className="text-[10px] text-muted">{isOnline ? '🟢 Online' : '⚫ Offline'}</div>
                    </div>
                    <button
                      onClick={() => invite(f.id)}
                      disabled={disabled}
                      className={`shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-lg transition-all ${
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
      </div>
    </div>
  );
}
