import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import DiamondIcon from './DiamondIcon';
import GameIcon from './GameIcon';
import RankIcon from './RankIcon';
import UiIcon, { RakebackTierIcon } from './UiIcon';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { getRank, getDisplayRank, isRanked } from '../utils/ranks';
import { api } from '../utils/api';
import CoinIcon from './CoinIcon';
import { fmtCoins, fmtDiamonds } from '../utils/format';
import Avatar from './Avatar';


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
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [dropdownOpen, setDropdownOpen]   = useState(false);

  // Shut the drawer on ANY navigation, not just on the links that remember to
  // call setMobileMenuOpen(false) themselves.
  //
  // Leaving it open is what makes the button look broken. Every link inside the
  // drawer closes it, but the back button, a redirect and anything that
  // navigates from elsewhere do not — so the state can sit true with nothing on
  // screen (the overlay is md:hidden, so rotating to a wide viewport also hides
  // it while the state stays). The next tap then CLOSES a drawer the player
  // cannot see, which reads exactly as "I pressed it and nothing happened", and
  // a reload clears it because the state starts false again.
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
    await signOut();
    navigate('/');
  }

  const isDiamonds = displayCurrency === 'diamonds';
  // A node, not a string: the diamond is a drawn icon now, and it cannot be
  // concatenated into one.
  const balanceDisplay = isDiamonds
    ? <span className="inline-flex items-center gap-1">{fmtDiamonds(profile?.diamonds)} <DiamondIcon /></span>
    : fmtCoins(profile?.c_coins);

  return (
    <>
      <nav className="fixed top-0 inset-x-0 z-50 h-14 border-b border-border bg-surface/95 backdrop-blur-md">
        <div className="flex items-center h-full px-3 sm:px-4 gap-2">

          {/* Hamburger — mobile only.
              relative z-10 puts it above the nav's own backdrop-blur layer.
              A blurred fixed bar is a compositing layer, and a button painted
              into it can lose hit-testing on iOS in a way a repaint clears —
              which is what "it works again after a refresh" looks like.

              touch-action: manipulation drops the double-tap-zoom wait, so the
              tap registers immediately rather than after the browser has
              decided it was not a gesture. */}

          {/* Logo — left-aligned (in flex flow) so a large balance can't overlap it */}
          <div className="relative shrink-0 lg:w-56 flex justify-start pointer-events-auto">
            {/* Home, and a reload if you are already home.
                A logo that always hard-reloaded would throw away the socket and
                every cached panel on a click people make casually, which is
                worse than the problem. But a logo that does nothing at all when
                you are already on the page you are looking at is a dead
                control — and "click the logo" is the gesture people reach for
                when something looks stuck. Clicking it from home reloads, which
                is both a real action and the escape hatch. */}
            <Link
              to="/"
              onClick={() => {
                            if (pathname === '/') window.location.reload();
              }}
              // pl-1 — a little room off the left edge. Flush against it the
              // wordmark read as clipped rather than placed.
              className="flex items-center pl-1 pointer-events-auto"
            >
              <span className="text-[1.6875rem] lg:text-[2.125rem] font-black tracking-tight text-primary" style={{ textShadow: '0 0 22px rgba(18,80,180,0.6)' }}>
                Duely
              </span>
            </Link>
          </div>

          {/* Desktop center — balance + tip */}
          <div className="hidden md:flex flex-1 justify-center items-center gap-3" ref={dropRef}>
            {profile ? (
              <>
              <div className="relative">
                <button
                  onClick={() => setDropdownOpen(o => !o)}
                  className="flex items-center gap-2.5 px-5 py-1.5 bg-black border border-primary/30 hover:border-primary rounded-full transition-all shadow-glow group"
                >
                  {isDiamonds ? (
                    <>
                      <DiamondIcon className="relative -top-px" />
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
                        <DiamondIcon className="relative -top-px" />
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium text-xs">Diamonds</span>
                          <span className="font-mono font-bold text-white text-sm leading-tight">{fmtDiamonds(profile.diamonds)}</span>
                        </div>
                      </button>
                    </div>
                    <div className="border-t border-border p-2">
                      {/* Solid primary — the one action in this dropdown, so
                          it reads as a button rather than another muted row
                          among the two balances above it. bg-primary is the
                          site blue used by every other primary button. */}
                      <Link to="/wallet" onClick={() => setDropdownOpen(false)}
                        className="block w-full text-center text-xs font-bold px-3 py-2 rounded-lg bg-primary hover:bg-blue-500 text-white transition-all">
                        Wallet
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
                  <UiIcon name="rakeback" size={19} />
                </button>

                {rakebackOpen && (
                  <div className="absolute top-full mt-2 right-0 bg-surface border border-border rounded-xl shadow-glow-lg z-[200] overflow-hidden" style={{ minWidth: 'min(300px, calc(100vw - 16px))', right: 0 }}>
                    <div className="px-4 py-3 border-b border-border">
                      <span className="text-sm font-bold text-white flex items-center gap-1.5"><UiIcon name="rakeback" size={15} />Rakeback</span>
                      <p className="text-[0.625rem] text-muted mt-0.5">Earned from coin wagers only</p>
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
                              <RakebackTierIcon tier="instant" size={17} />
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
                              <RakebackTierIcon tier="daily" size={17} />
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
                              <RakebackTierIcon tier="weekly" size={17} />
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
          <div className="md:hidden flex-1" />

          {/* Mobile: balance + rakeback (inline with right section) */}
          {profile && (
            <div className="md:hidden flex items-center gap-1.5 shrink-0">
              {/* Balance dropdown */}
              <div className="relative" ref={mobileCurrencyRef}>
                <button
                  onClick={() => setMobileCurrencyOpen(o => !o)}
                  className="flex items-center gap-0.5 px-2.5 py-1 bg-black border border-primary/30 rounded-full font-bold text-white transition-all"
                  style={{ fontSize: 13 }}
                >
                  <span className="font-mono">{isDiamonds ? fmtDiamonds(profile.diamonds) : fmtCoins(profile.c_coins)}</span>
                  {isDiamonds ? <DiamondIcon /> : <CoinIcon size="0.9em" />}
                  <span className="text-muted" style={{ fontSize: 10 }}>▾</span>
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
                        <DiamondIcon />
                        <div className="flex flex-col items-start min-w-0">
                          <span className="font-medium">Diamonds</span>
                          <span className="font-mono font-bold text-white leading-tight">{fmtDiamonds(profile.diamonds)}</span>
                        </div>
                      </button>
                    </div>
                    <div className="border-t border-border p-1.5">
                      {/* Matches the desktop dropdown above — same solid
                          primary button, no arrow. */}
                      <Link to="/wallet" onClick={() => setMobileCurrencyOpen(false)}
                        className="block w-full text-center text-xs font-bold px-3 py-2 rounded-lg bg-primary hover:bg-blue-500 text-white transition-all">
                        Wallet
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
                  <UiIcon name="rakeback" size={19} />
                </button>
                {mobileRakebackOpen && (
                  <div className="absolute top-full mt-2 right-0 bg-surface border border-border rounded-xl shadow-glow-lg z-[200] overflow-hidden" style={{ minWidth: 'min(280px, calc(100vw - 32px))', right: -8 }}>
                    <div className="px-4 py-3 border-b border-border">
                      <span className="text-sm font-bold text-white flex items-center gap-1.5"><UiIcon name="rakeback" size={15} />Rakeback</span>
                      <p className="text-[0.625rem] text-muted mt-0.5">Earned from coin wagers only</p>
                    </div>
                    {rakebackLoading ? (
                      <div className="px-4 py-4 text-xs text-muted text-center">Loading...</div>
                    ) : !rakebackData ? (
                      <div className="px-4 py-4 text-xs text-muted text-center">Unavailable</div>
                    ) : (
                      <div className="p-3 space-y-2">
                        {[
                          { key: 'instant', label: 'Instant', amount: rakebackData.instant ?? 0, claimable: rakebackData.instantClaimable ?? false, countdown: rakebackCountdowns.instant },
                          { key: 'daily',   label: 'Daily',   amount: rakebackData.daily   ?? 0, claimable: rakebackData.dailyClaimable,             countdown: rakebackCountdowns.daily },
                          { key: 'weekly',  label: 'Weekly',  amount: rakebackData.weekly  ?? 0, claimable: rakebackData.weeklyClaimable,             countdown: rakebackCountdowns.weekly },
                        ].map(({ key, label, claimable, countdown }) => (
                          <div key={key} className="rounded-xl border border-border bg-bg p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <RakebackTierIcon tier={key} size={17} />
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

          {/* The account, top right.
              A phone puts the account in the right-hand corner — it was on the
              left where the hamburger used to be, which is where a MENU lives,
              not a person. The bottom bar carries everything that menu held, so
              this slot is free for the one thing the bar does not. Sign out
              lives on the profile page. */}
          {/* Only when signed in. Signed out, the corner already holds Login
              and Sign up, and an avatar-shaped third way to reach the same
              place just crowds them — it rendered mid-bar, between the balance
              slot and those buttons, which is not a corner at all. */}
          {profile && (
            <Link
              to="/profile"
              className="md:hidden relative z-10 shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-white hover:bg-surfaceLight transition-colors"
              style={{ touchAction: 'manipulation' }}
              aria-label="Your profile"
            >
              {/* Rank and streak ride the avatar here exactly as they do on
                  desktop. They were dropped when the account moved to this
                  corner, which quietly made rank and a running streak
                  desktop-only features — on the client most people actually
                  use. Smaller, because the corner is 36px and a badge that
                  overhangs the screen edge is a badge nobody can read. */}
              <div className="relative">
                <Avatar username={profile.username} avatarUrl={profile.avatar_url}
                        color={profile.profile_color} className="w-8 h-8" textClassName="text-xs" />
                <span className="absolute -bottom-0.5 -right-0.5 leading-none" title={getDisplayRank(profile).name}>
                  <RankIcon rank={getDisplayRank(profile)} size={13} />
                </span>
                {(profile.current_streak ?? 0) >= 1 && (
                  <span className="absolute -top-1 -left-1 flex items-center justify-center min-w-[13px] h-[13px] rounded-full text-[0.5rem] font-black leading-none px-0.5"
                    style={{ background: 'rgba(0,0,0,0.85)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.4)', textShadow: '0 0 6px rgba(251,146,60,0.6)' }}>
                    🔥{profile.current_streak}
                  </span>
                )}
              </div>
            </Link>
          )}

          {/* Right — avatar + sign out / auth */}
          <div className="lg:w-64 lg:shrink-0 flex items-center justify-end gap-2 shrink-0">
            {profile ? (
              <>
                {profile.is_admin && (
                  <Link to="/admin" className="hidden md:block text-xs font-bold px-2 py-1 rounded-lg text-muted/50 hover:text-primary hover:bg-primary/10 transition-colors">
                    ⚙
                  </Link>
                )}
                {/* Desktop only. On a phone the account is the avatar on the
                    left, where the hamburger used to be — two pictures of the
                    same person in one bar is one of them being ignored. */}
                <Link to="/profile" className="hidden md:flex items-center gap-2 group">
                  <div className="relative">
                    <Avatar
                      username={profile.username}
                      avatarUrl={profile.avatar_url}
                      color={profile.profile_color}
                      className="w-8 h-8 lg:w-10 lg:h-10"
                      textClassName="text-xs lg:text-sm"
                    />
                    <span className="absolute -bottom-1 -right-1 leading-none" title={getDisplayRank(profile).name}>
                      <RankIcon rank={getDisplayRank(profile)} size={15} />
                    </span>
                    {(profile.current_streak ?? 0) >= 1 && (
                      <span className="absolute -top-0.5 -left-0.5 flex items-center justify-center min-w-[14px] h-[14px] rounded-full text-[0.5rem] font-black leading-none px-0.5"
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
                <button onClick={handleSignOut} className="hidden md:block text-sm font-medium px-3 py-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors whitespace-nowrap shrink-0">
                  Sign out
                </button>
              </>
            ) : session ? (
              // Session exists but profile still loading — show a placeholder so
              // we never flash "Sign in" for an authenticated user.
              <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-full bg-primary/20 animate-pulse" />
            ) : (
              <>
                {/* Shown at every width now — mobile only had Sign up before,
                    with Login hidden until sm. */}
                <Link to="/login" className="text-sm text-muted hover:text-white transition-colors whitespace-nowrap">Login</Link>
                <Link to="/signup" className="text-sm font-semibold px-3 py-1.5 bg-primary rounded-lg text-white hover:bg-blue-500 shadow-glow transition-all whitespace-nowrap">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      {/* The full-screen mobile menu is gone with the hamburger that opened
          it. Its destinations are the bottom bar now, and the account section
          it also held is the avatar in this bar. */}
    </>
  );
}

