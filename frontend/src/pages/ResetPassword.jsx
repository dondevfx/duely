import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import GlowButton from '../components/GlowButton';
import { AUTOFOCUS } from '../utils/device';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword]     = useState('');
  const [confirm, setConfirm]       = useState('');
  const [error, setError]           = useState(null);
  const [loading, setLoading]       = useState(false);
  const [success, setSuccess]       = useState(false);
  const [ready, setReady]           = useState(false); // session established from token

  useEffect(() => {
    // Supabase puts the recovery tokens in the URL hash:
    // #access_token=xxx&refresh_token=yyy&type=recovery
    // detectSessionInUrl is false so we parse it manually.
    const hash = window.location.hash.slice(1); // strip '#'
    const params = new URLSearchParams(hash);
    const type         = params.get('type');
    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (type === 'recovery' && accessToken) {
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken || '' })
        .then(({ error }) => {
          if (error) {
            setError('Invalid or expired reset link. Please request a new one.');
          } else {
            setReady(true);
            // Clean the hash so tokens don't linger in history
            window.history.replaceState(null, '', window.location.pathname);
          }
        });
    } else {
      setError('Invalid reset link. Please request a new password reset.');
    }
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match.');
    if (password.length < 6)  return setError('Password must be at least 6 characters.');
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setSuccess(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.message || 'Failed to update password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full bg-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-8">
          <Link to="/" className="text-3xl font-black">
            <span className="text-white">Duely</span>
          </Link>
          <p className="text-muted mt-2">Set a new password</p>
        </div>

        <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
          {success ? (
            <div className="text-center py-4">
              <div className="text-4xl mb-3">✅</div>
              <p className="text-white font-semibold">Password updated!</p>
              <p className="text-muted text-sm mt-1">Redirecting you to login…</p>
            </div>
          ) : !ready ? (
            <div className="text-center py-4">
              {error ? (
                <>
                  <div className="text-4xl mb-3">❌</div>
                  <p className="text-danger text-sm">{error}</p>
                  <Link to="/login" className="block mt-4 text-primary text-sm hover:underline">
                    Back to login
                  </Link>
                </>
              ) : (
                <div className="flex items-center justify-center gap-2 text-muted text-sm">
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  Verifying link…
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm text-muted mb-1">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={6}
                  autoFocus={AUTOFOCUS}
                  className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  placeholder="••••••••"
                />
              </div>
              <div>
                <label className="block text-sm text-muted mb-1">Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  minLength={6}
                  className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                  placeholder="••••••••"
                />
              </div>

              {error && <p className="text-danger text-sm">{error}</p>}

              <GlowButton type="submit" disabled={loading} variant="primary" size="lg" className="w-full">
                {loading ? 'Updating…' : 'Set New Password'}
              </GlowButton>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
