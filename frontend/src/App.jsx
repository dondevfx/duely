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
import { useState, useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { lazyPage, prefetchPages } from './utils/lazyPage';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider, useSocket } from './context/SocketContext';
import { WalletProvider } from './context/WalletContext';
import { CurrencyProvider } from './context/CurrencyContext';
import Navbar from './components/Navbar';
import BottomNav, { BottomBarProvider, useShowsBottomNav } from './components/BottomNav';
import LeftSidebar from './components/LeftSidebar';
import ChatSidebar from './components/ChatSidebar';
// The two pages people land on stay in the main bundle so the first paint does
// not wait on a second request. Everything else is its own file, fetched when
// opened — and in the background right after the first page loads. See
// utils/lazyPage.
import Home from './pages/Home';
import Games from './pages/Games';
const ChallengeJoin     = lazyPage(() => import('./pages/ChallengeJoin'));
const Leaderboard       = lazyPage(() => import('./pages/Leaderboard'));
const Profile           = lazyPage(() => import('./pages/Profile'));
const Wallet            = lazyPage(() => import('./pages/Wallet'));
const Tip               = lazyPage(() => import('./pages/Tip'));
const BlockBlastGame    = lazyPage(() => import('./pages/BlockBlastGame'));
const QuickMatch        = lazyPage(() => import('./pages/QuickMatch'));
const Tournaments       = lazyPage(() => import('./pages/Tournaments'));
const TournamentBracket = lazyPage(() => import('./pages/TournamentBracket'));
const AddFriend         = lazyPage(() => import('./pages/AddFriend'));
const WordleGame        = lazyPage(() => import('./pages/WordleGame'));
const CoinFlipGame      = lazyPage(() => import('./pages/CoinFlipGame'));
const BlackjackGame     = lazyPage(() => import('./pages/BlackjackGame'));
const CarDashGame       = lazyPage(() => import('./pages/CarDashGame'));
const ColorRushGame     = lazyPage(() => import('./pages/ColorRushGame'));
const ColorRushCanvas   = lazyPage(() => import('./components/ColorRushCanvas'));
const TowerGame         = lazyPage(() => import('./pages/TowerGame'));
const TowerCanvas       = lazyPage(() => import('./components/TowerCanvas'));
import TournamentClock from './components/TournamentClock';
import PageMeta from './components/PageMeta';
// Dev-only: lets the game be looked at before the lobby and engine exist.
// Stripped from production builds by the import.meta.env.DEV guard below.
// Dev-only, same convention as the canvas previews above: the age/terms gate
// only ever appears for a signed-in account that has not accepted, which makes
// it the hardest thing in the app to look at while working on it — and it is a
// full-screen legal wall, so "hard to look at" is how a broken one ships.
function TosPreview() { return <AgeToSModal onAccept={() => {}} />; }
// The invite dialog with nobody online, which is the state that has to say so
// rather than leaving a gap. Reaching it for real needs a funded account and
// a friends list.
function InvitePreview() {
  return <CreateRoomModal open onClose={() => {}} gameType="tower" entryFee={1} currency="coins" onCreateCode={() => {}} />;
}
// The admin charts, with a synthetic series: a quiet stretch, a spike, and a
// zero day. The admin page itself needs a real admin account to reach, which
// makes the one drawing on it the hardest thing here to look at.
function ChartPreview() {
  const pts = Array.from({ length: 30 }, (_, i) => ({
    t: `2026-03-${String(i + 1).padStart(2, '0')}`,
    matches: i === 12 ? 480 : i === 20 ? 0 : 40 + Math.round(Math.sin(i) * 25) + i * 3,
    active_players: i === 20 ? 0 : 12 + Math.round(Math.cos(i) * 6) + i,
  }));
  return (
    <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
      <div className="bg-surface border border-border rounded-2xl p-4">
        <h3 className="text-sm font-bold text-white mb-2">Matches (bar)</h3>
        <AdminChart points={pts} metric="matches" color="#00BFFF" />
      </div>
      <div className="bg-surface border border-border rounded-2xl p-4">
        <h3 className="text-sm font-bold text-white mb-2">Active Players (line)</h3>
        <AdminChart points={pts} metric="active_players" color="#ec4899" kind="line" />
      </div>
      <div className="bg-surface border border-border rounded-2xl p-4">
        <h3 className="text-sm font-bold text-white mb-2">Empty range</h3>
        <AdminChart points={[]} metric="matches" />
      </div>
    </div>
  );
}
// The result card at its tallest: an unplaced account, so the placement row is
// showing, which is the only combination that ever overflowed a phone.
function ResultPreview() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <ResultScreen
        isWinner winnerUsername="you" loserUsername="them"
        newWinnerElo={1020} winnerBefore={1000}
        balanceChange={1.9} currency="coins" entryFee={1}
        gameLabel="Solo Endless"
        winnerStreak={2}
        profile={{ wins: 1, losses: 0, elo: 1020 }}
        onPlayAgain={() => {}} onBackToLobby={() => {}}
      />
    </div>
  );
}
// The player-profile popup, at its widest values: a four-digit rating in the
// longest rank name, and eight-figure wagered totals. That combination is the
// one that overflowed, and it needs a chat message to reach normally.
function PopupPreview() {
  const data = {
    id: 'x', username: 'CEO', rank: 1, elo: 3453, wins: 159, losses: 53,
    total_wagered: 3393, total_wagered_diamonds: 1100000,
    profile_color: '#22c55e', avatar_url: null, current_streak: 0,
  };
  return <ProfilePopupPreview data={data} />;
}
function TowerPreview() { return <div style={{position:'fixed',inset:0}}><TowerCanvas running /></div>; }
function ColorRushPreview() {
  return <div style={{position:'fixed',inset:0}}><ColorRushCanvas seed={12345} onProgress={() => {}} onDeath={() => {}} /></div>;
}
const Transactions  = lazyPage(() => import('./pages/Transactions'));
const Rewards       = lazyPage(() => import('./pages/Rewards'));
const Login         = lazyPage(() => import('./pages/Login'));
const Signup        = lazyPage(() => import('./pages/Signup'));
const AuthCallback  = lazyPage(() => import('./pages/AuthCallback'));
const ResetPassword = lazyPage(() => import('./pages/ResetPassword'));
const ToS           = lazyPage(() => import('./pages/ToS'));
const Privacy       = lazyPage(() => import('./pages/Privacy'));
const Support       = lazyPage(() => import('./pages/Support'));
const Admin         = lazyPage(() => import('./pages/Admin'));
const SpectateView  = lazyPage(() => import('./pages/SpectateView'));
import ForfeitToast from './components/ForfeitToast';
import NotifyToast from './components/NotifyToast';
import ReconnectOverlay from './components/ReconnectOverlay';
import AgeToSModal, { useTosAccepted } from './components/AgeToSModal';
// Only the dev previews use these three here; the pages that need them
// import them themselves.
const ResultScreen    = lazyPage(() => import('./components/ResultScreen'));
const CreateRoomModal = lazyPage(() => import('./components/CreateRoomModal'));
const AdminChart      = lazyPage(() => import('./components/AdminChart'));
import { ProfilePopupPreview } from './components/ChatSidebar';
import SignupRewardModal from './components/SignupRewardModal';
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
  // Acceptance is the account's, so it is fetched rather than read locally,
  // and starts as null (not known yet). The local override is what an accept
  // in this session sets, so the modal closes without waiting for a re-fetch.
  const tosServer = useTosAccepted(session);
  const [tosAcceptedNow, setTosAcceptedNow] = useState(false);
  const tosAccepted = tosAcceptedNow || tosServer === true;
  const [chatOpen, setChatOpen] = useState(getInitialChatOpen);
  const navigate = useNavigate();
  const location = useLocation();
  // Same answer the bar itself uses, so the reserved height and the bar can
  // never disagree about whether there is one.
  const barShows = useShowsBottomNav(location.pathname);
  // Every page's code, fetched in the background once this one has loaded.
  useEffect(() => { prefetchPages(); }, []);
  // Interactive game pages must NOT be inside the TV zoom wrapper — CSS `zoom`
  // on an ancestor breaks position:fixed drag math (e.g. Block Burst's drag
  // ghost jumps away from the cursor when the browser is zoomed out).
  // The dev canvas previews count too. CSS `zoom` on an ancestor rescales
  // pointer coordinates and canvas layout, so a preview rendered inside the
  // wrapper does not show what the real game page shows — which makes it
  // useless for the one thing it exists for.
  const isGamePage = location.pathname.startsWith('/game/')
    // Tournaments belong here too, and not being here is why the bet screen
    // looked wrong on a desktop.
    //
    // tv-scale applies a CSS zoom to every ordinary page on a large monitor.
    // Every other bet screen lives under /game/ and is exempt, so the
    // tournament one — at /tournaments — was the only bet screen in the app
    // being shrunk, and sat at a different size from the seven it is meant to
    // match. The bracket and the draw go with it: the draw is a fixed
    // full-screen layer, and a zoomed ancestor is exactly what breaks the
    // geometry of those.
    || location.pathname.startsWith('/tournaments')
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

  // Nothing shows while the answer is unknown. Defaulting to "pending" would
  // flash a full-screen legal modal at every returning player on every load.
  const tosPending = !!session && tosServer !== null && !tosAccepted;
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
        {/* Phones only — the left sidebar already does this job from md up. */}
        <BottomNav />
      </div>
      {/* Main content always interactive */}
      {/* md:left-60 must match LeftSidebar's w-60. It was left-56 (224px)
          against a 240px sidebar, so 16px of every page sat underneath it —
          which clipped the games' bottom-left help button and let Tower's
          black background run under the sidebar edge. The right side pairs
          lg:right-80 with the chat panel's w-80 and is already correct. */}
      <main className={`absolute top-14 ${barShows ? 'bottom-14' : 'bottom-0'} md:bottom-0 left-0 right-0 overflow-y-auto transition-[left,right] duration-300 md:left-60 ${chatOpen ? 'lg:right-80' : 'md:right-0'}`}
            // bottom-14 on phones so the bar sits BELOW the scroll area
            // rather than over the end of it — page padding would still
            // leave the last row under a translucent bar on any page
            // that forgot it.
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className={isGamePage ? '' : 'tv-scale'}>
        <ErrorBoundary resetKey={location.pathname}>
        {/* Nothing as the fallback: every page's file is prefetched right after
            the first load, so this only shows for the instant a page is first
            opened before that finishes — and the shell stays up around it. */}
        <Suspense fallback={null}>
        <Routes>
          <Route path="/"                  element={<Home />} />
          <Route path="/games"              element={<Games />} />
          <Route path="/challenge/:gameType/:code" element={<ChallengeJoin />} />
          <Route path="/leaderboard"        element={<Leaderboard />} />
          <Route path="/login"              element={<Login />} />
          <Route path="/signup"             element={<Signup />} />
          {/* Where Google sends the browser back. Not behind
              ProtectedRoute — arriving here is how you become signed in. */}
          <Route path="/auth/callback"      element={<AuthCallback />} />
          <Route path="/profile"            element={<Profile />} />
          <Route path="/wallet"             element={<Wallet />} />
          <Route path="/tip"                element={<Tip />} />
          <Route path="/game/block-blast"   element={<BlockBlastGame />} />
          <Route path="/tournaments"        element={<Tournaments />} />
          <Route path="/tournaments/:id"    element={<TournamentBracket />} />
          {/* Quick Match kept its route: Tournaments took its place in the
              grid and the sidebar, but a link somebody saved still works. */}
          <Route path="/game/quick-match"   element={<QuickMatch />} />
          <Route path="/game/scrabble"      element={<WordleGame />} />
          <Route path="/game/coin-flip"     element={<CoinFlipGame />} />
          <Route path="/game/blackjack"     element={<BlackjackGame />} />
          <Route path="/game/car-dash"      element={<CarDashGame />} />
          <Route path="/game/color-rush"    element={<ColorRushGame />} />
          <Route path="/game/tower"         element={<TowerGame />} />
          {import.meta.env.DEV && <Route path="/__tos-preview" element={<TosPreview />} />}
          {import.meta.env.DEV && <Route path="/__invite-preview" element={<InvitePreview />} />}
          {import.meta.env.DEV && <Route path="/__chart-preview" element={<ChartPreview />} />}
          {import.meta.env.DEV && <Route path="/__popup-preview" element={<PopupPreview />} />}
          {import.meta.env.DEV && <Route path="/__result-preview" element={<ResultPreview />} />}
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
        </Suspense>
        </ErrorBoundary>
        </div>
      </main>
      <ForfeitToast />
      <InviteToasts />
      <ReconnectOverlay />
      {tosPending && <AgeToSModal onAccept={() => setTosAcceptedNow(true)} />}
      {/* After the ToS, never beside it. Both are z-50 full-screen modals, so
          without this gate a new account would get the gift painted over the
          age check — and the gift is the one that can wait.
          Gated on ACCEPTED rather than on "not pending": acceptance is now
          fetched, and it is briefly neither accepted nor pending while that
          request is in flight — which is exactly when a new account would have
          slipped the gift in ahead of the age check. */}
      {tosAccepted && <SignupRewardModal />}
      {/* The tournament round's clock, mounted once for every game rather
          than added to five game screens. It renders nothing outside a
          tournament. See the component for why the top centre. */}
      <TournamentClock />
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
                {/* Above Shell, because both the bar and the scroll area's
                    reserved height read from it. */}
                <BottomBarProvider>
                  <ScrollToTop />
                  <PageMeta />
                  <NotifyToast />
                  <BalanceSync />
                  <ReferralCapture />
                  <Shell />
                </BottomBarProvider>
              </CurrencyProvider>
            </WalletProvider>
          </SocketProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
