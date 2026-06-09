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
import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
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
import ScrabbleGame from './pages/ScrabbleGame';
import CoinFlipGame from './pages/CoinFlipGame';
import BlackjackGame from './pages/BlackjackGame';
import Transactions from './pages/Transactions';
import Rewards from './pages/Rewards';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ToS from './pages/ToS';
import Admin from './pages/Admin';
import SpectateView from './pages/SpectateView';
import ForfeitToast from './components/ForfeitToast';
import ReconnectOverlay from './components/ReconnectOverlay';
import AgeToSModal, { useTosAccepted } from './components/AgeToSModal';
import GeoWarningModal from './components/GeoWarningModal';
import PWAInstallPrompt from './components/PWAInstallPrompt';

function ProtectedRoute({ children }) {
  const { session, loading, mfaPending } = useAuth();
  if (loading) return (
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
  const { session } = useAuth();
  const [tosAccepted, setTosAccepted] = useState(useTosAccepted());
  const [chatOpen, setChatOpen] = useState(getInitialChatOpen);

  function handleChatToggle(next) {
    setChatOpen(next);
    try { localStorage.setItem('worldChatOpen', String(next)); } catch {}
  }

  return (
    <div className="min-h-screen bg-bg">
      <Navbar />
      <div className="flex pt-14">
        <LeftSidebar />
        <main className={`flex-1 lg:ml-56 min-h-[calc(100vh-56px)] overflow-y-auto transition-[margin] duration-300 ${chatOpen ? 'lg:mr-80' : 'lg:mr-0'}`}>
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
            <Route path="/game/scrabble"      element={<ScrabbleGame />} />
            <Route path="/game/coin-flip"     element={<CoinFlipGame />} />
            <Route path="/game/blackjack"     element={<BlackjackGame />} />
            <Route path="/game/word-vs"       element={<ScrabbleGame />} />
            <Route path="/spectate/:gameId"   element={<SpectateView />} />
            {/* Legacy random redirect */}
            <Route path="/game/random"        element={<Navigate to="/game/quick-match" replace />} />
            <Route path="/transactions"       element={<ProtectedRoute><Transactions /></ProtectedRoute>} />
            <Route path="/rewards"            element={<Rewards />} />
            <Route path="/tos"                element={<ToS />} />
            <Route path="/admin"              element={<ProtectedRoute><Admin /></ProtectedRoute>} />
            <Route path="*"                   element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <ChatSidebar open={chatOpen} onToggle={handleChatToggle} />
      </div>
      <GeoWarningModal />
      <PWAInstallPrompt />
      <ForfeitToast />
      <ReconnectOverlay />
      {session && !tosAccepted && <AgeToSModal onAccept={() => setTosAccepted(true)} />}
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
              <Shell />
            </CurrencyProvider>
          </WalletProvider>
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
