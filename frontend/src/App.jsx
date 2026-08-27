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
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider, useSocket } from './context/SocketContext';
import { WalletProvider } from './context/WalletContext';
import { CurrencyProvider } from './context/CurrencyContext';
import Navbar from './components/Navbar';
import LeftSidebar from './components/LeftSidebar';
import ChatSidebar from './components/ChatSidebar';
import Home from './pages/Home';
import Games from './pages/Games';
import ChallengeJoin from './pages/ChallengeJoin';
import Leaderboard from './pages/Leaderboard';
import Profile from './pages/Profile';
import Wallet from './pages/Wallet';
import Tip from './pages/Tip';
import BlockBlastGame from './pages/BlockBlastGame';
import QuickMatch from './pages/QuickMatch';
import AddFriend from './pages/AddFriend';
import WordleGame from './pages/WordleGame';
import CoinFlipGame from './pages/CoinFlipGame';
import BlackjackGame from './pages/BlackjackGame';
import CarDashGame from './pages/CarDashGame';
import ColorRushGame from './pages/ColorRushGame';
import ColorRushCanvas from './components/ColorRushCanvas';
import TowerGame from './pages/TowerGame';
import TowerCanvas from './components/TowerCanvas';
// Dev-only: lets the game be looked at before the lobby and engine exist.
// Stripped from production builds by the import.meta.env.DEV guard below.
function TowerPreview() { return <div style={{position:'fixed',inset:0}}><TowerCanvas running /></div>; }
function ColorRushPreview() {
  return <div style={{position:'fixed',inset:0}}><ColorRushCanvas seed={12345} onProgress={() => {}} onDeath={() => {}} /></div>;
}
import Transactions from './pages/Transactions';
import Rewards from './pages/Rewards';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ResetPassword from './pages/ResetPassword';
import ToS from './pages/ToS';
import Privacy from './pages/Privacy';
import Support from './pages/Support';
import Admin from './pages/Admin';
import SpectateView from './pages/SpectateView';
import ForfeitToast from './components/ForfeitToast';
import NotifyToast from './components/NotifyToast';
import ReconnectOverlay from './components/ReconnectOverlay';
import AgeToSModal, { useTosAccepted } from './components/AgeToSModal';
import SaveLoginPrompt from './components/SaveLoginPrompt';
import ErrorBoundary from './components/ErrorBoundary';
import InviteToasts from './components/InviteToasts';
import BalanceSync from './components/BalanceSync';
import ReferralCapture from './components/ReferralCapture';
import ScrollToTop from './components/ScrollToTop';

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
  const location = useLocation();
  // Interactive game pages must NOT be inside the TV zoom wrapper — CSS `zoom`
  // on an ancestor breaks position:fixed drag math (e.g. Block Burst's drag
  // ghost jumps away from the cursor when the browser is zoomed out).
  // The dev canvas previews count too. CSS `zoom` on an ancestor rescales
  // pointer coordinates and canvas layout, so a preview rendered inside the
  // wrapper does not show what the real game page shows — which makes it
  // useless for the one thing it exists for.
  const isGamePage = location.pathname.startsWith('/game/')
    || location.pathname.startsWith('/__');

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
      {/* md:left-60 must match LeftSidebar's w-60. It was left-56 (224px)
          against a 240px sidebar, so 16px of every page sat underneath it —
          which clipped the games' bottom-left help button and let Tower's
          black background run under the sidebar edge. The right side pairs
          lg:right-80 with the chat panel's w-80 and is already correct. */}
      <main className={`absolute top-14 bottom-0 left-0 right-0 overflow-y-auto transition-[left,right] duration-300 md:left-60 ${chatOpen ? 'lg:right-80' : 'md:right-0'}`}>
        <div className={isGamePage ? '' : 'tv-scale'}>
        <ErrorBoundary resetKey={location.pathname}>
        <Routes>
          <Route path="/"                  element={<Home />} />
          <Route path="/games"              element={<Games />} />
          <Route path="/challenge/:gameType/:code" element={<ChallengeJoin />} />
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
          <Route path="/game/car-dash"      element={<CarDashGame />} />
          <Route path="/game/color-rush"    element={<ColorRushGame />} />
          <Route path="/game/tower"         element={<TowerGame />} />
          {import.meta.env.DEV && <Route path="/__tower-preview" element={<TowerPreview />} />}
          {import.meta.env.DEV && <Route path="/__color-rush-preview" element={<ColorRushPreview />} />}
          <Route path="/game/word-vs"       element={<WordleGame />} />
          <Route path="/spectate/:gameId"   element={<SpectateView />} />
          {/* Friend invite link. Deliberately NOT wrapped in ProtectedRoute —
              it is shared with people who have no account yet, and the page
              itself handles sign-in and finishes the add on return. */}
          <Route path="/add-friend/:username" element={<AddFriend />} />
          <Route path="/game/random"        element={<Navigate to="/game/quick-match" replace />} />
          <Route path="/transactions"       element={<ProtectedRoute><Transactions /></ProtectedRoute>} />
          <Route path="/rewards"            element={<Rewards />} />
          <Route path="/reset-password"      element={<ResetPassword />} />
          <Route path="/tos"                element={<ToS />} />
          <Route path="/privacy"            element={<Privacy />} />
          <Route path="/support"            element={<Support />} />
          <Route path="/admin"              element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="*"                   element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
        </div>
      </main>
      <ForfeitToast />
      <InviteToasts />
      <ReconnectOverlay />
      {tosPending && <AgeToSModal onAccept={() => setTosAccepted(true)} />}
      {showSaveLogin && <SaveLoginPrompt onDone={() => setShowSaveLogin(false)} />}
    </div>
  );
}

export default function App() {
  // The inner boundary around <Routes> only ever covered the page. React
  // unmounts the ENTIRE tree on an uncaught render error, so a throw in a
  // provider, the navbar, the sidebars or any of the toasts blanked the app to
  // black with no message and nothing to click — the only way out was a manual
  // refresh, which is the reported symptom.
  //
  // A provider is the worst case and the most likely one: AuthProvider reads a
  // stored session at startup, so one malformed value in localStorage takes the
  // whole site down for that browser permanently, on every load.
  //
  // This one catches all of it. The inner boundary still exists and still runs
  // first for page errors, which keeps the shell alive when only a page breaks.
  return (
    <ErrorBoundary allowReset>
      <BrowserRouter>
        <AuthProvider>
          <SocketProvider>
            <WalletProvider>
              <CurrencyProvider>
                <ScrollToTop />
                <NotifyToast />
                <BalanceSync />
                <ReferralCapture />
                <Shell />
              </CurrencyProvider>
            </WalletProvider>
          </SocketProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
