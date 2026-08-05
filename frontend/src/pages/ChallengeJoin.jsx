import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Landing page for a shared challenge link: /challenge/:gameType/:code
// Signed in  → drop straight into the game and auto-join the room.
// Signed out → remember the challenge, send to login, resume right after.
// Every gameType that can produce a challenge link must appear here, or the
// link lands on this page and silently redirects home. Rush Hour was missing:
// its lobby passes gameType="carDash" to the room modal, so a shared Rush Hour
// link was generated and then went nowhere.
const GAME_ROUTES = {
  blackjack:   '/game/blackjack',
  'coin-flip': '/game/coin-flip',
  scrabble:    '/game/word-vs',
  blockBlast:  '/game/block-blast',
  carDash:     '/game/car-dash',
};

export const PENDING_CHALLENGE_KEY = 'duely_pending_challenge';

export default function ChallengeJoin() {
  const { gameType, code } = useParams();
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    const route = GAME_ROUTES[gameType];
    if (!route || !code) { navigate('/', { replace: true }); return; }

    if (session) {
      navigate(route, { replace: true, state: { joinCode: code.toUpperCase(), autoJoin: true } });
    } else {
      try {
        sessionStorage.setItem(PENDING_CHALLENGE_KEY, JSON.stringify({ gameType, code: code.toUpperCase() }));
      } catch { /* ignore */ }
      navigate('/login', { replace: true });
    }
  }, [session, loading, gameType, code, navigate]);

  return (
    <div className="min-h-[calc(100dvh-56px)] bg-bg flex flex-col items-center justify-center px-4">
      <div className="text-center animate-fade-in">
        <div className="text-5xl mb-4">🎮</div>
        <h2 className="text-xl font-black text-white mb-2">Joining challenge…</h2>
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mt-6" />
      </div>
    </div>
  );
}
