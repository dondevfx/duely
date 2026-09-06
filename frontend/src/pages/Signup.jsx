import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import GoogleSignInButton from '../components/GoogleSignInButton';
import { useAuth } from '../context/AuthContext';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';
import { takePendingInvite } from '../utils/pendingInvite';
import { AUTOFOCUS } from '../utils/device';

export default function Signup() {
  const ready = usePageReady();
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (username.trim().length < 3) return setError('Username must be at least 3 characters.');
    setLoading(true);
    setError(null);
    try {
      const data = await signUp(email, password, username.trim());

      if (data.session) {
        // Email confirmation is OFF — logged in immediately. If they got here
        // from a friend invite link, finish that instead of dumping them home.
        // A full load, not a route change — see enterApp in Login.jsx. A brand
        // new account is the case where the least is already in memory.
        const invite = takePendingInvite();
        window.location.assign(invite ? invite.route : '/');
      } else {
        // Email confirmation is ON — tell user to check inbox
        setAwaitingConfirmation(true);
      }
    } catch (err) {
      setError(err.message || 'Sign up failed. Try again.');
    } finally {
      setLoading(false);
    }
  }

  if (awaitingConfirmation) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center animate-slide-up">
          <div className="text-5xl mb-4">📬</div>
          <h2 className="text-2xl font-black text-white mb-2">Check your email</h2>
          <p className="text-muted mb-4">
            We sent a confirmation link to <span className="text-white font-medium">{email}</span>.
            Click it to activate your account, then come back and sign in.
          </p>
          <p className="text-xs text-muted mb-6">
            Tip: to skip this step in development, go to your Supabase dashboard →{' '}
            Authentication → Settings → disable "Enable email confirmations".
          </p>
          <Link
            to="/login"
            className="inline-block px-6 py-3 bg-primary text-white font-bold rounded-xl shadow-glow hover:bg-blue-500 transition-all"
          >
            Go to Sign In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-8">
          <Link to="/" className="text-3xl font-black">
            <span className="text-white">Duely</span>
          </Link>
          <p className="text-muted mt-2">Create your account — it's free</p>
        </div>

        <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm text-muted mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                minLength={3}
                maxLength={20}
                // autoComplete="off" is what iOS IGNORES. Left off, Safari
                // falls back to guessing from the label and offers the contact
                // card — so tapping "Username" suggested the person's Apple
                // email. "username" names the field explicitly, and iOS then
                // offers account names instead of contact details.
                name="username"
                id="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={AUTOFOCUS}
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                placeholder="CoolPlayer99"
              />
            </div>
            <div>
              <label className="block text-sm text-muted mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
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
                minLength={6}
                autoComplete="new-password"
                className="w-full bg-bg border border-surfaceLight rounded-lg px-4 py-3 text-base text-white placeholder-muted focus:outline-none focus:border-primary transition-colors"
                placeholder="At least 6 characters"
              />
            </div>

            {error && (
              <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3">
                <p className="text-danger text-sm">{error}</p>
              </div>
            )}

            <GlowButton type="submit" disabled={loading} variant="primary" size="lg" className="w-full">
              {loading ? 'Creating account...' : 'Create Account'}
            </GlowButton>
          </form>

          {/* Under Create Account, as asked. Outside the <form> deliberately —
              inside it, a button without type="button" submits, and this one
              navigates away instead. It carries its own type, but keeping it
              out of the form means the Enter key still belongs to the email
              and password fields. */}
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-surfaceLight" />
            <span className="text-xs text-muted">or</span>
            <div className="flex-1 h-px bg-surfaceLight" />
          </div>
          <GoogleSignInButton />

          <p className="text-center text-sm text-muted mt-4">
            Have an account?{' '}
            <Link to="/login" className="text-primary hover:text-accent transition-colors font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

