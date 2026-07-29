import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { supabase } from '../utils/supabase';
import { PENDING_CHALLENGE_KEY } from './ChallengeJoin';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';

// If the user arrived from a shared challenge link, resume it after login.
const GAME_ROUTES = {
  blackjack:   '/game/blackjack',
  'coin-flip': '/game/coin-flip',
  scrabble:    '/game/word-vs',
  blockBlast:  '/game/block-blast',
};
function pendingChallengeTarget() {
  try {
    const raw = sessionStorage.getItem(PENDING_CHALLENGE_KEY);
    if (!raw) return null;
    const { gameType, code } = JSON.parse(raw);
    const route = GAME_ROUTES[gameType];
    if (!route || !code) return null;
    sessionStorage.removeItem(PENDING_CHALLENGE_KEY);
    return { route, state: { joinCode: code, autoJoin: true } };
  } catch { return null; }
}

export default function Login() {
  const ready = usePageReady();
  const { signIn, signOut, completeMfaLogin, refreshProfile, mfaPending, mfaFactorId } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Shown when auth works but no profile row exists yet
  const [needsUsername, setNeedsUsername] = useState(false);
  const [username, setUsername] = useState('');
  const [creating, setCreating] = useState(false);

  // MFA step — also auto-populate from AuthContext when user has pending MFA session
  const [mfaState, setMfaState] = useState(null); // { factorId }

  useEffect(() => {
    if (mfaPending && mfaFactorId && !mfaState) {
      setMfaState({ factorId: mfaFactorId });
    }
  }, [mfaPending, mfaFactorId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mfaCode, setMfaCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // Forgot-password flow
  const [forgotMode, setForgotMode]     = useState(false);
  const [resetSent, setResetSent]       = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  async function handleForgot(e) {
    e.preventDefault();
    if (!email.trim()) return setError('Enter your email address first.');
    setResetLoading(true);
    setError(null);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (resetErr) throw resetErr;
      setResetSent(true);
    } catch (err) {
      setError(err.message || 'Failed to send reset email. Try again.');
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await signIn(email, password);
      if (result?.mfaRequired) {
        setMfaState({ factorId: result.factorId });
      } else if (!result) {
        // `signIn` returns null when ensureProfile fails. For sign-in (not sign-up)
        // this is almost always a transient backend error — the session IS valid.
        // Only show the username form if there's a pending sign-up username to claim;
        // otherwise navigate home so the user isn't stuck on this page.
        if (sessionStorage.getItem('rd_pending_username')) {
          setNeedsUsername(true);
        } else {
          { const t = pendingChallengeTarget(); if (t) navigate(t.route, { state: t.state }); else navigate('/'); }
        }
      } else {
        { const t = pendingChallengeTarget(); if (t) navigate(t.route, { state: t.state }); else navigate('/'); }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e) {
    e.preventDefault();
    if (mfaCode.length !== 6) return;
    setMfaLoading(true);
    setError(null);
    try {
      await completeMfaLogin(mfaState.factorId, mfaCode);
      // MFA passed — navigate regardless of profile fetch result
      { const t = pendingChallengeTarget(); if (t) navigate(t.route, { state: t.state }); else navigate('/'); }
    } catch (err) {
      console.error('[MFA verify error]', err);
      const msg = String(err?.message || err?.error_description || err || '').toLowerCase();
      if (msg.includes('timeout')) {
        setError('Verification timed out — please try again.');
      } else if (msg.includes('expired')) {
        setError('Code expired — wait for the next code in your authenticator app.');
      } else {
        setError('Wrong code — double-check your authenticator app and try again.');
      }
      setMfaCode('');
    } finally {
      setMfaLoading(false);
    }
  }

  function handleBackToLogin() {
    // Fire signOut without awaiting so it never blocks the UI
    signOut().catch(() => {});
    setMfaState(null);
    setMfaCode('');
    setError(null);
  }

  async function handleCreateProfile(e) {
    e.preventDefault();
    if (username.trim().length < 3) return setError('Username must be at least 3 characters.');
    setCreating(true);
    setError(null);
    try {
      await api.post('/auth/profile', { username: username.trim() });
      await refreshProfile();
      { const t = pendingChallengeTarget(); if (t) navigate(t.route, { state: t.state }); else navigate('/'); }
    } catch (err) {
      setError(err.message || 'Failed to create profile. Try a different username.');
    } finally {
      setCreating(false);
    }
  }

  if (needsUsername) {
    return (
      <div className="min-h-full bg-bg flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-8">
            <Link to="/" className="text-3xl font-black">
              <span className="text-white">Duely</span>
            </Link>
            <p className="text-muted mt-2">One last step — pick a username</p>
          </div>

          <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
            <p className="text-sm text-muted mb-4 text-center">
              Your account was found but needs a username to finish setup.
            </p>
            <form onSubmit={handleCreateProfile} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm text-muted mb-1">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  required
                  minLength={3}
                  maxLength={20}
                  autoFocus
                  className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  placeholder="CoolPlayer99"
                />
              </div>

              {error && (
                <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3">
                  <p className="text-danger text-sm">{error}</p>
                </div>
              )}

              <GlowButton type="submit" disabled={creating} variant="primary" size="lg" className="w-full">
                {creating ? 'Setting up...' : 'Continue →'}
              </GlowButton>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (mfaState) {
    return (
      <div className="min-h-full bg-bg flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-8">
            <Link to="/" className="text-3xl font-black">
              <span className="text-white">Duely</span>
            </Link>
            <p className="text-muted mt-2">Two-factor authentication</p>
          </div>
          <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
            <div className="text-center mb-5">
              <div className="text-4xl mb-2">🔐</div>
              <p className="text-sm text-white font-semibold">Enter your authenticator code</p>
              <p className="text-xs text-muted mt-1">Open Google Authenticator or Authy and enter the 6-digit code</p>
            </div>
            <form onSubmit={handleMfaSubmit} className="flex flex-col gap-4">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={mfaCode}
                onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
                placeholder="000000"
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-white text-center text-2xl font-mono tracking-[0.5em] placeholder-muted focus:outline-none focus:border-primary transition-colors"
              />
              {error && <p className="text-danger text-sm text-center">{error}</p>}
              <GlowButton type="submit" disabled={mfaLoading || mfaCode.length !== 6} variant="primary" size="lg" className="w-full">
                {mfaLoading ? 'Verifying...' : 'Verify →'}
              </GlowButton>
              <button type="button" onClick={handleBackToLogin} className="text-xs text-muted hover:text-white text-center" style={{ pointerEvents: 'auto' }}>
                ← Back to login
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-bg flex items-center justify-center px-4 py-8" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-8">
          <Link to="/" className="text-3xl font-black">
            <span className="text-white">Duely</span>
          </Link>
          <p className="text-muted mt-2">Sign in to your account</p>
        </div>

        <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
          {forgotMode ? (
            resetSent ? (
              <div className="text-center py-4">
                <div className="text-4xl mb-3">📧</div>
                <p className="text-white font-semibold">Check your email</p>
                <p className="text-muted text-sm mt-1">We sent a password reset link to <span className="text-white">{email}</span>. Open it to set a new password.</p>
                <button type="button" onClick={() => { setForgotMode(false); setResetSent(false); setError(null); }} className="mt-5 text-primary text-sm hover:underline">
                  Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgot} className="flex flex-col gap-4">
                <p className="text-sm text-muted">Enter your email and we'll send you a link to reset your password.</p>
                <div>
                  <label className="block text-sm text-muted mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                    placeholder="you@example.com"
                  />
                </div>
                {error && <p className="text-danger text-sm">{error}</p>}
                <GlowButton type="submit" disabled={resetLoading} variant="primary" size="lg" className="w-full">
                  {resetLoading ? 'Sending…' : 'Send Reset Link'}
                </GlowButton>
                <button type="button" onClick={() => { setForgotMode(false); setError(null); }} className="text-xs text-muted hover:text-white text-center">
                  Back to sign in
                </button>
              </form>
            )
          ) : (
          <>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm text-muted mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-sm text-muted mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && <p className="text-danger text-sm">{error}</p>}

            <GlowButton type="submit" disabled={loading} variant="primary" size="lg" className="w-full">
              {loading ? 'Signing in...' : 'Sign In'}
            </GlowButton>
          </form>

          <button
            type="button"
            onClick={() => { setForgotMode(true); setError(null); }}
            className="block w-full text-center text-xs text-primary hover:underline mt-3"
          >
            Forgot password?
          </button>

          <div className="mt-4 pt-4 border-t border-surfaceLight">
            <p className="text-center text-sm text-muted mb-3">Don't have an account?</p>
            <Link
              to="/signup"
              className="block w-full text-center py-3 rounded-xl border-2 border-primary text-primary font-black hover:bg-primary hover:text-white transition-all text-base"
            >
              Create Account
            </Link>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

