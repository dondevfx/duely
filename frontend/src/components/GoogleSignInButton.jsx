import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

/**
 * Google's mark, drawn.
 *
 * Four paths in Google's own brand colours, which their branding rules require
 * — this is the one icon on the site that cannot be restyled to match
 * everything else. It is also why the button is white rather than the surface
 * colour: a coloured mark on a dark button is the arrangement Google asks you
 * not to ship.
 */
function GoogleMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

/**
 * "Continue with Google", on both the sign-in and sign-up pages.
 *
 * One component rather than a copy on each, because the two are the same
 * action: Google does not distinguish signing up from signing in, and neither
 * does this. A first-time account gets a profile made for it on the way back
 * through /auth/callback.
 *
 * The label says "Continue" for that reason — "Sign up with Google" on one page
 * and "Sign in with Google" on the other would be describing a difference that
 * does not exist, and would read as wrong to anyone who used the other page
 * first.
 */
export default function GoogleSignInButton({ className = '' }) {
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
      // Nothing after this normally runs — the page is on its way to Google.
    } catch (e) {
      setError(e?.message || 'Could not reach Google. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="w-full flex items-center justify-center gap-3 py-3 rounded-xl
                   bg-white text-[#1f1f1f] font-bold text-base
                   hover:bg-[#f2f2f2] active:bg-[#e8e8e8]
                   disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        <GoogleMark />
        {busy ? 'Opening Google…' : 'Continue with Google'}
      </button>
      {error && <p className="text-danger text-xs mt-2 text-center">{error}</p>}
    </div>
  );
}
