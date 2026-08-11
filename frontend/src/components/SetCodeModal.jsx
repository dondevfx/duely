import { useState } from 'react';
import { api } from '../utils/api';
import { setCachedCode } from '../utils/referralCode';

// Choose your own invite code.
//
// The code is the visible part of the link people share, so it is theirs to
// pick rather than something generated for them. It is also the moment they
// learn the invite link exists at all, which is why the share button becomes
// "Set Code" instead of quietly doing nothing.
const CODE_RE = /^[A-Z0-9]{4,12}$/;   // must match validateCode on the server

export default function SetCodeModal({ open, onClose, onSet }) {
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const clean = code.trim().toUpperCase();
  const valid = CODE_RE.test(clean);

  async function save() {
    if (!valid || saving) return;
    setSaving(true); setError('');
    try {
      const res = await api.post('/affiliate/set-code', { code: clean });
      const saved = res.code || clean;
      setCachedCode(saved);
      onSet?.(saved);
      onClose?.();
    } catch (err) {
      // The server owns uniqueness, so "already taken" can only come from it.
      setError(err.message || 'Could not save that code.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-surfaceLight rounded-2xl w-full max-w-sm p-6"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-black text-white mb-1">Set your invite code</h3>
        <p className="text-sm text-muted mb-4">
          This is the code on your invite link. Pick something people will remember.
        </p>

        <input
          autoFocus
          value={code}
          // Uppercased as they type, because the server uppercases anyway and a
          // field that silently rewrites your input on submit feels broken.
          onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder="YOURCODE"
          maxLength={12}
          className="w-full bg-bg border border-border rounded-xl px-3 py-3 text-white font-mono tracking-widest text-center text-lg placeholder-muted/50 focus:outline-none focus:border-primary"
        />

        <p className={`text-xs mt-2 ${error ? 'text-danger' : 'text-muted'}`}>
          {error || '4–12 letters and numbers'}
        </p>

        {clean && !error && (
          <p className="text-[11px] text-muted mt-2 break-all">
            {window.location.origin}/?ref=<span className="text-primary font-bold">{clean}</span>
          </p>
        )}

        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-surfaceLight text-muted hover:text-white transition-all text-sm font-bold"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!valid || saving}
            className="flex-1 py-2.5 rounded-xl bg-primary text-white font-black text-sm hover:bg-blue-500 disabled:opacity-40 transition-all"
          >
            {saving ? 'Saving…' : 'Save Code'}
          </button>
        </div>
      </div>
    </div>
  );
}
