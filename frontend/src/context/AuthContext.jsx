import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase, getStartupSession, saveSession, clearSavedSession } from '../utils/supabase';
import { api } from '../utils/api';

const AuthContext = createContext(null);
const PENDING_USERNAME_KEY = 'rd_pending_username';
const SAVE_LOGIN_KEY = 'duely_save_login';
const SAVE_SESSION_KEY = 'duely_saved_session';

export function AuthProvider({ children }) {
  const [session, setSession]             = useState(null);
  const [profile, setProfile]             = useState(null);
  const [loading, setLoading]             = useState(true);
  const [mfaPending, setMfaPending]       = useState(false);
  const [mfaFactorId, setMfaFactorId]     = useState(null);
  const [showSaveLogin, setShowSaveLogin] = useState(false);
  const initializedRef   = useRef(false);
  const _pendingMfaCreds = useRef(null);

  const fetchProfile = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setProfile(data);
      return data;
    } catch {
      setProfile(null);
      return null;
    }
  }, []);

  const ensureProfile = useCallback(async () => {
    const existing = await fetchProfile();
    if (existing) return existing;
    const pendingUsername = sessionStorage.getItem(PENDING_USERNAME_KEY);
    if (!pendingUsername) return null;
    try {
      await api.post('/auth/profile', { username: pendingUsername });
      sessionStorage.removeItem(PENDING_USERNAME_KEY);
      return fetchProfile();
    } catch { return null; }
  }, [fetchProfile]);

  useEffect(() => {
    // onAuthStateChange must be synchronous — no await — to avoid Web Lock deadlock
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, sess) => {
      // Keep saved tokens in sync whenever Supabase auto-refreshes them
      if (event === 'TOKEN_REFRESHED' && sess && localStorage.getItem(SAVE_LOGIN_KEY)) {
        localStorage.setItem(SAVE_SESSION_KEY, JSON.stringify({
          access_token: sess.access_token,
          refresh_token: sess.refresh_token,
        }));
      }
      // Don't update session state from here during init — init() manages state directly
      if (!initializedRef.current) return;
      // After init, keep React session in sync — but not while MFA is pending
      if (_pendingMfaCreds.current) return;
      setSession(sess);
      if (sess) {
        setTimeout(() => ensureProfile(), 0);
      } else {
        setProfile(null);
      }
    });

    async function init() {
      try {
        const { session: restored, source } = await getStartupSession();

        if (!restored) {
          // No session anywhere — stay logged out
          return;
        }

        if (source === 'saved') {
          // Restored from localStorage (new visit after closing tab)
          // Check for verified 2FA factors
          const { data: factors } = await supabase.auth.mfa.listFactors();
          const factor = factors?.totp?.find(f => f.status === 'verified');
          if (factor) {
            // Has 2FA — session is alive in Supabase memory for challengeAndVerify
            // Keep React session = null so user sees logged-out state + MFA redirect
            _pendingMfaCreds.current = { fromSavedSession: true, factorId: factor.id };
            setMfaPending(true);
            setMfaFactorId(factor.id);
            // session intentionally left null — Shell will redirect to /login
          } else {
            // No 2FA — log straight in
            setSession(restored);
            await ensureProfile();
          }
        } else {
          // Restored from sessionStorage (page refresh — same tab session)
          setSession(restored);
          const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
          if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
            const { data: factors } = await supabase.auth.mfa.listFactors();
            const factor = factors?.totp?.[0];
            setMfaPending(true);
            setMfaFactorId(factor?.id ?? null);
          } else {
            await ensureProfile();
          }
        }
      } catch (e) {
        console.error('[AuthContext] init error:', e);
      } finally {
        initializedRef.current = true;
        setLoading(false);
      }
    }

    init();
    return () => subscription.unsubscribe();
  }, [ensureProfile]);

  async function signUp(email, password, username) {
    sessionStorage.setItem(PENDING_USERNAME_KEY, username.trim());
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) { sessionStorage.removeItem(PENDING_USERNAME_KEY); throw error; }
    if (data.session) {
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

    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp?.[0];
      const factorId = factor?.id ?? null;
      // Sign out partial AAL1 session — user isn't logged in until MFA passes
      await supabase.auth.signOut();
      _pendingMfaCreds.current = { email, password, factorId };
      setMfaPending(true);
      setMfaFactorId(factorId);
      return { mfaRequired: true, factorId };
    }

    const profile = await ensureProfile();
    setShowSaveLogin(true);
    return profile;
  }

  async function completeMfaLogin(factorId, code) {
    const creds = _pendingMfaCreds.current;
    if (!creds) throw new Error('Session expired — please sign in again.');

    if (!creds.fromSavedSession) {
      // Fresh login: re-authenticate with email/password to get AAL1 session
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      if (signInErr) throw signInErr;
    }
    // For fromSavedSession: session is already in Supabase memory — just verify

    const fid = creds.factorId || factorId;
    if (!fid) throw new Error('No MFA factor found — try signing in again.');

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: fid, code });
    if (error) throw error;

    // MFA passed — get fresh session and expose to React
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    _pendingMfaCreds.current = null;
    setSession(freshSession);
    setMfaPending(false);
    setMfaFactorId(null);
    ensureProfile().catch(() => {});

    // Always refresh saved tokens after MFA (challengeAndVerify rotates them)
    if (localStorage.getItem(SAVE_LOGIN_KEY)) {
      await saveSession();
    } else {
      setShowSaveLogin(true);
    }
    return true;
  }

  async function signOut() {
    await supabase.auth.signOut();
    clearSavedSession();
    _pendingMfaCreds.current = null;
    setSession(null);
    setProfile(null);
    setMfaPending(false);
    setMfaFactorId(null);
    setShowSaveLogin(false);
  }

  const refreshProfile = useCallback(() => fetchProfile(), [fetchProfile]);

  return (
    <AuthContext.Provider value={{
      session, profile, loading,
      mfaPending, mfaFactorId,
      showSaveLogin, setShowSaveLogin,
      signUp, signIn, signOut, refreshProfile, completeMfaLogin,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
