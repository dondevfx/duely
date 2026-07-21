import { useState, useEffect } from 'react';
import GlowButton from './GlowButton';

// Centered "Join a Room" modal shared by all game pages — enter the code a
// friend shared. Mirrors CreateRoomModal so both flows feel the same.
export default function JoinRoomModal({ open, onClose, onJoin, authenticated = true }) {
  const [code, setCode] = useState('');

  useEffect(() => { if (!open) setCode(''); }, [open]);

  if (!open) return null;

  const canJoin = authenticated && code.length >= 4;
  const submit = () => { if (canJoin) { onJoin(code); onClose(); } };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl p-5 w-full max-w-sm animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="text-lg font-black text-white mb-1">🔗 Join a Game</div>
        <p className="text-xs text-muted mb-4">Enter the 6-character code your friend shared.</p>
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          placeholder="ABC123"
          autoFocus
          className="w-full bg-surfaceLight border border-border rounded-lg px-3 py-3 text-white font-mono text-lg tracking-[0.3em] focus:outline-none focus:border-primary text-center mb-4"
        />
        <div className="flex flex-col gap-2.5">
          <GlowButton variant="primary" className="w-full" disabled={!canJoin} onClick={submit}>
            Join Game
          </GlowButton>
          <button onClick={onClose} className="w-full py-2.5 rounded-xl text-sm font-semibold text-muted hover:text-white transition-all">
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}
