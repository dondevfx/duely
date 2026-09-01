import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import GlowButton from '../components/GlowButton';
import { usePageReady } from '../hooks/usePageReady';
import { savePendingInvite } from '../utils/pendingInvite';
import InAppBrowserNotice from '../components/InAppBrowserNotice';

// Landing page for /add-friend/:username — the friend invite link.
//
// A logged-out visitor is the common case: this link gets shared to people who
// do not have an account yet. So the page shows who invited them first, sends
// them to sign up, and finishes the add when they come back — rather than
// bouncing them to a login screen with no explanation.
export default function AddFriend() {
  const ready = usePageReady();
  const { username } = useParams();
  const { session } = useAuth();
  const navigate = useNavigate();

  const [inviter, setInviter] = useState(null);
  const [status, setStatus] = useState('loading');   // loading | ready | adding | done | already | error
  const [error, setError] = useState('');
  const claimed = useRef(false);

  // Who is behind this link? Public, so it renders before sign-in.
  useEffect(() => {
    let cancelled = false;
    api.get(`/auth/friend-invite/${encodeURIComponent(username)}`)
      .then((p) => { if (!cancelled) { setInviter(p); setStatus('ready'); } })
      .catch(() => { if (!cancelled) { setStatus('error'); setError('That invite link is no longer valid.'); } });
    return () => { cancelled = true; };
  }, [username]);

  // Claim as soon as we have both a session and a valid link. The ref guards
  // against StrictMode's double-invoke and against the effect re-running when
  // the session object is replaced on token refresh — either would fire a
  // second add.
  useEffect(() => {
    if (!session || status !== 'ready' || claimed.current) return;
    claimed.current = true;
    setStatus('adding');
    api.post(`/auth/friend-invite/${encodeURIComponent(username)}`)
      .then((r) => setStatus(r.alreadyFriends ? 'already' : 'done'))
      .catch((err) => { setStatus('error'); setError(err.message); });
  }, [session, status, username]);

  const name = inviter?.username || username;

  return (
    <div
      className="min-h-[calc(100vh-3.5rem)] bg-bg flex flex-col items-center justify-center px-4"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-6 text-center animate-slide-up">

        <InAppBrowserNotice />

        {status === 'loading' && <p className="text-muted py-8">Loading invite…</p>}

        {status === 'error' && (
          <>
            <div className="text-4xl mb-3">🔗</div>
            <h1 className="text-2xl font-black text-white mb-2">Invite not valid</h1>
            <p className="text-muted text-sm mb-6">{error}</p>
            <GlowButton onClick={() => navigate('/')} variant="primary" size="lg" className="w-full">
              Go Home
            </GlowButton>
          </>
        )}

        {(status === 'ready' || status === 'adding') && (
          <>
            <div
              className="w-20 h-20 rounded-full mx-auto mb-4 flex items-center justify-center text-3xl font-black text-white"
              style={{ background: inviter?.profile_color || '#1250B4' }}
            >
              {name?.[0]?.toUpperCase() || '?'}
            </div>
            <h1 className="text-2xl font-black text-white mb-1">{name}</h1>
            <p className="text-muted text-sm mb-6">wants to be your friend on Duely</p>

            {session ? (
              <p className="text-primary font-bold animate-pulse py-3">Adding…</p>
            ) : (
              <>
                <GlowButton
                  onClick={() => { savePendingInvite(username); navigate('/login'); }}
                  variant="primary" size="lg" className="w-full mb-3"
                >
                  Sign in to add
                </GlowButton>
                <GlowButton
                  onClick={() => { savePendingInvite(username); navigate('/signup'); }}
                  variant="ghost" className="w-full border border-border mb-3"
                >
                  Create an account
                </GlowButton>
                <p className="text-muted text-xs">
                  No account? Signing up takes a few seconds — you'll be added automatically.
                </p>
              </>
            )}
          </>
        )}

        {(status === 'done' || status === 'already') && (
          <>
            <div className="text-5xl mb-3">{status === 'done' ? '🎉' : '👋'}</div>
            <h1 className="text-2xl font-black text-white mb-2">
              {status === 'done' ? `You and ${name} are now friends!` : `You're already friends with ${name}`}
            </h1>
            <p className="text-muted text-sm mb-6">Challenge them to a 1v1 from your friends list.</p>
            <GlowButton onClick={() => navigate('/profile')} variant="primary" size="lg" className="w-full mb-3">
              View Friends
            </GlowButton>
            <GlowButton onClick={() => navigate('/games')} variant="ghost" className="w-full border border-border">
              Browse Games
            </GlowButton>
          </>
        )}
      </div>
    </div>
  );
}
