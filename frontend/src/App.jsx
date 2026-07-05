(function applyStoredLanguage() {
  try {
    const GOOGLE_LANG = { de:'de', zh:'zh-CN', ru:'ru', es:'es', it:'it', ja:'ja', fi:'fi' };
    const stored = localStorage.getItem('language');
    if (!stored) {
      localStorage.setItem('language', 'en');
      document.cookie = 'googtrans=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie = `googtrans=; path=/; domain=${window.location.hostname}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    } else {
      const googleCode = GOOGLE_LANG[stored];
      if (googleCode) {
        document.cookie = `googtrans=/en/${googleCode}; path=/`;
        document.cookie = `googtrans=/en/${googleCode}; path=/; domain=${window.location.hostname}`;
      } else {
        document.cookie = 'googtrans=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        document.cookie = `googtrans=; path=/; domain=${window.location.hostname}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      }
    }
  } catch {}
})();
import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider, useSocket } from './context/SocketContext';
import { WalletProvider } from './context/WalletContext';
import { CurrencyProvider } from './context/CurrencyContext';
import Navbar from './components/Navbar';
import LeftSidebar from './components/LeftSidebar';
import ChatSidebar from './components/ChatSidebar';
import Home from './pages/Home';
import Leaderboard from './pages/Leaderboard';
import Profile from './pages/Profile';
import Wallet from './pages/Wallet';
import Tip from './pages/Tip';
import BlockBlastGame from './pages/BlockBlastGame';
import QuickMatch from './pages/QuickMatch';
import WordleGame from './pages/WordleGame';
import CoinFlipGame from './pages/CoinFlipGame';
import BlackjackGame from './pages/BlackjackGame';
import Transactions from './pages/Transactions';
import Rewards from './pages/Rewards';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ResetPassword from './pages/ResetPassword';
import ToS from './pages/ToS';
import Admin from './pages/Admin';
import SpectateView from './pages/SpectateView';
import ForfeitToast from './components/ForfeitToast';
import NotifyToast from './components/NotifyToast';
import ReconnectOverlay from './components/ReconnectOverlay';
import AgeToSModal, { useTosAccepted } from './components/AgeToSModal';
import SaveLoginPrompt from './components/SaveLoginPrompt';

function ProtectedRoute({ children }) {
  const { session, loading, mfaPending } = useAuth();
  // If loading and no session yet, we may be resolving a saved-login token — wait.
  // If session is already set (seeded from storage), render immediately without spinner.
  if (loading && !session) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (mfaPending) return <Navigate to="/login" replace />;
  return session ? children : <Navigate to="/login" replace />;
}

function getInitialChatOpen() {
  try { return localStorage.getItem('worldChatOpen') !== 'false'; } catch { return true; }
}

function Shell() {
  const { session, showSaveLogin, setShowSaveLogin, mfaPending, loading } = useAuth();
  const [tosAccepted, setTosAccepted] = useState(useTosAccepted());
  const [chatOpen, setChatOpen] = useState(getInitialChatOpen);
  const navigate = useNavigate();

  // When MFA is pending and there's no session (saved-login MFA flow),
  // redirect to /login so the MFA form is shown
  useEffect(() => {
    if (!loading && mfaPending && !session) {
      navigate('/login', { replace: true });
    }
  }, [mfaPending, session, loading, navigate]);

  // Intercept Supabase password-recovery links on any page and send them
  // to /reset-password where the token is consumed. detectSessionInUrl is
  // disabled on the supabase client so we must handle this ourselves.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.get('type') === 'recovery' && params.get('access_token')) {
      navigate('/reset-password' + window.location.hash, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  function handleChatToggle(next) {
    setChatOpen(next);
    try { localStorage.setItem('worldChatOpen', String(next)); } catch {}
  }

  const tosPending = session && !tosAccepted;
  // Block nav whenever MFA is pending (session may be null during saved-login MFA)
  const navBlocked = tosPending || mfaPending;

  return (
    <div className="min-h-screen bg-bg">
      {/* Navbar + sidebars blocked when ToS/MFA pending */}
      <div className={navBlocked ? 'pointer-events-none select-none' : ''}>
        <Navbar />
        <div className="flex pt-14">
          <LeftSidebar />
          <ChatSidebar open={chatOpen} onToggle={handleChatToggle} />
        </div>
      </div>
      {/* Main content always interactive */}
      <main className={`absolute top-14 bottom-0 left-0 right-0 overflow-y-auto transition-[left,right] duration-300 lg:left-56 ${chatOpen ? 'lg:right-80' : 'lg:right-0'}`}>
        <div className="tv-scale">
        <Routes>
          <Route path="/"                  element={<Home />} />
          <Route path="/leaderboard"        element={<Leaderboard />} />
          <Route path="/login"              element={<Login />} />
          <Route path="/signup"             element={<Signup />} />
          <Route path="/profile"            element={<Profile />} />
          <Route path="/wallet"             element={<Wallet />} />
          <Route path="/tip"                element={<Tip />} />
          <Route path="/game/block-blast"   element={<BlockBlastGame />} />
          <Route path="/game/quick-match"   element={<QuickMatch />} />
          <Route path="/game/scrabble"      element={<WordleGame />} />
          <Route path="/game/coin-flip"     element={<CoinFlipGame />} />
          <Route path="/game/blackjack"     element={<BlackjackGame />} />
          <Route path="/game/word-vs"       element={<WordleGame />} />
          <Route path="/spectate/:gameId"   element={<SpectateView />} />
          <Route path="/game/random"        element={<Navigate to="/game/quick-match" replace />} />
          <Route path="/transactions"       element={<ProtectedRoute><Transactions /></ProtectedRoute>} />
          <Route path="/rewards"            element={<Rewards />} />
          <Route path="/reset-password"      element={<ResetPassword />} />
          <Route path="/tos"                element={<ToS />} />
          <Route path="/admin"              element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="*"                   element={<Navigate to="/" replace />} />
        </Routes>
        </div>
      </main>
      <ForfeitToast />
      <ReconnectOverlay />
      {tosPending && <AgeToSModal onAccept={() => setTosAccepted(true)} />}
      {showSaveLogin && <SaveLoginPrompt onDone={() => setShowSaveLogin(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <WalletProvider>
            <CurrencyProvider>
              <NotifyToast />
              <Shell />
            </CurrencyProvider>
          </WalletProvider>
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
