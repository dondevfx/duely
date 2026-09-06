import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Where Google sends the browser back to.
 *
 * The tokens arrive in the URL fragment — see the flowType note in
 * utils/supabase.js for why implicit rather than PKCE. This page exists to
 * take them out of the address bar and turn them into a session, and does
 * nothing else; it is never linked to and never seen for more than a moment.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const { completeOAuthLogin } = useAuth();
  const [error, setError] = useState(null);
  // Effects run twice in React's development StrictMode, and adopting the same
  // one-time tokens twice is not something to find out about in production.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.hash.slice(1));

    // Clear the fragment FIRST, whatever happens next. An access token in the
    // address bar is a token in the browser's history, in the tab title, and
    // in anything the user pastes when asking for help.
    window.history.replaceState(null, '', '/auth/callback');

    const err = params.get('error_description') || params.get('error');
    if (err) {
      // The usual one is the person closing Google's window, which is not an
      // error worth a screen — send them back to sign in.
      setError(decodeURIComponent(err).replace(/\+/g, ' '));
      return;
    }

    const access_token  = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) {
      // Reached directly, or the fragment was stripped in transit.
      navigate('/login', { replace: true });
      return;
    }

    completeOAuthLogin({ access_token, refresh_token })
      .then(() => navigate('/', { replace: true }))
      .catch((e) => setError(e?.message || 'Google sign-in failed. Please try again.'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="min-h-[calc(100dvh-3.5rem)] bg-bg flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-7 text-center">
          <h2 className="text-xl font-black text-white mb-2">Sign-in didn&apos;t finish</h2>
          <p className="text-sm text-muted mb-6">{error}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="w-full py-3 rounded-xl bg-primary hover:bg-blue-500 text-white font-bold transition-all"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-bg flex items-center justify-center px-4">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-muted text-sm">Signing you in…</p>
      </div>
    </div>
  );
}
