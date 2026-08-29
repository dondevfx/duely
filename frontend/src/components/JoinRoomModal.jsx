import { useState, useEffect } from 'react';
import GlowButton from './GlowButton';
import CoinIcon from './CoinIcon';
import GameIcon from './GameIcon';
import { useSocket } from '../context/SocketContext';

const GAME_NAMES = {
  blackjack:   'Blackjack',
  'coin-flip': 'Coin Flip',
  scrabble:    'Word VS',
  blockBlast:  'Block Burst',
  carDash:     'Rush Hour',
  colorRush:   'Color Rush',
  tower:       'Tower',
};

// Centered "Join a Room" modal shared by all game pages — enter the code a
// friend shared. Mirrors CreateRoomModal so both flows feel the same.
//
// Two steps, not one. Typing a code used to join immediately, which meant the
// entry fee came out before you had seen who was behind the code or what it
// cost — the same problem a shared challenge link had, and it is fixed the
// same way: peek first (read-only, joins nothing), show the host and the
// stake, and only Accept spends anything.
//
// The confirm step lives HERE rather than in the six game pages because this
// modal is the single point every code entry already flows through. Six
// hand-written copies is how one game gets missed.
export default function JoinRoomModal({ open, onClose, onJoin, authenticated = true }) {
  const [code, setCode]   = useState('');
  const [info, setInfo]   = useState(null);   // the peeked room, once it arrives
  const [error, setError] = useState('');
  const [peeking, setPeeking] = useState(false);
  const { socket } = useSocket() || {};

  const reset = () => { setCode(''); setInfo(null); setError(''); setPeeking(false); };
  useEffect(() => { if (!open) reset(); }, [open]);

  // Only listen while a peek is actually in flight. The server reports a bad
  // code on the shared 'error' channel, so a permanent listener here would
  // show unrelated errors inside this modal.
  useEffect(() => {
    if (!socket || !peeking) return;
    const onInfo = (data) => { setPeeking(false); setInfo(data); };
    const onErr  = ({ message }) => { setPeeking(false); setError(message || 'That code is no longer available.'); };
    socket.on('private_room_info', onInfo);
    socket.on('error', onErr);
    return () => { socket.off('private_room_info', onInfo); socket.off('error', onErr); };
  }, [socket, peeking]);

  if (!open) return null;

  const canJoin = authenticated && code.length >= 4;
  const submit = () => {
    if (!canJoin || peeking) return;
    setError('');
    setPeeking(true);
    socket?.emit('peek_private_room', { code });
  };

  // Back to the code field rather than closing outright — a mistyped code is
  // the likeliest reason to be here, and retyping it should not cost a click
  // on Join Room first.
  const back = () => { setInfo(null); setError(''); setCode(''); };

  const isFree = !info || (info.entryFee ?? 0) === 0;
  const stake  = info && !isFree && (
    info.currency === 'diamonds'
      ? <>{Number(info.entryFee).toLocaleString()} 💎</>
      : <span className="inline-flex items-center gap-1">{Number(info.entryFee).toLocaleString()} <CoinIcon size="0.9em" /></span>
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl p-5 w-full max-w-sm animate-slide-up" onClick={e => e.stopPropagation()}>

        {info && info.isHost ? (
          <div className="text-center">
            <div className="text-4xl mb-3">👋</div>
            <div className="text-lg font-black text-white mb-1">That's your own room</div>
            <p className="text-xs text-muted mb-5">Send the code to someone else — you can't play yourself.</p>
            <GlowButton variant="primary" className="w-full" onClick={back}>Try another code</GlowButton>
            <button onClick={onClose} className="w-full py-2.5 mt-2 rounded-xl text-sm font-semibold text-muted hover:text-white transition-all">
              Exit
            </button>
          </div>
        ) : info ? (
          <div className="text-center">
            <div className="text-5xl mb-3">🎮</div>
            <p className="text-muted text-sm mb-1">{info.hostUsername} is waiting in</p>
            <div className="text-xl font-black text-white mb-4 flex items-center justify-center gap-2">
              <GameIcon game={info.gameType} size={24} />{GAME_NAMES[info.gameType] || 'a match'}
            </div>

            <div className="bg-bg border border-border rounded-xl p-4 mb-5 space-y-2 text-left">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Opponent</span>
                <span className="text-white font-bold">
                  {info.hostUsername}
                  {info.hostElo != null && <span className="text-muted font-normal"> · {info.hostElo} ELO</span>}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Entry fee</span>
                <span className="text-white font-black">{isFree ? 'Free' : stake}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-xl font-black text-base bg-surface border border-surfaceLight text-white hover:border-danger hover:text-danger transition-all"
              >
                Decline
              </button>
              <button
                onClick={() => { onJoin(info.code); onClose(); }}
                className="flex-1 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
              >
                Accept
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-lg font-black text-white mb-1">🔗 Join a Game</div>
            <p className="text-xs text-muted mb-4">Enter the 6-character code your friend shared.</p>
            <input
              value={code}
              onChange={e => { setError(''); setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)); }}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              placeholder="ABC123"
              autoFocus
              className="w-full bg-surfaceLight border border-border rounded-lg px-3 py-3 text-white font-mono text-lg tracking-[0.3em] focus:outline-none focus:border-primary text-center mb-2"
            />
            <p className={`text-xs text-center mb-3 ${error ? 'text-danger' : 'text-muted'}`}>
              {error || "You'll see the match details before anything is accepted."}
            </p>
            <div className="flex flex-col gap-2.5">
              <GlowButton variant="primary" className="w-full" disabled={!canJoin || peeking} onClick={submit}>
                {peeking ? 'Checking…' : 'Continue'}
              </GlowButton>
              <button onClick={onClose} className="w-full py-2.5 rounded-xl text-sm font-semibold text-muted hover:text-white transition-all">
                Exit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
