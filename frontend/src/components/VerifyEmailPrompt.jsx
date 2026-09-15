import { useEffect, useState } from 'react';
import GlowButton from './GlowButton';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../utils/supabase';
import { verificationStage } from '../utils/emailVerification';

/**
 * The verify-your-email popups.
 *
 * Soft (from day 3): once, ever, the next time they open the site.
 * Hard (the last 7 days before deletion): on every visit, with a live
 * countdown. Closing it hides it until the site is opened again.
 *
 * The timeline and the deletion itself are in utils/emailVerification and
 * backend/src/services/unverifiedAccounts.
 */
function fmtLeft(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${d}d ${p(h)}h ${p(m)}m ${p(sec)}s`;
}

export default function VerifyEmailPrompt() {
  const { session, profile } = useAuth();
  const user = session?.user;
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const { stage, deadline } = verificationStage(user, now);
  const uid = user?.id;

  // Decide once per load whether to show it.
  useEffect(() => {
    if (!uid || profile?.is_demo) return;
    const { stage: s } = verificationStage(user);
    try {
      if (s === 'hard') {
        if (sessionStorage.getItem(`verifyHardSeen:${uid}`)) return;
        setOpen(true);
      } else if (s === 'soft') {
        if (localStorage.getItem(`verifySoftSeen:${uid}`)) return;
        localStorage.setItem(`verifySoftSeen:${uid}`, '1');
        setOpen(true);
      }
    } catch {
      if (s !== 'none') setOpen(true);
    }
  }, [uid, profile?.is_demo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || stage !== 'hard') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, stage]);

  if (!open || !user || stage === 'none') return null;

  function close() {
    if (stage === 'hard') { try { sessionStorage.setItem(`verifyHardSeen:${uid}`, '1'); } catch { /* private mode */ } }
    setOpen(false);
  }

  async function send() {
    if (!user.email) return;
    setSending(true); setError(null);
    const { error: err } = await supabase.auth.resend({ type: 'signup', email: user.email });
    setSending(false);
    if (err) { setError(err.message || 'Could not send the email. Try again.'); return; }
    setSent(true);
  }

  const hard = stage === 'hard';
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4" onClick={close}>
      <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-7 shadow-2xl text-center animate-scale-in"
           onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="verify-title">
        <h2 id="verify-title" className="text-2xl font-black text-white mb-2">Verify your email</h2>

        {hard ? (
          <>
            <p className="text-sm text-danger font-bold mb-1">Your account will be deleted if your email is not verified.</p>
            <div className="my-3 font-mono font-black text-3xl text-white tabular-nums">{fmtLeft(deadline - now)}</div>
          </>
        ) : (
          <p className="text-muted text-sm mb-2">Please verify your email to keep your account secure.</p>
        )}

        {!sent ? (
          <>
            <p className="text-muted text-xs mb-5">
              We&apos;ll send a verification email to <span className="text-white font-bold break-all">{user.email}</span>.
            </p>
            <GlowButton onClick={send} variant="primary" size="lg" className="w-full" disabled={sending}>
              {sending ? 'Sending…' : 'Send verification email'}
            </GlowButton>
            {error && <p className="text-danger text-sm mt-3">{error}</p>}
          </>
        ) : (
          <p className="text-muted text-sm mb-2">
            Sent. Open the email and follow it to verify, then come back.
          </p>
        )}

        <button onClick={close} className="text-xs text-muted hover:text-white mt-4 transition-colors">
          {hard ? 'Remind me next time' : 'Close'}
        </button>
      </div>
    </div>
  );
}
