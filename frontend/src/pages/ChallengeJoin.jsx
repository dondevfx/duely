import { useEffect, useState } from 'react';
import DiamondIcon from '../components/DiamondIcon';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import GlowButton from '../components/GlowButton';
import CoinIcon from '../components/CoinIcon';
import GameIcon from '../components/GameIcon';
import InAppBrowserNotice from '../components/InAppBrowserNotice';

// Landing page for a shared challenge link: /challenge/:gameType/:code
//
// This used to auto-join the moment it loaded. That meant opening a link was
// itself the act of entering a paid match — the entry fee came out before you
// had seen who sent it or what it cost. Now it always stops on an accept or
// decline screen showing the host and the stake, and only Accept joins.
//
// Every gameType that can produce a challenge link must appear here, or the
// link lands on this page and silently redirects home.
const GAME_ROUTES = {
  blackjack:   '/game/blackjack',
  'coin-flip': '/game/coin-flip',
  scrabble:    '/game/word-vs',
  blockBlast:  '/game/block-blast',
  carDash:     '/game/car-dash',
  colorRush:   '/game/color-rush',
  tower:       '/game/tower',
};

const GAME_NAMES = {
  blackjack:   'Blackjack',
  'coin-flip': 'Coin Flip',
  scrabble:    'Word VS',
  blockBlast:  'Block Burst',
  carDash:     'Rush Hour',
  colorRush:   'Color Rush',
  tower:       'Tower',
};

export const PENDING_CHALLENGE_KEY = 'duely_pending_challenge';

export default function ChallengeJoin() {
  const { gameType, code } = useParams();
  const { session, loading } = useAuth();
  const { socket, authenticated } = useSocket();
  const navigate = useNavigate();

  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  const route = GAME_ROUTES[gameType];
  const gameName = GAME_NAMES[gameType] || 'a match';
  const upperCode = (code || '').toUpperCase();

  useEffect(() => {
    if (!route || !code) navigate('/', { replace: true });
  }, [route, code, navigate]);

  // Ask the server who is behind this code and what it costs. Read-only — this
  // does not join, so backing out here costs nothing.
  useEffect(() => {
    if (!socket || !authenticated || !route) return;
    const onInfo = (data) => { if (data.code === upperCode) setInfo(data); };
    const onErr  = ({ message }) => setError(message || 'That challenge is no longer available.');
    socket.on('private_room_info', onInfo);
    socket.on('error', onErr);
    socket.emit('peek_private_room', { code: upperCode });
    return () => { socket.off('private_room_info', onInfo); socket.off('error', onErr); };
  }, [socket, authenticated, upperCode, route]);

  function accept() {
    navigate(route, { replace: true, state: { joinCode: upperCode, autoJoin: true } });
  }

  function decline() {
    navigate('/', { replace: true });
  }

  function signIn(to) {
    try {
      sessionStorage.setItem(PENDING_CHALLENGE_KEY, JSON.stringify({ gameType, code: upperCode }));
    } catch { /* private mode — they can still paste the code into Join Room */ }
    navigate(to);
  }

  const isFree = !info || (info.entryFee ?? 0) === 0;
  const stake = info && !isFree && (
    info.currency === 'diamonds'
      ? <span className="inline-flex items-center gap-1">{info.entryFee.toLocaleString()} <DiamondIcon /></span>
      : <span className="inline-flex items-center gap-1">{info.entryFee.toLocaleString()} <CoinIcon size="0.9em" /></span>
  );

  return (
    <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm bg-surface border border-border rounded-2xl p-6 text-center animate-slide-up">

        <InAppBrowserNotice />

        {error ? (
          <>
            <div className="text-4xl mb-3">🔗</div>
            <h1 className="text-2xl font-black text-white mb-2">Challenge unavailable</h1>
            <p className="text-muted text-sm mb-6">{error}</p>
            <GlowButton onClick={() => navigate('/games')} variant="primary" size="lg" className="w-full">
              Browse Games
            </GlowButton>
          </>
        ) : !session && !loading ? (
          <>
            <div className="text-5xl mb-3">🎮</div>
            <h1 className="text-2xl font-black text-white mb-1">You've been challenged</h1>
            <p className="text-muted text-sm mb-6">to {gameName} on Duely</p>
            <GlowButton onClick={() => signIn('/login')} variant="primary" size="lg" className="w-full mb-3">
              Sign in to accept
            </GlowButton>
            <GlowButton onClick={() => signIn('/signup')} variant="ghost" className="w-full border border-border mb-3">
              Create an account
            </GlowButton>
            <p className="text-muted text-xs">You'll see the stake before anything is accepted.</p>
          </>
        ) : !info ? (
          <>
            <div className="text-5xl mb-4">🎮</div>
            <h2 className="text-xl font-black text-white mb-2">Loading challenge…</h2>
            <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mt-6" />
          </>
        ) : info.isHost ? (
          <>
            <div className="text-4xl mb-3">👋</div>
            <h1 className="text-2xl font-black text-white mb-2">This is your own challenge</h1>
            <p className="text-muted text-sm mb-6">Send the link to someone else — you can't play yourself.</p>
            <GlowButton onClick={() => navigate(route, { replace: true })} variant="primary" size="lg" className="w-full">
              Back to {gameName}
            </GlowButton>
          </>
        ) : (
          <>
            <div className="text-5xl mb-3">🎮</div>
            <p className="text-muted text-sm mb-1">{info.hostUsername} challenged you to</p>
            <h1 className="text-2xl font-black text-white mb-4 flex items-center justify-center gap-2">
              <GameIcon game={gameType} size={26} />{gameName}
            </h1>

            <div className="bg-bg border border-border rounded-xl p-4 mb-5 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Opponent</span>
                <span className="text-white font-bold">
                  {info.hostUsername}{info.hostElo != null && <span className="text-muted font-normal"> · {info.hostElo} ELO</span>}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Entry fee</span>
                <span className="text-white font-black">{isFree ? 'Free' : stake}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={decline}
                className="flex-1 py-3 rounded-xl font-black text-base bg-surface border border-surfaceLight text-white hover:border-danger hover:text-danger transition-all"
              >
                Decline
              </button>
              <button
                onClick={accept}
                className="flex-1 py-3 rounded-xl font-black text-base bg-primary text-white hover:bg-blue-500 transition-all"
                style={{ boxShadow: '0 0 18px rgba(18,80,180,0.35)' }}
              >
                Accept
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
