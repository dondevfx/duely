import { useState } from 'react';
import GlowButton from './GlowButton';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../utils/supabase';

/**
 * Withdrawal needs a verified email, and this is where the player finds that
 * out — so it also has to be where they can do something about it.
 *
 * The guard already existed and already refused. What it returned was a
 * sentence: "Please verify your email before withdrawing." That is a dead end
 * on the screen where someone is trying to take their money out, because the
 * one thing they need next — the link — is not here, and there is no reason
 * they should know it lives on the profile page. Same shape as the KYC prompt
 * beside it: refuse, then open the fix.
 */
export default function VerifyEmailModal({ onClose }) {
  const { session } = useAuth();
  const email = session?.user?.email;

  const [sending, setSending] = useState(false);
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState(null);

  async function send() {
    if (!email) return;
    setSending(true);
    setError(null);
    const { error: err } = await supabase.auth.resend({ type: 'signup', email });
    if (err) {
      setError(err.message || 'Could not send the email. Please try again.');
      setSending(false);
      return;
    }
    setSent(true);
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
      onClick={onClose}>
      <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-7 shadow-2xl text-center animate-scale-in"
        onClick={e => e.stopPropagation()}>
        <div className="flex justify-center mb-4">
          {/* An envelope with a seal on it — the withheld thing, not a warning
              triangle. This is a step to complete, not an error to feel bad
              about. */}
          <svg width="64" height="64" viewBox="0 0 24 24" role="img" aria-label="verify email" focusable="false">
            <rect x="2.5" y="5" width="19" height="14" rx="2.4" fill="#132743" stroke="#1250B4" strokeWidth="1.4" />
            <path d="M3.4 6.6 12 12.8l8.6-6.2" fill="none" stroke="#4A90FF" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="17.6" cy="16.4" r="4.6" fill="#F5C518" stroke="#0D0D0D" strokeWidth="1.2" />
            <path d="M15.6 16.5l1.5 1.5 2.9-3" fill="none" stroke="#7A5A05" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h2 className="text-2xl font-black text-white mb-2">Verify Your Email</h2>

        {!sent ? (
          <>
            <p className="text-muted text-sm mb-6">
              You need a verified email before you can withdraw.
              {email && <> We&apos;ll send a link to <span className="text-white font-bold break-all">{email}</span>.</>}
            </p>
            <GlowButton onClick={send} variant="primary" size="lg" className="w-full" disabled={sending || !email}>
              {sending ? 'Sending…' : 'Send Verification Email'}
            </GlowButton>
            {error && <p className="text-danger text-sm mt-3">{error}</p>}
          </>
        ) : (
          <>
            <p className="text-muted text-sm mb-6">
              Link sent{email ? <> to <span className="text-white font-bold break-all">{email}</span></> : ''}.
              Open it, then come back and try your withdrawal again.
            </p>
            {/* Deliberately no auto-close and no polling. Verifying happens in
                another tab or on another device, and the session here does not
                learn about it until it refreshes — a modal that closed itself
                would imply this page knows something it does not. */}
            <GlowButton onClick={onClose} variant="primary" size="lg" className="w-full">Done</GlowButton>
          </>
        )}

        <button onClick={onClose} className="text-xs text-muted hover:text-white mt-4 transition-colors">
          Close
        </button>
      </div>
    </div>
  );
}
