import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useSocket } from '../context/SocketContext';
import { getRank, getDisplayRank, isRanked } from '../utils/ranks';
import { api } from '../utils/api';
import CoinIcon from './CoinIcon';
import { fmtCoins, fmtDiamonds } from '../utils/format';

const NAV_LINKS = [
  { icon: '🏠', label: 'Home',        to: '/' },
  { icon: '🎮', label: 'Games',       to: '/games' },
  { icon: '🎡', label: 'Rewards',     to: '/rewards' },
  { icon: '👤', label: 'Profile',     to: '/profile' },
  { icon: '🏆', label: 'Leaderboard', to: '/leaderboard' },
  { icon: '💳', label: 'Wallet',      to: '/wallet' },
  { icon: '💸', label: 'Tip',         to: '/tip' },
];

const GAME_LINKS = [
  { icon: '⚡', label: 'Quick Match', to: '/game/quick-match' },
  { icon: '🟦', label: 'Block Burst', to: '/game/block-blast', countKey: 'block-blast' },
  { icon: '🟡', label: 'Coin Flip',   to: '/game/coin-flip',   countKey: 'coin-flip' },
  { icon: '🔤', label: 'Word VS',     to: '/game/scrabble',    countKey: 'scrabble' },
  { icon: '🃏', label: 'Blackjack',   to: '/game/blackjack',   countKey: 'blackjack' },
  { icon: '🚗', label: 'Highway Dash', to: '/game/car-dash',  countKey: 'car-dash' },
];


function fmtRakebackTimer(ms) {
  if (ms <= 0) return null;
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function Navbar() {
  const { profile, session, signOut, refreshProfile } = useAuth();
  const { displayCurrency, setDisplayCurrency } = useCurrency();
  const { playerCounts } = useSocket();
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen]   = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileCurrencyOpen, setMobileCurrencyOpen] = useState(false);
  const [rakebackOpen, setRakebackOpen]   = useState(false);
  const [rakebackData, setRakebackData]   = useState(null);
  const [rakebackLoading, setRakebackLoading] = useState(false);
  const [rakebackCountdowns, setRakebackCountdowns] = useState({ instant: 0, daily: 0, weekly: 0 });
  const dropRef            = useRef(null);
  const rakebackRef        = useRef(null);
  const mobileCurrencyRef  = useRef(null);
  const mobileRakebackRef  = useRef(null);
  const [mobileRakebackOpen, setMobileRakebackOpen] = useState(false);

  useEffect(() => {
    function handler(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropdownOpen(false);
      if (rakebackRef.current && !rakebackRef.current.contains(e.target)) setRakebackOpen(false);
      if (mobileCurrencyRef.current && !mobileCurrencyRef.current.contains(e.target)) setMobileCurrencyOpen(false);
      if (mobileRakebackRef.current && !mobileRakebackRef.current.contains(e.target)) setMobileRakebackOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close mobile menu on route change
  useEffect(() => { setMobileMenuOpen(false); }, [navigate]);

  const fetchRakeback = useCallback(async () => {
    try {
      const data = await api.get('/rakeback');
      setRakebackData(data);
    } catch {
      // Silently fail if columns don't exist yet
    }
  }, []);

  useEffect(() => {
    if (!rakebackData) return;
    const tick = () => {
      const now = Date.now();
      setRakebackCountdowns({
        instant: rakebackData.instantNextAt ? Math.max(0, new Date(rakebackData.instantNextAt).getTime() - now) : 0,
        daily:   rakebackData.dailyNextAt   ? Math.max(0, new Date(rakebackData.dailyNextAt).getTime() - now)   : 0,
        weekly:  rakebackData.weeklyNextAt  ? Math.max(0, new Date(rakebackData.weeklyNextAt).getTime() - now)  : 0,
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [rakebackData]);

  async function handleRakebackOpen() {
    setRakebackOpen(o => {
      if (!o) {
        setRakebackLoading(true);
        fetchRakeback().finally(() => setRakebackLoading(false));
      }
      return !o;
    });
  }

  async function handleRakebackClaim(type) {
    try {
      await api.post(`/rakeback/claim/${type}`, {});
      await Promise.all([fetchRakeback(), refreshProfile()]);
    } catch {
      // ignore — button stays disabled
    }
  }

  async function handleSignOut() {
    setMobileMenuOpen(false);
    await signOut();
    navigate('/');
  }

  const isDiamonds = displayCurrency === 'diamonds';
  const balanceDisplay = isDiamonds
    ? `${fmtDiamonds(profile?.diamonds)} 💎`
    : fmtCoins(profile?.c_coins);

  return (
    <>
      <nav className="fixed top-0 inset-x-0 z-50 h-14 border-b border-border bg-surface/95 backdrop-blur-md">
        <div className="flex items-center h-full px-3 sm:px-4 gap-2">

          {/* Hamburger — mobile only */}
          <button
            className="lg:hidden p-2 rounded-lg text-muted hover:text-white hover:bg-surfaceLight transition-colors shrink-0 w-9 h-9 flex items-center justify-center"
            onClick={() => setMobileMenuOpen(o => !o)}
            aria-label="Menu"
          >
            <div className="w-5 flex flex-col gap-1.5">
              <span className={`block h-0.5 bg-current rounded transition-all origin-center ${mobileMenuOpen ? 'rotate-45 translate-y-2' : ''}`} />
              <span className={`block h-0.5 bg-current rounded transition-all ${mobileMenuOpen ? 'opacity-0' : ''}`} />
              <span className={`block h-0.5 bg-current rounded transition-all origin-center ${mobileMenuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
            </div>
          </button>

          {/* Logo — left-aligned (in flex flow) so a large balance can't overlap it */}
          <div className="relative shrink-0 lg:w-56 flex justify-start pointer-events-auto">
            <Link to="/" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-1.5 pointer-events-auto">
              <span className="text-2xl lg:text-3xl font-black tracking-tight text-primary" style={{ textShadow: '0 0 22px rgba(18,80,180,0.6)' }}>
                Duely
              </span>
              <span className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-primary animate-pulse" />
            </Link>
          </div>

          {/* Desktop center — balance + tip */}
          <div className="hidden lg:flex flex-1 justify-center items-center gap-3" ref={dropRef}>
            {profile ? (
              <>
              <div className="relative">
                <button
                  onClick={() => setDropdownOpen(o => !o)}
                  className="flex items-center gap-2.5 px-5 py-1.5 bg-black border border-primary/30 hover:border-primary rounded-full transition-all shadow-glow group"
                >
                  {isDiamonds ? (
                    <>
                      <span className="relative -top-px">💎</span>
                      <span className="text-sm font-black text-white font-mono">
                        {fmtDiamonds(profile.diamonds)}
                      </span>
                    </>
                  ) : (
                    <>
                      <CoinIcon size="1.1em" />
                      <span className="text-sm font-black text-white font-mono">{fmtCoins(profile.c_coins)}</span>
                    </>
                  )}
                  <span className="text-muted text-xs">▾</span>
                </button>

                {dropdownOpen && (
                  <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-surface border border-border rounded-xl shadow-glow-lg w-64 overflow-hidden z-50">
                    <div className="p-1">
                      <button onClick={() => { setDisplayCurrency('coins'); setDropdownOpen(false); }}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all ${!isDiamonds ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surfaceLight hover:text-white'}`}>
                        <CoinIcon size="1em" />
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium text-xs">Coins</span>
                          <span className="font-mono font-bold text-white text-sm leading-tight">{fmtCoins(profile.c_coins)}</span>
                        </div>
                      </button>
                      <button onClick={() => { setDisplayCurrency('diamonds'); setDropdownOpen(false); }}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all ${isDiamonds ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surfaceLight hover:text-white'}`}>
                        <span className="relative -top-px">💎</span>
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium text-xs">Diamonds</span>
                          <span className="font-mono font-bold text-white text-sm leading-tight">{fmtDiamonds(profile.diamonds)}</span>
                        </div>
                      </button>
                    </div>
                    <div className="border-t border-border p-2">
                      <Link to="/wallet" onClick={() => setDropdownOpen(false)}
                        className="block w-full text-center text-xs font-semibold px-3 py-2 rounded-lg bg-surfaceLight hover:bg-primary/20 text-muted hover:text-white transition-all">
                        Manage Wallet →
                      </Link>
                    </div>
                  </div>
                )}
              </div>
              {/* Rakeback button + dropdown */}
              <div className="relative" ref={rakebackRef}>
                <button
                  onClick={handleRakebackOpen}
                  title="Rakeback"
                  className="flex items-center justify-center w-9 h-9 rounded-full border border-primary bg-primary hover:bg-blue-500 transition-all text-lg shadow-glow"
                >
                  🎁
                </button>

                {rakebackOpen && (
                  <div className="absolute top-full mt-2 right-0 bg-surface border border-border rounded-xl shadow-glow-lg z-[200] overflow-hidden" style={{ minWidth: 'min(300px, calc(100vw - 16px))', right: 0 }}>
                    <div className="px-4 py-3 border-b border-border">
                      <span className="text-sm font-bold text-white">🎁 Rakeback</span>
                      <p className="text-[10px] text-muted mt-0.5">Earned from coin wagers only</p>
                    </div>
                    {rakebackLoading ? (
                      <div className="px-4 py-4 text-xs text-muted text-center">Loading...</div>
                    ) : !rakebackData ? (
                      <div className="px-4 py-4 text-xs text-muted text-center">Unavailable</div>
                    ) : (
                      <div className="p-3 space-y-2">
                        {/* Instant row */}
                        <div className="rounded-xl border border-border bg-bg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-base">⚡</span>
                              <span className="text-sm font-semibold text-white">Instant</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleRakebackClaim('instant')}
                            disabled={!(rakebackData.instantClaimable ?? false)}
                            className={`w-full py-2 rounded-lg text-xs font-bold transition-all ${
                              (rakebackData.instantClaimable ?? false)
                                ? 'bg-primary text-white hover:bg-blue-500'
                                : 'bg-surfaceLight text-muted cursor-not-allowed opacity-60'
                            }`}
                          >
                            {!(rakebackData.instantClaimable ?? false) && rakebackCountdowns.instant > 0 ? fmtRakebackTimer(rakebackCountdowns.instant) : 'Claim'}
                          </button>
                        </div>

                        {/* Daily row */}
                        <div className="rounded-xl border border-border bg-bg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-base">⏱️</span>
                              <span className="text-sm font-semibold text-white">Daily</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleRakebackClaim('daily')}
                            disabled={!rakebackData.dailyClaimable}
                            className={`w-full py-2 rounded-lg text-xs font-bold transition-all ${
                              rakebackData.dailyClaimable
                                ? 'bg-primary text-white hover:bg-blue-500'
                                : 'bg-surfaceLight text-muted cursor-not-allowed opacity-60'
                            }`}
                          >
                            {!rakebackData.dailyClaimable && rakebackCountdowns.daily > 0 ? fmtRakebackTimer(rakebackCountdowns.daily) : 'Claim'}
                          </button>
                        </div>

                        {/* Weekly row */}
                        <div className="rounded-xl border border-border bg-bg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-base">📆</span>
                              <span className="text-sm font-semibold text-white">Weekly</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleRakebackClaim('weekly')}
                            disabled={!rakebackData.weeklyClaimable}
                            className={`w-full py-2 rounded-lg text-xs font-bold transition-all ${
                              rakebackData.weeklyClaimable
                                ? 'bg-primary text-white hover:bg-blue-500'
                                : 'bg-surfaceLight text-muted cursor-not-allowed opacity-60'
                            }`}
                          >
                            {!rakebackData.weeklyClaimable && rakebackCountdowns.weekly > 0 ? fmtRakebackTimer(rakebackCountdowns.weekly) : 'Claim'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              </>
            ) : (
              <span className="text-sm font-black text-primary/30 tracking-widest">DUELY</span>
            )}
          </div>

          {/* Flex-1 spacer on mobile to push right items to edge */}
          <div className="lg:hidden flex-1" />

          {/* Mobile: balance + rakeback (inline with right section) */}
          {profile && (
            <div className="lg:hidden flex items-center gap-1.5 shrink-0">
              {/* Balance dropdown */}
              <div className="relative" ref={mobileCurrencyRef}>
                <button
                  onClick={() => setMobileCurrencyOpen(o => !o)}
                  className="flex items-center gap-0.5 px-2 py-1 bg-black border border-primary/30 rounded-full font-bold text-white transition-all"
                  style={{ fontSize: 11 }}
                >
                  <span className="font-mono">{isDiamonds ? fmtDiamonds(profile.diamonds) : fmtCoins(profile.c_coins)}</span>
                  {isDiamonds ? <span>💎</span> : <CoinIcon size="0.9em" />}
                  <span className="text-muted" style={{ fontSize: 9 }}>▾</span>
                </button>
                {mobileCurrencyOpen && (
                  <div className="absolute top-full mt-2 right-0 bg-surface border border-border rounded-xl shadow-glow-lg z-50 overflow-hidden" style={{ minWidth: 190 }}>
                    <div className="p-1">
                      <button onClick={() => { setDisplayCurrency('coins'); setMobileCurrencyOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-all ${!isDiamonds ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surfaceLight hover:text-white'}`}>
                        <CoinIcon size="1em" />
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium">Coins</span>
                          <span className="font-mono font-bold text-white leading-tight">{fmtCoins(profile.c_coins)}</span>
                        </div>
                      </button>
                      <button onClick={() => { setDisplayCurrency('diamonds'); setMobileCurrencyOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-all ${isDiamonds ? 'bg-primary/15 text-primary' : 'text-muted hover:bg-surfaceLight hover:text-white'}`}>
                        <span>💎</span>
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium">Diamonds</span>
                          <span className="font-mono font-bold text-white leading-tight">{fmtDiamonds(profile.diamonds)}</span>
                        </div>
                      </button>
                    </div>
                    <div className="border-t border-border p-1.5">
                      <Link to="/wallet" onClick={() => setMobileCurrencyOpen(false)}
                        className="block w-full text-center text-xs font-semibold px-3 py-2 rounded-lg bg-surfaceLight hover:bg-primary/20 text-muted hover:text-white transition-all">
                        Wallet →
                      </Link>
                    </div>
                  </div>
                )}
              </div>

              {/* Mobile rakeback button */}
              <div className="relative" ref={mobileRakebackRef}>
                <button
                  onClick={() => {
                    setMobileRakebackOpen(o => {
                      if (!o) {
                        setRakebackLoading(true);
                        fetchRakeback().finally(() => setRakebackLoading(false));
                      }
                      return !o;
                    });
                  }}
                  className="flex items-center justify-center w-7 h-7 rounded-full border border-primary bg-primary hover:bg-blue-500 transition-all"
                  style={{ fontSize: 14 }}
                  title="Rakeback"
                >
                  🎁
                </button>
                {mobileRakebackOpen && (
                  <div className="absolute top-full mt-2 right-0 bg-surface border border-border rounded-xl shadow-glow-lg z-[200] overflow-hidden" style={{ minWidth: 'min(280px, calc(100vw - 32px))', right: -8 }}>
                    <div className="px-4 py-3 border-b border-border">
                      <span className="text-sm font-bold text-white">🎁 Rakeback</span>
                      <p className="text-[10px] text-muted mt-0.5">Earned from coin wagers only</p>
                    </div>
                    {rakebackLoading ? (
                      <div className="px-4 py-4 text-xs text-muted text-center">Loading...</div>
                    ) : !rakebackData ? (
                      <div className="px-4 py-4 text-xs text-muted text-center">Unavailable</div>
                    ) : (
                      <div className="p-3 space-y-2">
                        {[
                          { key: 'instant', label: 'Instant', icon: '⚡', amount: rakebackData.instant ?? 0, claimable: rakebackData.instantClaimable ?? false, countdown: rakebackCountdowns.instant },
                          { key: 'daily',   label: 'Daily',   icon: '⏱️', amount: rakebackData.daily   ?? 0, claimable: rakebackData.dailyClaimable,             countdown: rakebackCountdowns.daily },
                          { key: 'weekly',  label: 'Weekly',  icon: '📆', amount: rakebackData.weekly  ?? 0, claimable: rakebackData.weeklyClaimable,             countdown: rakebackCountdowns.weekly },
                        ].map(({ key, label, icon, claimable, countdown }) => (
                          <div key={key} className="rounded-xl border border-border bg-bg p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-base">{icon}</span>
                                <span className="text-sm font-semibold text-white">{label}</span>
                              </div>
                            </div>
                            <button
                              onClick={() => handleRakebackClaim(key)}
                              disabled={!claimable}
                              className={`w-full py-2 rounded-lg text-xs font-bold transition-all ${claimable ? 'bg-primary text-white hover:bg-blue-500' : 'bg-surfaceLight text-muted cursor-not-allowed opacity-60'}`}
                            >
                              {!claimable && countdown > 0 ? fmtRakebackTimer(countdown) : 'Claim'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Right — avatar + sign out / auth */}
          <div className="lg:w-64 lg:shrink-0 flex items-center justify-end gap-2 shrink-0">
            {profile ? (
              <>
                {profile.is_admin && (
                  <Link to="/admin" className="hidden lg:block text-xs font-bold px-2 py-1 rounded-lg text-muted/50 hover:text-primary hover:bg-primary/10 transition-colors">
                    ⚙
                  </Link>
                )}
                <Link to="/profile" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 group">
                  <div className="relative">
                    <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-full flex items-center justify-center text-xs lg:text-sm font-bold transition-all"
                      style={{
                        backgroundColor: `${profile.profile_color || '#1250B4'}22`,
                        border: `1.5px solid ${profile.profile_color || '#1250B4'}`,
                        color: profile.profile_color || '#1250B4',
                      }}>
                      {profile.username?.[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="absolute -bottom-1 -right-1 text-sm leading-none" title={getDisplayRank(profile).name}>
                      {getDisplayRank(profile).icon}
                    </span>
                    {(profile.current_streak ?? 0) >= 1 && (
                      <span className="absolute -top-1 -left-1 flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-black leading-none px-0.5"
                        style={{ background: 'rgba(0,0,0,0.85)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.4)', textShadow: '0 0 6px rgba(251,146,60,0.6)' }}>
                        🔥{profile.current_streak}
                      </span>
                    )}
                  </div>
                  <div className="hidden md:flex flex-col leading-tight">
                    <span className="text-sm text-muted group-hover:text-white transition-colors truncate max-w-[90px]">
                      {profile.username}
                    </span>
                    <span className="text-xs font-semibold" style={{ color: getDisplayRank(profile).color }}>
                      {getDisplayRank(profile).name}
                    </span>
                  </div>
                </Link>
                <button onClick={handleSignOut} className="hidden lg:block text-sm font-medium px-3 py-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors whitespace-nowrap shrink-0">
                  Sign out
                </button>
              </>
            ) : session ? (
              // Session exists but profile still loading — show a placeholder so
              // we never flash "Sign in" for an authenticated user.
              <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-full bg-primary/20 animate-pulse" />
            ) : (
              <>
                <Link to="/login" className="text-sm text-muted hover:text-white transition-colors hidden sm:block">Sign in</Link>
                <Link to="/signup" className="text-sm font-semibold px-3 py-1.5 bg-primary rounded-lg text-white hover:bg-blue-500 shadow-glow transition-all">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-0 top-14 z-40 bg-bg overflow-y-auto pb-8">
          <div className="px-4 pt-4 space-y-6">

            {/* Nav section */}
            <div>
              <p className="text-xs text-muted uppercase tracking-widest font-semibold px-2 mb-2">Menu</p>
              {NAV_LINKS.map(item => (
                <NavLink key={item.to} to={item.to} end={item.to === '/'}
                  onClick={() => setMobileMenuOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-3 rounded-xl text-base font-medium mb-1 transition-all ${
                      isActive ? 'bg-primary/15 text-primary border border-primary/20' : 'text-muted hover:text-white hover:bg-surfaceLight'
                    }`
                  }>
                  <span className="text-xl">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>

            <div className="border-t border-border" />

            {/* Games section */}
            <div>
              <p className="text-xs text-muted uppercase tracking-widest font-semibold px-2 mb-2">Games</p>
              {GAME_LINKS.map(item => {
                const count = playerCounts?.[item.countKey] ?? 0;
                return (
                  <NavLink key={item.to} to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-3 rounded-xl text-base font-medium mb-1 transition-all ${
                        isActive ? 'bg-primary/15 text-primary border border-primary/20' : 'text-muted hover:text-white hover:bg-surfaceLight'
                      }`
                    }>
                    <span className="text-xl">{item.icon}</span>
                    <span className="flex-1">{item.label}</span>
                    {count > 0 && (
                      <span className="text-[10px] bg-primary/20 text-primary border border-primary/30 px-1.5 py-0.5 rounded-full font-bold flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-primary inline-block" />
                        {count}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>

            {/* Account */}
            {profile && (
              <>
                <div className="border-t border-border" />
                <div>
                  <p className="text-xs text-muted uppercase tracking-widest font-semibold px-2 mb-2">Account</p>
                  <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-surfaceLight mb-2">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
                      style={{
                        backgroundColor: `${profile.profile_color || '#1250B4'}22`,
                        border: `1.5px solid ${profile.profile_color || '#1250B4'}`,
                        color: profile.profile_color || '#1250B4',
                      }}>
                      {profile.username?.[0]?.toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">{profile.username}</div>
                      <div className="text-xs text-muted">{isRanked(profile) ? `ELO ${profile.elo}` : 'Unranked'} · {balanceDisplay}</div>
                    </div>
                  </div>
                  <button onClick={handleSignOut}
                    className="w-full text-left px-3 py-3 rounded-xl text-base font-medium text-danger hover:bg-danger/10 transition-all">
                    Sign out
                  </button>
                </div>
              </>
            )}

            {!session && (
              <>
                <div className="border-t border-border" />
                <div className="flex flex-col gap-3">
                  <Link to="/login" onClick={() => setMobileMenuOpen(false)}
                    className="w-full text-center py-3 rounded-xl border border-border text-muted hover:text-white font-semibold transition-all">
                    Sign in
                  </Link>
                  <Link to="/signup" onClick={() => setMobileMenuOpen(false)}
                    className="w-full text-center py-3 rounded-xl bg-primary text-white font-bold shadow-glow transition-all">
                    Create Account
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

