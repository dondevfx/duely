import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { api } from '../utils/api';
import { fmtCoins, fmtExact } from '../utils/format';
import { supabase } from '../utils/supabase';
import QRCode from 'react-qr-code';
import GlowButton from '../components/GlowButton';
import { getRank } from '../utils/ranks';
import { usePageReady } from '../hooks/usePageReady';
import CoinIcon from '../components/CoinIcon';
import { ProfilePopup } from '../components/ChatSidebar';
import FriendInviteBox from '../components/FriendInviteBox';
import { isMuted, setMuted, playMatchFound } from '../utils/sound';

// Keyed by the game_type stored on MATCHES. The personal-best table uses its own
// keys, which do not all agree — Word VS records matches as 'scrabble' but high
// scores as 'wordVS' — so `bestKey` bridges the two where they differ. Rush Hour
// was simply absent from this map, which is why it never appeared at all.
const GAME_INFO = {
  scrabble:      { emoji: '🔤', name: 'Word VS',     bestKey: 'wordVS' },
  blockBlast:    { emoji: '🟦', name: 'Block Burst' },
  // timeKey: a companion best stored as its own game_type row. Rush Hour records
  // the survival time of the same run that set the score (see
  // highscoreService.updateHighscorePair), so the two always describe one run.
  carDash:       { emoji: '🚗', name: 'Rush Hour', timeKey: 'carDashMs' },
  tower:         { emoji: '🗼', name: 'Tower' },
  blackjack:     { emoji: '🃏', name: 'Blackjack' },
  coin_flip:     { emoji: '🟡', name: 'Coin Flip' },
};

// Games with a meaningful personal best. Without a label the best is not shown,
// so a missing entry here silently hides a score that is being recorded.
const HIGHSCORE_LABELS = {
  blockBlast: 'Score',
  scrabble:   'Score',
  carDash:    'Score',
  tower:      'Blocks',
};

const SOLO_GAME_TYPES = new Set(['blockBlast']);


// Survival time for a Rush Hour best, stored in ms. Runs are short, so seconds
// stay readable to one decimal; minutes only appear once they exist.
function fmtAlive(ms) {
  // Round to tenths BEFORE choosing a format, or 59.999s takes the seconds
  // branch and then rounds up to a nonsensical "60.0s".
  const s = Math.round((Number(ms) || 0) / 100) / 10;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(1)}s`;
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch (German)' },
  { code: 'zh', label: '中文 (Chinese)' },
  { code: 'ru', label: 'Русский (Russian)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'it', label: 'Italiano (Italian)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'fi', label: 'Suomi (Finnish)' },
];

const GOOGLE_LANG = { de: 'de', zh: 'zh-CN', ru: 'ru', es: 'es', it: 'it', ja: 'ja', fi: 'fi' };

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Affiliate code application card ───────────────────────────────────────────
function AffiliateCodeCard() {
  const [status, setStatus]   = useState(null);  // { appliedCode, appliedExpiresAt }
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg]         = useState(null);

  useEffect(() => {
    api.get('/affiliate/status')
      .then(d => setStatus(d))
      .catch(() => {});
  }, []);

  async function applyCode() {
    const code = input.trim().toUpperCase();
    if (!code) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await api.post('/affiliate/apply-code', { code });
      setStatus(s => ({ ...s, appliedCode: res.code, appliedExpiresAt: res.expiresAt }));
      setInput('');
      setMsg({ type: 'success', text: `Applied! Code is active for 30 days.` });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function removeCode() {
    await api.delete('/affiliate/apply-code').catch(() => {});
    setStatus(s => ({ ...s, appliedCode: null, appliedExpiresAt: null }));
    setMsg(null);
  }

  return (
    <div className="bg-surface border border-surfaceLight rounded-2xl p-5 mb-6">
      <div className="text-sm font-bold text-white mb-3">🔗 Affiliate Code</div>

      {status?.appliedCode ? (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs bg-success/10 text-success border border-success/30 px-2 py-0.5 rounded-full font-bold">Applied ✓</span>
            <span className="font-mono text-sm font-bold text-white">{status.appliedCode}</span>
          </div>
          <p className="text-xs text-muted mb-3">
            Active until {status.appliedExpiresAt ? new Date(status.appliedExpiresAt).toLocaleDateString() : '?'}
          </p>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))}
              placeholder="Enter new code to change"
              className="flex-1 bg-bg border border-surfaceLight rounded-lg px-3 py-2 text-xs text-white font-mono uppercase placeholder-muted focus:outline-none focus:border-primary"
            />
            <button
              onClick={applyCode}
              disabled={loading || !input.trim()}
              className="px-3 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              Change
            </button>
            <button
              onClick={removeCode}
              className="px-3 py-2 border border-surfaceLight text-muted text-xs rounded-lg hover:text-white hover:border-danger transition-colors"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-xs text-muted mb-3">Enter a user's affiliate code to support them.</p>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))}
              placeholder="ENTER HERE"
              className="flex-1 bg-bg border border-surfaceLight rounded-lg px-3 py-2 text-xs text-white font-mono uppercase placeholder-muted focus:outline-none focus:border-primary"
              onKeyDown={e => e.key === 'Enter' && applyCode()}
            />
            <button
              onClick={applyCode}
              disabled={loading || !input.trim()}
              className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {loading ? '...' : 'Apply'}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className={`text-xs mt-2 font-medium ${msg.type === 'success' ? 'text-success' : 'text-danger'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

function MatchRow({ match, myId }) {
  const isWinner  = match.winner_id === myId;
  // Read, not inferred. This used to be guessed from early_click and
  // reaction_time_ms — columns only the reaction game fills in — so every
  // staked match on every other game looked like a forfeit, bot matches
  // included. A bot does not disconnect.
  //
  // Strict true: on an older backend the field is absent, and undefined must
  // mean "no label" rather than an accidental one.
  const isForfeit = match.ended_by_forfeit === true;
  const opponent  = match.player1_id === myId ? match.player2 : match.player1;
  const opponentId = match.player1_id === myId ? match.player2_id : match.player1_id;

  // Determine opponent display name
  let opponentName;
  if (opponent?.username) {
    opponentName = opponent.username;
  } else if (!opponentId) {
    opponentName = SOLO_GAME_TYPES.has(match.game_type) ? 'Solo' : 'Bot';
  } else {
    opponentName = 'Unknown';
  }

  // Determine currency and payout
  const isDiamonds = (match.entry_fee_diamonds ?? 0) > 0;
  let payout = null;
  if (isDiamonds) {
    const fee = match.entry_fee_diamonds ?? 0;
    if (fee > 0) {
      payout = isWinner
        ? { amount: fee * 2, currency: '💎' }
        : { amount: -fee, currency: '💎' };
    }
  } else {
    const pool = match.prize_pool_c ?? 0;
    const fee  = match.entry_fee_c ?? 0;
    if (pool > 0 || fee > 0) {
      payout = isWinner
        ? { amount: parseFloat((pool * 0.95).toFixed(4)), currency: 'coins' }
        : { amount: -parseFloat(Number(fee).toFixed(4)), currency: 'coins' };
    }
  }

  const gameInfo = GAME_INFO[match.game_type];

  return (
    <div className="flex items-center justify-between py-3 border-b border-surfaceLight/50 last:border-0">
      <div className="flex items-center gap-3">
        <span className={`text-xs font-black px-2 py-0.5 rounded-full border ${
          isWinner
            ? 'bg-success/10 text-success border-success/30'
            : 'bg-danger/10 text-danger border-danger/30'
        }`}>
          {isWinner ? 'WIN' : 'LOSS'}
        </span>
        <div>
          <div className="text-sm text-white font-medium">
            {gameInfo && <span className="text-xs text-muted mr-1.5">{gameInfo.emoji} {gameInfo.name} ·</span>}
            vs <span className="text-accent">{opponentName}</span>
          </div>
          {isForfeit && <div className="text-xs text-warning">Opponent disconnected</div>}
          {match.early_click && <div className="text-xs text-warning">Early click</div>}
        </div>
      </div>
      <div className="text-right">
        {payout !== null ? (
          <div className={`text-sm font-bold ${payout.amount >= 0 ? 'text-success' : 'text-danger'}`}>
            {payout.amount >= 0 ? '+' : '-'}
            {isDiamonds
              ? `${Math.abs(payout.amount).toLocaleString()} ${payout.currency}`
              : <span className="inline-flex items-center gap-0.5">{fmt(Math.abs(payout.amount))} <CoinIcon size="0.8em" /></span>
            }
          </div>
        ) : (
          <div className="text-xs text-muted">Free match</div>
        )}
        <div className="flex items-center gap-2 justify-end mt-0.5">
          {match.reaction_time_ms && isWinner && (
            <span className="text-xs text-muted font-mono">{match.reaction_time_ms}ms</span>
          )}
          <span className="text-xs text-muted">{new Date(match.played_at).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────
function SettingsPanel({ onClose, profile, refreshProfile, session, resetMsg, setResetMsg, sendPasswordReset }) {
  const [theme, setThemeState]   = useState(() => localStorage.getItem('theme') || 'dark');
  const [language, setLangState] = useState(() => localStorage.getItem('language') || 'en');
  const [soundOn, setSoundOn]    = useState(() => !isMuted());
  const [showLang, setShowLang]  = useState(false);
  const [isPrivate, setIsPrivate]   = useState(profile?.is_private || false);
  const [invitesEnabled, setInvitesEnabled] = useState(profile?.invites_enabled !== false);
  const [savingInvites, setSavingInvites] = useState(false);
  const [savingPrivate, setSavingPrivate] = useState(false);
  const panelRef = useRef(null);

  // Affiliate state
  const [affStatus, setAffStatus]   = useState(null);
  const [affCodeInput, setAffCodeInput] = useState('');
  const [savingAff, setSavingAff]   = useState(false);
  const [affMsg, setAffMsg]         = useState(null);
  const [changingAff, setChangingAff] = useState(false);
  const [collectingEarnings, setCollectingEarnings] = useState(false);

  useEffect(() => {
    api.get('/affiliate/status').then(setAffStatus).catch(() => {});
  }, []);

  async function setMyAffCode() {
    const code = affCodeInput.trim().toUpperCase();
    if (!code) return;
    setSavingAff(true);
    setAffMsg(null);
    try {
      const res = await api.post('/affiliate/set-code', { code });
      setAffStatus(s => ({ ...s, myCode: res.code }));
      setAffCodeInput('');
      setChangingAff(false);
      setAffMsg({ type: 'success', text: `Code set to ${res.code}` });
    } catch (err) {
      setAffMsg({ type: 'error', text: err.message });
    } finally {
      setSavingAff(false);
    }
  }

  async function collectEarnings() {
    setCollectingEarnings(true);
    setAffMsg(null);
    try {
      const res = await api.post('/affiliate/collect-earnings');
      setAffStatus(s => ({ ...s, earnings_c: 0 }));
      setAffMsg({ type: 'success', text: `Collected ${res.collected_c.toFixed(2)} coins!` });
      refreshProfile();
    } catch (err) {
      setAffMsg({ type: 'error', text: err.message });
    } finally {
      setCollectingEarnings(false);
    }
  }

  function applyTheme(t) {
    if (t === 'light') document.documentElement.classList.add('light');
    else document.documentElement.classList.remove('light');
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    localStorage.setItem('theme', next);
    applyTheme(next);
  }

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    setMuted(!next);
    if (next) playMatchFound(); // preview so the user hears it's on
  }

  function selectLanguage(code) {
    setLangState(code);
    localStorage.setItem('language', code);
    setShowLang(false);
    const googleCode = GOOGLE_LANG[code];
    const expire = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    if (googleCode) {
      document.cookie = `googtrans=/en/${googleCode}; path=/`;
      document.cookie = `googtrans=/en/${googleCode}; path=/; domain=${window.location.hostname}`;
    } else {
      // Restore English — clear the translation cookie
      document.cookie = `googtrans=; path=/; ${expire}`;
      document.cookie = `googtrans=; path=/; domain=${window.location.hostname}; ${expire}`;
    }
    window.location.reload();
  }

  async function togglePrivate() {
    const next = !isPrivate;
    setIsPrivate(next);
    setSavingPrivate(true);
    try {
      await api.patch('/auth/me', { is_private: next });
      await refreshProfile();
    } catch {
      setIsPrivate(!next);
    } finally {
      setSavingPrivate(false);
    }
  }

  async function toggleInvites() {
    const next = !invitesEnabled;
    setInvitesEnabled(next);
    setSavingInvites(true);
    try {
      await api.patch('/auth/me', { invites_enabled: next });
      await refreshProfile();
    } catch {
      setInvitesEnabled(!next);
    } finally {
      setSavingInvites(false);
    }
  }

  const langLabel = LANGUAGES.find(l => l.code === language)?.label || 'English';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        className="fixed top-0 right-0 h-full w-full max-w-sm z-50 bg-surface border-l border-surfaceLight shadow-2xl overflow-y-auto"
        style={{ animation: 'slideInRight 0.3s ease-out' }}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-black text-white">Settings</h2>
            <button onClick={onClose} className="text-muted hover:text-white text-xl leading-none">✕</button>
          </div>

          {/* Theme */}
          <div className="mb-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-white">Appearance</div>
                <div className="text-xs text-muted">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</div>
              </div>
              <button
                onClick={toggleTheme}
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${theme === 'light' ? 'bg-primary' : 'bg-surfaceLight border border-border'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${theme === 'light' ? 'translate-x-6' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Sound effects */}
          <div className="mb-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-white">Sound effects</div>
                <div className="text-xs text-muted">{soundOn ? 'On — win, loss & game sounds' : 'Muted'}</div>
              </div>
              <button
                onClick={toggleSound}
                aria-label="Toggle sound effects"
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${soundOn ? 'bg-primary' : 'bg-surfaceLight border border-border'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${soundOn ? 'translate-x-6' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>

          <div className="h-px bg-surfaceLight mb-5" />

          {/* Language */}
          <div className="mb-5">
            <div className="text-sm font-bold text-white mb-2">Language</div>
            <div className="relative">
              <button
                onClick={() => setShowLang(v => !v)}
                className="w-full flex items-center justify-between px-4 py-3 bg-bg border border-surfaceLight rounded-xl text-sm text-white hover:border-primary transition-colors"
              >
                <span>{langLabel}</span>
                <span className="text-muted">{showLang ? '▲' : '▼'}</span>
              </button>
              {showLang && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-surfaceLight rounded-xl shadow-2xl z-10 overflow-hidden">
                  {LANGUAGES.map(l => (
                    <button
                      key={l.code}
                      onClick={() => selectLanguage(l.code)}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-surfaceLight ${l.code === language ? 'text-primary font-bold' : 'text-white'}`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="h-px bg-surfaceLight mb-5" />

          <div className="h-px bg-surfaceLight mb-5" />

          {/* Private account */}
          <div className="mb-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-white">Private Account</div>
                <div className="text-xs text-muted">Hide from leaderboard &amp; match history</div>
              </div>
              <button
                onClick={togglePrivate}
                disabled={savingPrivate}
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 ${isPrivate ? 'bg-primary' : 'bg-surfaceLight border border-border'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${isPrivate ? 'translate-x-6' : 'translate-x-0.5'}`} />
              </button>
            </div>
            {isPrivate && <p className="text-xs text-warning mt-1">You are invisible on leaderboards. You can still receive tips.</p>}
          </div>

          <div className="h-px bg-surfaceLight mb-5" />

          {/* Game invites */}
          <div className="mb-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-white">Game Invites</div>
                <div className="text-xs text-muted">Let friends invite you to private matches</div>
              </div>
              <button
                onClick={toggleInvites}
                disabled={savingInvites}
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 ${invitesEnabled ? 'bg-primary' : 'bg-surfaceLight border border-border'}`}
              >
                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${invitesEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
              </button>
            </div>
            {!invitesEnabled && <p className="text-xs text-warning mt-1">Friends can't invite you to games right now.</p>}
          </div>

          <div className="h-px bg-surfaceLight mb-5" />

          {/* Affiliate code (my own) */}
          <div className="mb-5">
            <div className="text-sm font-bold text-white mb-2">🔗 Your Affiliate Code</div>

            {affStatus?.myCode && !changingAff ? (
              <div>
                <div className="bg-bg border border-surfaceLight rounded-xl p-4 mb-3">
                  <div className="text-xs text-muted mb-1">Your code</div>
                  <div className="font-mono text-xl font-black text-primary tracking-widest mb-3">
                    {affStatus.myCode}
                  </div>
                  <div className="flex flex-col items-center mb-3">
                    <div className="text-sm font-black text-success">+{fmt(affStatus.earnings_c)} coins</div>
                    <div className="text-[10px] text-muted">Coin earnings</div>
                  </div>
                  {(affStatus.earnings_c > 0 || affStatus.earnings_diamonds > 0) ? (
                    <button
                      onClick={collectEarnings}
                      disabled={collectingEarnings}
                      className="w-full py-2 bg-success text-white text-xs font-bold rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors"
                    >
                      {collectingEarnings ? 'Collecting...' : 'Collect Earnings'}
                    </button>
                  ) : (
                    <p className="text-[10px] text-muted text-center">No earnings to collect yet</p>
                  )}
                </div>
                <button
                  onClick={() => setChangingAff(true)}
                  className="text-xs text-muted hover:text-white border border-surfaceLight hover:border-primary rounded-lg px-3 py-1.5 transition-all mt-3"
                >
                  Change code
                </button>
                <p className="text-[10px] text-muted mt-1">Changing your code deactivates the old one.</p>
              </div>
            ) : (
              <div>
                <p className="text-xs text-muted mb-2">
                  {changingAff ? 'Enter a new code (old code stops working immediately):' : 'Create a code — earn 0.5% of match fees from players who use it.'}
                </p>
                <div className="flex gap-2">
                  <input
                    value={affCodeInput}
                    onChange={e => setAffCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))}
                    placeholder="e.g. MYCODE42"
                    className="flex-1 bg-bg border border-surfaceLight rounded-lg px-3 py-2 text-sm font-mono uppercase text-white placeholder-muted focus:outline-none focus:border-primary"
                  />
                  <button
                    onClick={setMyAffCode}
                    disabled={savingAff || !affCodeInput.trim()}
                    className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
                  >
                    {savingAff ? '...' : changingAff ? 'Update' : 'Create'}
                  </button>
                  {changingAff && (
                    <button
                      onClick={() => { setChangingAff(false); setAffCodeInput(''); }}
                      className="px-3 py-2 border border-surfaceLight text-muted text-xs rounded-lg hover:text-white"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-muted mt-1">4–12 letters/numbers, uppercase.</p>
              </div>
            )}
            {affMsg && (
              <p className={`text-xs mt-2 ${affMsg.type === 'success' ? 'text-success' : 'text-danger'}`}>
                {affMsg.text}
              </p>
            )}
          </div>

          <div className="h-px bg-surfaceLight mb-5" />

          {/* 2FA */}
          <TwoFactorSection />

          <div className="h-px bg-surfaceLight mb-5" />

          {/* Reset password */}
          <div className="mb-3">
            <div className="text-sm font-bold text-white mb-2">🔑 Password</div>
            <button
              onClick={sendPasswordReset}
              className="w-full py-2.5 text-sm font-semibold text-muted border border-surfaceLight hover:border-primary hover:text-white rounded-xl transition-all"
            >
              Reset Password
            </button>
            {resetMsg && <p className="text-success text-xs mt-2">{resetMsg}</p>}
          </div>
        </div>
      </div>
    </>
  );
}

function TwoFactorSection() {
  const [factors, setFactors]       = useState(null); // null=loading
  const [step, setStep]             = useState('idle'); // idle | enrolling | disabling
  const [enrollData, setEnrollData] = useState(null);
  const [code, setCode]             = useState('');
  const [error, setError]           = useState(null);
  const [busy, setBusy]             = useState(false);
  const [done, setDone]             = useState(null); // success message

  const loadFactors = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      setFactors(data?.totp ?? []);
    } catch {
      setFactors([]);
    }
  }, []);

  useEffect(() => { loadFactors(); }, [loadFactors]);

  const activeFactor = factors?.find(f => f.status === 'verified');

  async function startEnroll() {
    setBusy(true); setError(null); setDone(null);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;
      setEnrollData(data);
      setStep('enrolling');
      setCode('');
    } catch (e) {
      setError(e.message || 'Failed to start 2FA setup. Make sure MFA is enabled in your Supabase project settings.');
    }
    finally { setBusy(false); }
  }

  async function confirmEnroll() {
    if (code.length !== 6) return;
    setBusy(true); setError(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrollData.id, code });
      if (error) throw error;
      await loadFactors();
      setStep('idle'); setEnrollData(null); setCode('');
      setDone('2FA enabled successfully!');
      setTimeout(() => setDone(null), 3000);
    } catch (e) { setError(e.message || 'Invalid code. Try again.'); }
    finally { setBusy(false); }
  }

  async function confirmDisable() {
    if (code.length !== 6) return;
    setBusy(true); setError(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: activeFactor.id, code });
      if (error) throw error;
      const { error: ue } = await supabase.auth.mfa.unenroll({ factorId: activeFactor.id });
      if (ue) throw ue;
      await loadFactors();
      setStep('idle'); setCode('');
      setDone('2FA disabled.');
      setTimeout(() => setDone(null), 3000);
    } catch (e) { setError(e.message || 'Invalid code. Try again.'); }
    finally { setBusy(false); }
  }

  function cancelStep() { setStep('idle'); setCode(''); setError(null); setEnrollData(null); }

  const inputClass = 'w-full bg-bg border border-surfaceLight rounded-lg px-3 py-2.5 text-white text-center text-xl font-mono tracking-[0.4em] placeholder-muted focus:outline-none focus:border-primary';

  return (
    <div className="mb-5">
      <div className="text-sm font-bold text-white mb-2">🔐 Two-Factor Authentication</div>

      {factors === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : step === 'idle' ? (
        <div>
          {activeFactor ? (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-success text-sm">✓</span>
                <span className="text-sm text-success font-semibold">2FA is enabled</span>
              </div>
              <p className="text-xs text-muted mb-3">Your account is protected with an authenticator app.</p>
              <button
                onClick={() => { setStep('disabling'); setCode(''); setError(null); }}
                className="text-xs text-danger border border-danger/30 hover:border-danger rounded-lg px-3 py-1.5 transition-all"
              >
                Disable 2FA
              </button>
            </div>
          ) : (
            <div>
              <p className="text-xs text-muted mb-3">Add an extra layer of security. You'll need Google Authenticator or Authy.</p>
              <button
                onClick={startEnroll}
                disabled={busy}
                className="w-full py-2.5 text-sm font-semibold text-primary border border-primary/40 hover:border-primary hover:bg-primary/10 rounded-xl transition-all disabled:opacity-50"
              >
                {busy ? 'Setting up…' : 'Enable 2FA'}
              </button>
            </div>
          )}
          {done  && <p className="text-xs text-success mt-2">{done}</p>}
          {error && <p className="text-xs text-danger  mt-2">{error}</p>}
        </div>
      ) : step === 'enrolling' ? (
        <div>
          <p className="text-xs text-muted mb-3">Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.</p>
          {enrollData?.totp?.secret && (
            <div className="flex justify-center mb-3">
              <div className="bg-white p-3 rounded-xl inline-block">
                <QRCode
                  value={`otpauth://totp/Duely?secret=${enrollData.totp.secret}&issuer=Duely`}
                  size={160}
                />
              </div>
            </div>
          )}
          {enrollData?.totp?.secret && (
            <div className="bg-bg border border-surfaceLight rounded-lg px-3 py-2 mb-3 text-center">
              <div className="text-[10px] text-muted mb-0.5">Manual entry key</div>
              <div className="font-mono text-xs text-primary break-all">{enrollData.totp.secret}</div>
            </div>
          )}
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
            placeholder="000000"
            autoFocus
            className={inputClass}
          />
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <GlowButton variant="primary" size="sm" className="flex-1" onClick={confirmEnroll} disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Confirm'}
            </GlowButton>
            <button onClick={cancelStep} className="px-4 py-2 text-xs text-muted border border-surfaceLight rounded-lg hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        </div>
      ) : step === 'disabling' ? (
        <div>
          <p className="text-xs text-muted mb-3">Enter your current authenticator code to disable 2FA.</p>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
            placeholder="000000"
            autoFocus
            className={inputClass}
          />
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
          <div className="flex gap-2 mt-3">
            <button
              onClick={confirmDisable}
              disabled={busy || code.length !== 6}
              className="flex-1 py-2 text-sm font-semibold text-danger border border-danger/40 hover:border-danger hover:bg-danger/10 rounded-xl transition-all disabled:opacity-50"
            >
              {busy ? 'Disabling…' : 'Confirm Disable'}
            </button>
            <button onClick={cancelStep} className="px-4 py-2 text-xs text-muted border border-surfaceLight rounded-lg hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Coin P&L Chart ─────────────────────────────────────────────────────────────
function fmtAxis(v) {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toFixed(0);
}

function fmtXDate(dateStr) {
  // Plain YYYY-MM-DD (legacy) vs full ISO timestamp (one point per transaction)
  const d = dateStr.length === 10 ? new Date(dateStr + 'T12:00:00') : new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtXDateTime(dateStr) {
  const d = dateStr.length === 10 ? new Date(dateStr + 'T12:00:00') : new Date(dateStr);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ProfileLineChart({ data }) {
  const wrapRef = useRef(null);
  const [svgW, setSvgW] = useState(560);
  const [tooltip, setTooltip] = useState(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([e]) => setSvgW(Math.floor(e.contentRect.width)));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (!data || data.length < 2) return <div ref={wrapRef} />;

  const H = 200, PL = 62, PR = 12, PT = 28, PB = 34;
  const w = svgW - PL - PR, h = H - PT - PB;

  const balances = data.map(d => d.balance);
  const minB = Math.min(...balances);
  const maxB = Math.max(...balances);
  const range = maxB - minB || 1;

  const xOf = i => PL + (i / (data.length - 1)) * w;
  const yOf = v => PT + h - ((v - minB) / range) * h;

  const pts   = data.map((d, i) => [xOf(i), yOf(d.balance)]);
  const lineD = 'M ' + pts.map(p => p.join(' ')).join(' L ');
  const areaD = `M ${PL} ${PT + h} L ` + pts.map(p => p.join(' ')).join(' L ') + ` L ${PL + w} ${PT + h} Z`;

  const isUp  = balances[balances.length - 1] >= balances[0];
  const color = isUp ? '#22c55e' : '#ef4444';

  const yTicks    = Array.from({ length: 5 }, (_, i) => minB + (range * i / 4));
  const xTickIdxs = [0, Math.round((data.length - 1) * 0.33), Math.round((data.length - 1) * 0.66), data.length - 1];
  const gradId    = `pg-${isUp ? 'up' : 'dn'}`;

  function handleMouseMove(e) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const relX   = Math.max(0, Math.min(1, (mouseX - PL) / w));
    const idx    = Math.round(relX * (data.length - 1));
    const d      = data[idx];
    setTooltip({ idx, dotX: xOf(idx), dotY: yOf(d.balance), date: d.date, balance: d.balance });
  }

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: H, cursor: 'crosshair' }}
      onMouseMove={handleMouseMove} onMouseLeave={() => setTooltip(null)}>
      <svg width={svgW} height={H}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PL} y1={yOf(v)} x2={PL + w} y2={yOf(v)}
              stroke="#1e293b" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '4,4'} />
            <text x={PL - 7} y={yOf(v)} textAnchor="end" dominantBaseline="middle"
              fontSize="11" fill="#475569" fontFamily="system-ui,sans-serif">
              {fmtAxis(v)}
            </text>
          </g>
        ))}

        {xTickIdxs.map(i => (
          <text key={i} x={xOf(i)} y={PT + h + 22} textAnchor="middle"
            fontSize="11" fill="#475569" fontFamily="system-ui,sans-serif">
            {fmtXDate(data[i].date)}
          </text>
        ))}

        <line x1={PL} y1={PT} x2={PL} y2={PT + h} stroke="#334155" strokeWidth="1.5" />

        <path d={areaD} fill={`url(#${gradId})`} />
        <path d={lineD} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />

        {tooltip && (
          <line x1={tooltip.dotX} y1={PT} x2={tooltip.dotX} y2={PT + h}
            stroke={color} strokeWidth="1" strokeDasharray="3,3" opacity="0.5" />
        )}
        {tooltip && (
          <circle cx={tooltip.dotX} cy={tooltip.dotY}
            r="5" fill={color} stroke="white" strokeWidth="2" />
        )}
      </svg>

      {tooltip && (
        <div style={{
          position: 'absolute',
          left: tooltip.dotX > svgW * 0.65 ? tooltip.dotX - 130 : tooltip.dotX + 14,
          top: Math.max(4, tooltip.dotY - 54),
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 8,
          padding: '6px 12px',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          zIndex: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>{fmtXDateTime(tooltip.date)}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: tooltip.balance >= 0 ? '#22c55e' : '#ef4444' }}>
            {tooltip.balance >= 0 ? '+' : ''}{tooltip.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} coins
          </div>
        </div>
      )}
    </div>
  );
}

const RANGE_OPTIONS = [
  { label: '7 Days',  days: 7  },
  { label: '30 Days', days: 30 },
  { label: '90 Days', days: 90 },
];

function CoinHistorySection({ userId }) {
  const [days, setDays]       = useState(90);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || !userId) return;
    setLoading(true);
    api.get(`/auth/coin-history/${userId}?days=${days}`)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [expanded, userId, days]);

  const netPnl = data && data.length > 0 ? data[data.length - 1].balance : null;

  return (
    <div className="bg-surface border border-surfaceLight rounded-2xl p-6 mb-6">
      <button onClick={() => setExpanded(v => !v)} className="w-full flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Coin P&amp;L</h2>
        <div className="flex items-center gap-3">
          {netPnl !== null && (
            <span className="text-sm font-bold" style={{ color: netPnl >= 0 ? '#22c55e' : '#ef4444' }}>
              {netPnl >= 0 ? '+' : ''}{netPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} coins
            </span>
          )}
          <span className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all ${
            expanded
              ? 'bg-primary/20 border-primary text-primary'
              : 'border-surfaceLight text-muted hover:border-primary hover:text-white'
          }`}>
            {expanded ? '▲ Hide' : '▼ Show'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-4">
          {/* Range selector */}
          <div className="flex gap-2 mb-4">
            {RANGE_OPTIONS.map(o => (
              <button
                key={o.days}
                onClick={() => setDays(o.days)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
                  days === o.days
                    ? 'bg-primary/20 border-primary text-primary'
                    : 'border-surfaceLight text-muted hover:border-primary hover:text-white'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center py-10">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : data && data.length > 1 ? (
            <div className="bg-bg rounded-xl px-2 pt-2 pb-1 overflow-hidden">
              <ProfileLineChart data={data} />
            </div>
          ) : (
            <p className="text-muted text-sm text-center py-6">No transaction data yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Friends Panel ─────────────────────────────────────────────────────────────

function FriendsPanel({ myId, myUsername, myReferralCode, activeGames }) {
  const navigate = useNavigate();
  const [friendships, setFriendships] = useState([]);
  const [addInput, setAddInput] = useState('');
  const [addMsg, setAddMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [confirmUnadd, setConfirmUnadd] = useState(null); // { id, username }
  const [viewingFriend, setViewingFriend] = useState(null); // { id, username }

  const load = useCallback(async () => {
    try { setFriendships(await api.get('/auth/friends')); } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  const accepted   = friendships.filter(f => f.status === 'accepted');
  const pendingIn  = friendships.filter(f => f.status === 'pending' && f.addressee?.id === myId);
  const pendingOut = friendships.filter(f => f.status === 'pending' && f.requester?.id === myId);

  function getFriend(f) { return f.requester?.id === myId ? f.addressee : f.requester; }
  function findGame(username) {
    return activeGames?.find(g => g.player1?.username === username || g.player2?.username === username);
  }

  async function sendRequest() {
    const name = addInput.trim();
    if (!name) return;
    setAdding(true); setAddMsg(null);
    try {
      await api.post('/auth/friend-request', { username: name });
      setAddMsg({ ok: true, text: `Request sent to ${name}!` });
      setAddInput('');
      load();
    } catch (err) {
      setAddMsg({ ok: false, text: err.message });
    } finally { setAdding(false); }
  }

  async function accept(id) { await api.post(`/auth/friend-accept/${id}`).catch(() => {}); load(); }
  async function remove(id) { await api.delete(`/auth/friend/${id}`).catch(() => {}); load(); }

  return (
    <>
    {/* Sticky only on desktop, where this is the floating right column. On
        mobile it sits in the page flow under the profile card, and sticking
        would pin it over the sections below as you scroll past. */}
    <div className="bg-surface border border-surfaceLight rounded-2xl p-5 lg:sticky lg:top-20">
      <div className="text-base font-black text-white mb-4">👥 Friends</div>

      {/* Friend Requests button */}
      <button
        onClick={() => setShowRequests(v => !v)}
        className={`w-full mb-3 flex items-center justify-between px-3 py-2 rounded-xl text-xs font-bold border transition-all ${
          showRequests
            ? 'bg-primary/15 text-primary border-primary/30'
            : 'bg-surfaceLight text-muted border-border hover:text-white hover:border-surfaceLight'
        }`}
      >
        <span>Friend Requests</span>
        {pendingIn.length > 0 && (
          <span className="w-5 h-5 rounded-full bg-primary text-white text-[9px] flex items-center justify-center font-black leading-none">
            {pendingIn.length}
          </span>
        )}
      </button>

      {/* Requests panel — pops up directly under the Friend Requests button */}
      {showRequests && (
        <div className="mb-3 bg-bg rounded-xl p-3">
          {pendingIn.length === 0 ? (
            <p className="text-xs text-muted text-center py-2">No pending requests</p>
          ) : pendingIn.map(f => {
            const p = f.requester;
            return (
              <div key={f.id} className="flex items-center gap-2 mb-2 last:mb-0">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black shrink-0"
                  style={{ backgroundColor: `${p?.profile_color || '#1250B4'}22`, border: `1.5px solid ${p?.profile_color || '#1250B4'}`, color: p?.profile_color || '#1250B4' }}>
                  {(p?.username || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white truncate">{p?.username}</div>
                  <div className="text-[10px] text-muted">{p?.elo} ELO</div>
                </div>
                <button onClick={() => accept(f.id)} className="text-[10px] px-2 py-1 bg-success/15 text-success border border-success/30 rounded-lg hover:bg-success/25 transition-all">✓</button>
                <button onClick={() => remove(f.id)} className="text-[10px] px-2 py-1 bg-danger/15 text-danger border border-danger/30 rounded-lg hover:bg-danger/25 transition-all">✕</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add friend by username */}
      <div className="flex gap-2 mb-3 overflow-hidden">
        <input
          value={addInput}
          onChange={e => setAddInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendRequest()}
          placeholder="Search by username…"
          maxLength={20}
          className="flex-1 min-w-0 bg-bg border border-surfaceLight rounded-xl px-3 py-2 text-xs text-white placeholder-muted focus:outline-none focus:border-primary"
        />
        <button
          onClick={sendRequest}
          disabled={adding || !addInput.trim()}
          className="shrink-0 px-3 py-2 bg-primary text-white text-xs font-bold rounded-xl hover:bg-blue-500 disabled:opacity-40 transition-all"
        >
          {adding ? '…' : 'Add'}
        </button>
      </div>
      {addMsg && (
        <p className={`text-xs mb-3 font-medium ${addMsg.ok ? 'text-success' : 'text-danger'}`}>{addMsg.text}</p>
      )}

      {/* Friends list */}
      {accepted.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] text-muted font-bold uppercase tracking-wider mb-2">{accepted.length} Friend{accepted.length !== 1 ? 's' : ''}</div>
          {accepted.map(f => {
            const p = getFriend(f);
            const game = findGame(p?.username);
            return (
              <div key={f.id} className="flex items-center gap-2 group">
                <button
                  className="relative shrink-0 cursor-pointer"
                  onClick={() => setViewingFriend({ id: p?.id, username: p?.username })}
                >
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-black hover:ring-2 hover:ring-primary/50 transition-all"
                    style={{ backgroundColor: `${p?.profile_color || '#1250B4'}22`, border: `1.5px solid ${p?.profile_color || '#1250B4'}`, color: p?.profile_color || '#1250B4' }}>
                    {(p?.username || '?')[0].toUpperCase()}
                  </div>
                  {game && <div className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 animate-pulse border border-bg" />}
                </button>
                <button
                  className="flex-1 min-w-0 text-left cursor-pointer"
                  onClick={() => setViewingFriend({ id: p?.id, username: p?.username })}
                >
                  <div className="text-xs font-bold text-white truncate hover:text-primary transition-colors">{p?.username}</div>
                  <div className="text-[10px] text-muted">{p?.elo} ELO{game ? ' · In game' : ''}</div>
                </button>
                <div className="flex gap-1 items-center">
                  {game && (
                    <button
                      onClick={() => navigate(`/spectate/${game.id}`, { state: { from: '/profile' } })}
                      className="text-[10px] px-2 py-1 bg-red-500/15 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/25 transition-all font-bold"
                    >
                      ▶ Live
                    </button>
                  )}
                  <button
                    onClick={() => setConfirmUnadd({ id: f.id, username: p?.username })}
                    // 10px text, a 2px pad and opacity-0 until hover. On a
                    // touch screen there is no hover, so it was invisible AND
                    // barely a target; on desktop it was a 10px word. Always
                    // visible now, with a real 44px-ish hit area.
                    className="text-xs font-bold px-3 py-2 min-h-[38px] text-muted hover:text-danger border border-surfaceLight hover:border-danger/40 rounded-lg transition-all"
                  >
                    Unadd
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {accepted.length === 0 && pendingIn.length === 0 && (
        <p className="text-xs text-muted text-center py-4">No friends yet. Add someone!</p>
      )}

      {/* Sent requests */}
      {pendingOut.length > 0 && (
        <div className="mt-4 pt-4 border-t border-surfaceLight">
          <div className="text-[10px] text-muted font-bold uppercase tracking-wider mb-2">Sent</div>
          {pendingOut.map(f => (
            <div key={f.id} className="flex items-center gap-2 mb-1.5">
              <div className="text-xs text-muted flex-1 truncate">{f.addressee?.username}</div>
              <span className="text-[10px] text-muted/50 italic">Pending</span>
              <button onClick={() => remove(f.id)} className="text-[10px] text-muted hover:text-danger transition-colors">✕</button>
            </div>
          ))}
        </div>
      )}

      <FriendInviteBox username={myUsername} referralCode={myReferralCode} />
    </div>

    {/* Unadd confirmation modal */}
      {confirmUnadd && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setConfirmUnadd(null)}>
          <div className="bg-surface border border-surfaceLight rounded-2xl w-80 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            <div className="text-base font-black text-white mb-1">Unadd friend?</div>
            <div className="text-sm text-muted mb-5">Remove <span className="text-white font-bold">{confirmUnadd.username}</span> from your friends list.</div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmUnadd(null)} className="px-4 py-2 text-sm text-muted hover:text-white border border-surfaceLight rounded-xl transition-all">Cancel</button>
              <button
                onClick={() => { remove(confirmUnadd.id); setConfirmUnadd(null); }}
                className="px-4 py-2 text-sm font-bold text-white bg-danger/80 hover:bg-danger rounded-xl transition-all"
              >
                Unadd
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Friend profile popup */}
    {viewingFriend && (
      <ProfilePopup
        userId={viewingFriend.id}
        username={viewingFriend.username}
        isBot={false}
        isAdmin={false}
        isBanned={false}
        onBan={() => {}}
        onUnban={() => {}}
        onClose={() => setViewingFriend(null)}
      />
    )}
    </>
  );
}

export default function Profile() {
  const ready = usePageReady();
  const { profile, session, refreshProfile, updateProfile } = useAuth();
  const { socket, activeGames } = useSocket();
  const [matches, setMatches] = useState([]);
  const [editing, setEditing] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [extraStats, setExtraStats] = useState({ rank: null, total_wagered: 0 });
  const [resetMsg, setResetMsg] = useState('');
  const [resendMsg, setResendMsg] = useState('');
  const [showColors, setShowColors] = useState(false);
  // The avatar button now opens a CHOICE (colour or photo) rather than going
  // straight to colours, so both options are discoverable from the same place.
  const [avatarMenu, setAvatarMenu]   = useState(false);
  const [avatarBusy, setAvatarBusy]   = useState(false);
  const [avatarErr, setAvatarErr]     = useState('');
  const fileInputRef = useRef(null);
  const [savingColor, setSavingColor] = useState(false);
  const [showHighscores, setShowHighscores] = useState(false);
  const [gameStats, setGameStats] = useState([]);
  const [personalBests, setPersonalBests] = useState([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [matchesExpanded, setMatchesExpanded] = useState(false);

  const COLORS = [
    '#1250B4','#00BFFF','#22c55e','#ef4444','#f97316',
    '#a855f7','#ec4899','#eab308','#06b6d4','#14b8a6','#f43f5e','#e2e8f0',
  ];

  // Apply saved theme on mount
  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'dark';
    if (saved === 'light') document.documentElement.classList.add('light');
    else document.documentElement.classList.remove('light');
  }, []);

  async function pickPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // so re-picking the same file fires change again
    if (!file) return;

    setAvatarErr('');
    // Checked here too, not only server-side: reading a 20MB file into base64
    // just to be told no is a slow way to learn it.
    if (file.size > 3 * 1024 * 1024) {
      setAvatarErr('That image is too large. Maximum size is 3MB.');
      return;
    }

    setAvatarBusy(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error('Could not read that file.'));
        fr.readAsDataURL(file);
      });
      const { avatar_url } = await api.post('/avatar', { image: dataUrl });
      updateProfile({ avatar_url });
      setAvatarMenu(false);
    } catch (err) {
      setAvatarErr(err.message || 'Upload failed.');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removePhoto() {
    setAvatarBusy(true);
    setAvatarErr('');
    try {
      await api.delete('/avatar');
      updateProfile({ avatar_url: null });
      setAvatarMenu(false);
    } catch (err) {
      setAvatarErr(err.message || 'Could not remove that picture.');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function saveColor(color) {
    setSavingColor(true);
    try {
      await api.patch('/auth/me', { profile_color: color });
      await refreshProfile();
      if (socket) socket.emit('update_profile_color', { color });
      setShowColors(false);
    } catch (e) {
      console.error('color save failed:', e.message);
    } finally {
      setSavingColor(false);
    }
  }

  const emailVerified = !!session?.user?.email_confirmed_at;

  async function sendPasswordReset() {
    const email = session?.user?.email;
    if (!email) return;
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password',
    });
    setResetMsg('Password reset email sent — check your inbox.');
  }

  async function resendVerification() {
    const email = session?.user?.email;
    if (!email) return;
    await supabase.auth.resend({ type: 'signup', email });
    setResendMsg('Verification email sent — check your inbox.');
  }

  useEffect(() => {
    if (!profile) return;
    api.get(`/match/history/${profile.id}`).then(setMatches).catch(() => {});
    api.get(`/auth/public/${profile.id}`).then(d => setExtraStats({ rank: d.rank, total_wagered: d.total_wagered })).catch(() => {});
    setNewUsername(profile.username || '');
  }, [profile]);

  async function toggleHighscores() {
    if (showHighscores) { setShowHighscores(false); return; }
    setShowHighscores(true);
    if (gameStats.length === 0) {
      setLoadingStats(true);
      const [statsRes, bestsRes] = await Promise.all([
        api.get('/auth/game-stats').catch(() => []),
        api.get('/auth/highscores').catch(() => []),
      ]);
      setGameStats(statsRes || []);
      setPersonalBests(bestsRes || []);
      setLoadingStats(false);
    }
  }

  async function saveUsername() {
    if (!newUsername.trim() || newUsername === profile.username) return setEditing(false);
    setSaving(true);
    setError(null);
    try {
      await api.patch('/auth/me', { username: newUsername.trim() });
      await refreshProfile();
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!profile) {
    return (
      <div className="min-h-[calc(100vh-56px)] bg-bg flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">👤</div>
          <h2 className="text-2xl font-black text-white mb-2">Your Profile</h2>
          <p className="text-muted mb-6">Login to view your stats, match history, and achievements.</p>
          <Link to="/login" className="px-6 py-3 bg-primary hover:bg-blue-500 text-white font-bold rounded-xl transition-all">Login to View</Link>
        </div>
      </div>
    );
  }

  const winRate = profile.wins + profile.losses > 0
    ? ((profile.wins / (profile.wins + profile.losses)) * 100).toFixed(1)
    : 0;

  return (
    <div className="min-h-screen bg-bg pt-16" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.35s ease' }}>
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          profile={profile}
          refreshProfile={refreshProfile}
          session={session}
          resetMsg={resetMsg}
          setResetMsg={setResetMsg}
          sendPasswordReset={sendPasswordReset}
        />
      )}

      <div className="px-4 py-12">
        <div className="relative max-w-2xl mx-auto">
        <div>
        {/* Profile header */}
        <div className="bg-surface border border-surfaceLight rounded-2xl p-6 mb-6 relative">

          <div className="flex items-center gap-5 mb-6">
            <div className="relative">
              <button
                onClick={() => { setAvatarMenu(v => !v); setShowColors(false); setAvatarErr(''); }}
                title="Change picture or colour"
                className="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center text-3xl font-black transition-transform hover:scale-105 active:scale-95"
                style={{
                  backgroundColor: `${profile.profile_color || '#1250B4'}22`,
                  border: `2px solid ${profile.profile_color || '#1250B4'}`,
                  color: profile.profile_color || '#1250B4',
                  boxShadow: `0 0 18px ${profile.profile_color || '#1250B4'}66`,
                }}>
                {/* The uploaded picture when there is one; the coloured
                    initial stays the default rather than a fallback state. */}
                {profile.avatar_url
                  ? <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" />
                  : profile.username?.[0]?.toUpperCase()}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={pickPhoto}
                className="hidden"
              />
              <span className="absolute -bottom-1 -right-1 text-2xl leading-none drop-shadow-lg pointer-events-none"
                title={getRank(profile.elo).name}>
                {getRank(profile.elo).icon}
              </span>
              {(profile.current_streak ?? 0) >= 1 && (
                <span
                  className="absolute -top-1 -left-1 flex items-center justify-center min-w-[22px] h-[22px] rounded-full text-xs font-black leading-none px-1"
                  style={{ background: 'rgba(0,0,0,0.85)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.5)', textShadow: '0 0 8px rgba(251,146,60,0.7)', zIndex: 10 }}
                >
                  🔥{profile.current_streak}
                </span>
              )}

              {/* Choice menu: colour, or a photo. */}
              {avatarMenu && !showColors && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setAvatarMenu(false)} />
                  <div className="absolute left-0 top-24 z-20 bg-surface border border-border rounded-2xl p-2 shadow-2xl w-52">
                    <button
                      onClick={() => { setShowColors(true); }}
                      className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold text-white hover:bg-surfaceLight transition-all"
                    >
                      🎨 Change colour
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={avatarBusy}
                      className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold text-white hover:bg-surfaceLight transition-all disabled:opacity-50"
                    >
                      {avatarBusy ? '⏳ Uploading…' : '🖼️ Upload photo'}
                    </button>
                    {profile.avatar_url && (
                      <button
                        onClick={removePhoto}
                        disabled={avatarBusy}
                        className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold text-danger hover:bg-danger/10 transition-all disabled:opacity-50"
                      >
                        ✕ Remove photo
                      </button>
                    )}
                    {avatarErr && <p className="text-[11px] text-danger px-3 py-2">{avatarErr}</p>}
                  </div>
                </>
              )}

              {/* Color picker popup */}
              {showColors && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => { setShowColors(false); setAvatarMenu(false); }} />
                  <div className="absolute left-0 top-24 z-20 bg-surface border border-border rounded-2xl p-4 shadow-2xl w-52">
                    <p className="text-xs text-muted font-semibold mb-3">Choose a color</p>
                    <div className="grid grid-cols-6 gap-2">
                      {COLORS.map(c => (
                        <button
                          key={c}
                          onClick={() => saveColor(c)}
                          disabled={savingColor}
                          className="w-7 h-7 rounded-full border-2 transition-all hover:scale-110 disabled:opacity-50"
                          style={{
                            backgroundColor: c,
                            borderColor: (profile.profile_color || '#1250B4') === c ? '#fff' : 'transparent',
                            boxShadow: (profile.profile_color || '#1250B4') === c ? `0 0 8px ${c}` : 'none',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="flex-1 min-w-0">
              {editing ? (
                <div className="flex gap-2">
                  <input
                    value={newUsername}
                    onChange={e => setNewUsername(e.target.value)}
                    className="flex-1 bg-bg border border-surfaceLight rounded-lg px-3 py-2 text-white text-lg font-bold focus:outline-none focus:border-primary"
                    maxLength={20}
                  />
                  <GlowButton variant="success" size="sm" onClick={saveUsername} disabled={saving}>
                    {saving ? '...' : 'Save'}
                  </GlowButton>
                  <GlowButton variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </GlowButton>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-black text-white">{profile.username}</h1>
                  <button
                    onClick={() => setEditing(true)}
                    className="text-xs text-muted hover:text-white transition-colors"
                  >
                    Edit
                  </button>
                </div>
              )}
              {error && <p className="text-danger text-sm mt-1">{error}</p>}
              <p className="text-sm font-bold mt-0.5" style={{ color: getRank(profile.elo).color }}>
                {getRank(profile.elo).icon} {getRank(profile.elo).name}
              </p>
              <p className="text-muted text-xs mt-0.5">
                Member since {new Date(profile.created_at).toLocaleDateString()}
              </p>
            </div>
          </div>

          {/* Action buttons row — sits below header on all screen sizes */}
          <div className="flex items-center gap-2 mb-4">
            <Link
              to="/transactions"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-surfaceLight text-muted hover:text-white hover:border-primary transition-all text-xs font-semibold"
              title="Transaction History"
            >
              📋 Transactions
            </Link>
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-surfaceLight text-muted hover:text-white hover:border-primary transition-all text-xs font-semibold"
              title="Settings"
            >
              ⚙️ Settings
            </button>
          </div>

          {/* Email verification banner */}
          {!emailVerified && (
            <div className="mb-4 flex items-center justify-between gap-3 bg-warning/10 border border-warning/30 rounded-xl px-4 py-3">
              <div>
                <p className="text-sm font-bold text-warning">Email not verified</p>
                <p className="text-xs text-muted">Verify your email to secure your account.</p>
              </div>
              <button
                onClick={resendVerification}
                className="text-xs font-bold text-warning border border-warning/40 rounded-lg px-3 py-1.5 hover:bg-warning/10 transition-all shrink-0"
              >
                Resend
              </button>
            </div>
          )}
          {resendMsg && <p className="text-success text-xs mb-3">{resendMsg}</p>}

          {/* Stats grid
              Six cards, all the same size. The rank card used to be
              col-span-2 on mobile — a full-width banner of its own above a
              2-wide grid of five, which left it visibly larger than
              everything else and the last row half empty. As a normal cell
              it is one of six, so mobile lands on exactly 3 rows of 2 with
              every card matching, and desktop keeps its 3-across layout. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {/* Win Rate leads; the rank card sits second, where it reads as
                one stat among six rather than a header above them. */}
            <div className="bg-bg rounded-xl p-3 text-center overflow-hidden">
              <div className="text-xl font-black text-success truncate">{winRate}%</div>
              <div className="text-xs text-muted mt-0.5">Win Rate</div>
            </div>

            <div className="bg-bg rounded-xl p-3 text-center overflow-hidden"
              style={{ boxShadow: `inset 0 0 20px ${getRank(profile.elo).glow}` }}>
              {/* Smaller than the other cards' text on purpose: this is the
                  only value that is a WORD, and "Champion" at text-xl does
                  not fit a half-width cell. truncate is the backstop. */}
              <div className="text-base sm:text-xl font-black truncate" style={{ color: getRank(profile.elo).color }}>
                {getRank(profile.elo).icon} {getRank(profile.elo).name}
              </div>
              <div className="text-xs text-muted mt-0.5">{profile.elo} ELO</div>
            </div>

            {[
              { label: 'Leaderboard', value: extraStats.rank ? `#${extraStats.rank}` : '-', color: 'text-accent' },
              { label: 'Wins', value: profile.wins, color: 'text-success' },
              { label: 'Losses', value: profile.losses, color: 'text-danger' },
              { label: 'Wagered', value: `${fmtCoins(extraStats.total_wagered)} coins`, title: `${fmtExact(extraStats.total_wagered)} coins wagered`, color: 'text-white' },
            ].map(s => (
              <div key={s.label} className="bg-bg rounded-xl p-3 text-center overflow-hidden">
                <div className={`text-xl font-black ${s.color} truncate`} title={s.title}>{s.value}</div>
                <div className="text-xs text-muted mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Friends — on mobile this sits directly under the profile card, above
            the affiliate/stats/history stack. On desktop it is the floating
            right column instead, so this copy is hidden there. */}
        <div className="mb-6 lg:hidden">
          <FriendsPanel myId={profile.id} myUsername={profile.username} myReferralCode={profile.affiliate_code} activeGames={activeGames} />
        </div>

        {/* Affiliate code card */}
        <AffiliateCodeCard />

        {/* Coin P&L chart */}
        <CoinHistorySection userId={profile.id} />

        {/* Game Highscores */}
        <div className="bg-surface border border-surfaceLight rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Game Stats</h2>
            <button
              onClick={toggleHighscores}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all ${
                showHighscores
                  ? 'bg-primary/20 border-primary text-primary'
                  : 'border-surfaceLight text-muted hover:border-primary hover:text-white'
              }`}
            >
              {showHighscores ? '▲ Hide' : '▼ Show'}
            </button>
          </div>

          {showHighscores && (
            <div className="mt-4">
              {loadingStats ? (
                <div className="flex justify-center py-6">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                (() => {
                  const statsMap = Object.fromEntries(gameStats.map(gs => [gs.gameType, gs]));
                  const bestsMap = Object.fromEntries(personalBests.map(pb => [pb.game_type, pb]));
                  const rows = Object.entries(GAME_INFO).map(([key, info]) => ({
                    key, info,
                    stats: statsMap[key] || { played: 0, wins: 0 },
                    best: bestsMap[info.bestKey || key] || null,
                    bestTime: info.timeKey ? (bestsMap[info.timeKey] || null) : null,
                  }))
                  .filter(({ stats, best }) => stats.played > 0 || best !== null)
                  .sort((a, b) => b.stats.played - a.stats.played);
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {rows.map(({ key, info, stats, best, bestTime }) => {
                        const wr = stats.played > 0 ? ((stats.wins / stats.played) * 100).toFixed(0) : null;
                        const scoreLabel = HIGHSCORE_LABELS[key];
                        return (
                          <div key={key} className="bg-bg rounded-xl p-3 text-center">
                            <div className="text-2xl mb-1">{info.emoji}</div>
                            <div className="text-xs text-muted font-medium truncate mb-2">{info.name}</div>
                            <div className="text-sm font-black text-white">
                              {stats.wins}W / {stats.played - stats.wins}L
                            </div>
                            {wr !== null && (
                              <div className="text-xs text-accent mb-1">{wr}% win</div>
                            )}
                            {best && scoreLabel && (
                              <div className="mt-1 pt-1 border-t border-surfaceLight/50">
                                <div>
                                  <span className="text-xs text-primary font-bold">{Number(best.score).toLocaleString()}</span>
                                  <span className="text-xs text-muted ml-1">best {scoreLabel.toLowerCase()}</span>
                                </div>
                                {/* Survival time from that same run. Only rendered when a
                                    companion row exists, so older bests recorded before it
                                    was stored simply show the score alone. */}
                                {bestTime && (
                                  <div>
                                    <span className="text-xs text-primary font-bold">{fmtAlive(bestTime.score)}</span>
                                    <span className="text-xs text-muted ml-1">alive</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              )}
            </div>
          )}
        </div>

        {/* Match history — collapsible */}
        <div className="bg-surface border border-surfaceLight rounded-2xl p-6">
          <button
            onClick={() => setMatchesExpanded(v => !v)}
            className="w-full flex items-center justify-between"
          >
            <h2 className="text-lg font-bold text-white">Recent Matches</h2>
            <div className="flex items-center gap-3">
              <Link
                to="/transactions"
                onClick={e => e.stopPropagation()}
                className="text-xs text-primary hover:underline"
              >
                All transactions →
              </Link>
              <span className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all ${
                matchesExpanded
                  ? 'bg-primary/20 border-primary text-primary'
                  : 'border-surfaceLight text-muted hover:border-primary hover:text-white'
              }`}>
                {matchesExpanded ? '▲ Hide' : '▼ Show'}
              </span>
            </div>
          </button>

          {matchesExpanded && (
            <div className="mt-4">
              {matches.length === 0 ? (
                <p className="text-muted text-sm text-center py-6">No matches yet. Start playing!</p>
              ) : (
                matches.map(m => (
                  <MatchRow key={m.id} match={m} myId={profile.id} />
                ))
              )}
            </div>
          )}
        </div>

        </div>{/* end main content */}

        {/* Terms of Service — bottom of the page */}
        <div className="text-center mt-6">
          <Link to="/tos" className="text-xs text-muted hover:text-white transition-colors underline underline-offset-2">
            Terms of Service
          </Link>
          <span className="text-xs text-muted mx-2">·</span>
          <Link to="/privacy" className="text-xs text-muted hover:text-white transition-colors underline underline-offset-2">
            Privacy Policy
          </Link>
          <span className="text-xs text-muted mx-2">·</span>
          <Link to="/support" className="text-xs text-muted hover:text-white transition-colors underline underline-offset-2">
            Support
          </Link>
        </div>
        <div className="absolute top-0 left-full ml-4 w-64 hidden lg:block">
          <FriendsPanel myId={profile.id} myUsername={profile.username} myReferralCode={profile.affiliate_code} activeGames={activeGames} />
        </div>
        </div>{/* end relative container */}
      </div>
    </div>
  );
}

