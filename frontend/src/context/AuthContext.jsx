import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import {
  supabase,
  storeSession,
  readSessionFromStorage,
  persistTokens,
  clearSavedSession,
  loadSavedTokens,
  doTokenRefresh,
  getCurrentSession,
  SAVE_LOGIN_KEY,
} from '../utils/supabase';
import { api } from '../utils/api';

const AuthContext = createContext(null);
const PENDING_USERNAME_KEY = 'rd_pending_username';

// How many ms before expiry we proactively refresh the token.
const REFRESH_MARGIN_MS = 90 * 1000;

export function AuthProvider({ children }) {
  const [session, setSession]             = useState(null);
  const [profile, setProfile]             = useState(null);
  const [loading, setLoading]             = useState(true);
  const [mfaPending, setMfaPending]       = useState(false);
  const [mfaFactorId, setMfaFactorId]     = useState(null);
  const [showSaveLogin, setShowSaveLogin] = useState(false);

  const _pendingMfaCreds  = useRef(null);
  const _refreshTimer     = useRef(null);
  const _refreshingRef    = useRef(false); // prevent concurrent refreshes

  // ── Session helpers ────────────────────────────────────────────────────

  function _applySession(sess) {
    if (!sess) console.trace('[AuthContext] session cleared');
    storeSession(sess);
    setSession(sess);
    if (sess) _scheduleRefresh(sess);
    else _clearRefreshTimer();
  }

  function _clearRefreshTimer() {
    if (_refreshTimer.current) {
      clearTimeout(_refreshTimer.current);
      _refreshTimer.current = null;
    }
  }

  function _scheduleRefresh(sess) {
    _clearRefreshTimer();
    if (!sess?.expires_at) return;
    const msUntilRefresh = sess.expires_at * 1000 - Date.now() - REFRESH_MARGIN_MS;
    const delay = Math.max(msUntilRefresh, 5000); // at least 5s
    _refreshTimer.current = setTimeout(() => _doRefresh(), delay);
  }

  async function _doRefresh() {
    if (_refreshingRef.current) return;
    _refreshingRef.current = true;
    try {
      const current = getCurrentSession();
      if (!current?.refresh_token) return;
      const newSess = await doTokenRefresh(current.refresh_token);
      if (newSess) {
        _applySession(newSess);
        if (localStorage.getItem(SAVE_LOGIN_KEY)) {
          persistTokens(newSess.access_token, newSess.refresh_token);
        }
      } else {
        // Refresh failed — be resilient before signing the user out.
        const latest = readSessionFromStorage();
        if (latest && latest.access_token !== current.access_token) {
          // Another tab already refreshed and wrote a new session — adopt it.
          _applySession(latest);
          if (localStorage.getItem(SAVE_LOGIN_KEY)) {
            persistTokens(latest.access_token, latest.refresh_token);
          }
        } else if (current.expires_at && current.expires_at * 1000 < Date.now()) {
          // Access token is genuinely expired — sign out.
          _applySession(null);
          setProfile(null);
        } else {
          // Token still valid, refresh just failed transiently — retry in 15s.
          _refreshTimer.current = setTimeout(() => _doRefresh(), 15_000);
        }
      }
    } finally {
      _refreshingRef.current = false;
    }
  }

  // ── Profile helpers ────────────────────────────────────────────────────

  const fetchProfile = useCallback(async ({ clearOnFail = true } = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await api.get('/auth/me');
        setProfile(data);
        return data;
      } catch (e) {
        // Don't retry on 429 — back off and let the safety-net handle it
        if (e.message?.includes('429') || e.status === 429) break;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    if (clearOnFail) setProfile(null);
    return null;
  }, []);

  const ensureProfile = useCallback(async () => {
    const existing = await fetchProfile({ clearOnFail: false });
    if (existing) return existing;
    const pendingUsername = sessionStorage.getItem(PENDING_USERNAME_KEY);
    if (!pendingUsername) return null;
    try {
      await api.post('/auth/profile', { username: pendingUsername });
      sessionStorage.removeItem(PENDING_USERNAME_KEY);
      return fetchProfile();
    } catch { return null; }
  }, [fetchProfile]);

  // ── Initialisation ─────────────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      try {
        let sess = readSessionFromStorage();

        if (!sess) {
          // No sessionStorage session — check localStorage save-login
          const saved = loadSavedTokens();
          if (saved?.refresh_token) {
            const refreshed = await doTokenRefresh(saved.refresh_token);
            if (refreshed) {
              sess = refreshed;
              persistTokens(sess.access_token, sess.refresh_token);
            } else {
              clearSavedSession();
            }
          }
        }

        if (!sess) return; // not logged in

        // Only refresh during init() when the token is ACTUALLY expired.
        //
        // Do NOT refresh for near-expiry tokens here — that causes "ghost rotations":
        // the HTTP call consumes the refresh token on Supabase's server, but if the
        // user pressed F5 before the response arrives the new token is never written
        // to storage. Every subsequent page load then fails with invalid_grant on the
        // same consumed RT, and the user gets signed out when the access token expires.
        //
        // Near-expiry is handled by _scheduleRefresh (min 5s delay). F5 always cancels
        // that timer on page unload, so no ghost rotation can occur from the timer path.
        // Do NOT refresh during init() — even for expired tokens.
        //
        // Refreshing here causes ghost rotation: Supabase consumes the RT on its
        // server, but if F5 is pressed before the response arrives the new token
        // is never written to storage. With RT rotation disabled this is no longer
        // a hard sign-out, but we still avoid the unnecessary network call.
        //
        // If the token is expired the backend will return 401 and ensureProfile
        // will fail — _scheduleRefresh (delay: 0 for expired tokens) will fire
        // immediately after the page settles and refresh the token safely.
        const nowMs = Date.now();
        const expiresMs = sess.expires_at ? sess.expires_at * 1000 : Infinity;
        const isExpired = expiresMs < nowMs;

        if (isExpired) {
          // Token expired: schedule an immediate refresh AFTER the page settles,
          // then proceed — the safety-net useEffect will retry profile once refreshed.
          _refreshTimer.current = setTimeout(() => _doRefresh(), 100);
        }

        // Check for MFA requirement (only on saved-login path or when flag is set)
        const needsMfaCheck = sessionStorage.getItem('duely_needs_mfa_check');
        if (needsMfaCheck) {
          // Restored from localStorage — need to verify MFA level
          const { data: factors } = await supabase.auth.mfa.listFactors();
          const factor = factors?.totp?.find(f => f.status === 'verified');
          if (factor) {
            // MFA required — show profile info in nav but keep page locked
            _pendingMfaCreds.current = { fromSavedSession: true, factorId: factor.id };
            _applySession(sess);
            setMfaPending(true);
            setMfaFactorId(factor.id);
            fetchProfile().catch(() => {});
            return;
          }
        }

        _applySession(sess);
        await ensureProfile();
      } catch (e) {
        console.error('[AuthContext] init error:', e);
      } finally {
        setLoading(false);
      }
    }

    init();
    return () => _clearRefreshTimer();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Safety net: if we have a valid session but profile never loaded (e.g. backend
  // was briefly unavailable during init), retry every 3s until it succeeds.
  useEffect(() => {
    if (!session || profile || loading) return;
    const interval = setInterval(() => {
      fetchProfile({ clearOnFail: false }).catch(() => {});
    }, 4_000);
    return () => clearInterval(interval);
  }, [session, !!profile, loading, fetchProfile]); // eslint-disable-line react-hooks/exhaustive-deps
  // Safety net interval is 10s (not 3s) to avoid hammering /auth/me when it's
  // temporarily slow or rate-limited during rapid page refreshes.

  // ── Auth operations ────────────────────────────────────────────────────

  async function signUp(email, password, username) {
    sessionStorage.setItem(PENDING_USERNAME_KEY, username.trim());
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) { sessionStorage.removeItem(PENDING_USERNAME_KEY); throw error; }
    if (data.session) {
      _applySession(data.session);
      await api.post('/auth/profile', { username: username.trim() });
      sessionStorage.removeItem(PENDING_USERNAME_KEY);
      await fetchProfile();
      setShowSaveLogin(true);
    }
    return data;
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Check MFA requirement — wrap in try/catch so a network failure here never
    // blocks the session from being stored.
    try {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const factor = factors?.totp?.[0];
        _pendingMfaCreds.current = { email, password, factorId: factor?.id ?? null };
        setMfaPending(true);
        setMfaFactorId(factor?.id ?? null);
        return { mfaRequired: true, factorId: factor?.id };
      }
    } catch (e) {
      console.warn('[signIn] AAL check failed, assuming no MFA:', e.message);
    }

    _applySession(data.session);
    const profile = await ensureProfile();
    clearSavedSession();
    setShowSaveLogin(true);
    return profile;
  }

  async function completeMfaLogin(factorId, code) {
    const creds = _pendingMfaCreds.current;
    if (!creds) throw new Error('Session expired — please sign in again.');

    if (creds.fromSavedSession) {
      // Session is in our storage — load it into Supabase in-memory so challengeAndVerify works
      const current = getCurrentSession();
      if (!current) throw new Error('Session expired — please sign in again.');
      const { error: setErr } = await supabase.auth.setSession({
        access_token: current.access_token,
        refresh_token: current.refresh_token,
      });
      if (setErr) throw setErr;
    } else {
      // Fresh login — get AAL1 session into Supabase in-memory
      const { data, error: signInErr } = await supabase.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      if (signInErr) throw signInErr;
    }

    const fid = creds.factorId || factorId;
    if (!fid) throw new Error('No MFA factor found — try signing in again.');

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: fid, code });
    if (error) throw error;

    // MFA passed — pull the new AAL2 session from Supabase in-memory state
    sessionStorage.removeItem('duely_needs_mfa_check');
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    _pendingMfaCreds.current = null;
    _applySession(freshSession);
    setMfaPending(false);
    setMfaFactorId(null);
    ensureProfile().catch(() => {});

    if (freshSession && localStorage.getItem(SAVE_LOGIN_KEY)) {
      persistTokens(freshSession.access_token, freshSession.refresh_token);
    }
    if (!creds.fromSavedSession) {
      clearSavedSession();
      setShowSaveLogin(true);
    }
    return true;
  }

  async function signOut() {
    _clearRefreshTimer();
    const current = getCurrentSession();
    if (current?.access_token) {
      // Best-effort server-side invalidation — don't block UI on failure
      supabase.auth.signOut().catch(() => {});
    }
    _applySession(null);
    setProfile(null);
    clearSavedSession();
    _pendingMfaCreds.current = null;
    setMfaPending(false);
    setMfaFactorId(null);
    setShowSaveLogin(false);
  }

  // refreshProfile: post-game balance update — don't wipe profile on failure
  const refreshProfile = useCallback(
    () => fetchProfile({ clearOnFail: false }),
    [fetchProfile],
  );

  // updateProfile: optimistic balance patch — merges partial state instantly
  const updateProfile = useCallback(
    (partial) => setProfile(prev => prev ? { ...prev, ...partial } : prev),
    [],
  );

  return (
    <AuthContext.Provider value={{
      session, profile, loading,
      mfaPending, mfaFactorId,
      showSaveLogin, setShowSaveLogin,
      signUp, signIn, signOut, refreshProfile, updateProfile, completeMfaLogin,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
