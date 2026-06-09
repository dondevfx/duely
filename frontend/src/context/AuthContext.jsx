import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase, getStartupSession, clearSavedSession } from '../utils/supabase';
import { api } from '../utils/api';

const AuthContext = createContext(null);

const PENDING_USERNAME_KEY = 'rd_pending_username';

export function AuthProvider({ children }) {
  const [session, setSession]         = useState(null);
  const [profile, setProfile]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [mfaPending, setMfaPending]   = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState(null);
  const [showSaveLogin, setShowSaveLogin] = useState(false);
  const initializedRef = useRef(false);
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
    } catch {
      return null;
    }
  }, [fetchProfile]);

  useEffect(() => {
    // Subscribe to auth changes — callback must be synchronous (no await)
    // to avoid deadlocking the Supabase Web Lock held during notification
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (initializedRef.current) {
        if (sess) {
          // Fire profile fetch outside the lock callback
          setTimeout(() => ensureProfile(), 0);
        } else {
          setProfile(null);
        }
      }
    });

    async function init() {
      try {
        const { session: restored, source } = await getStartupSession();
        if (restored) {
          if (source === 'saved') {
            // Saved login: check if user has 2FA enabled
            // Session is active in Supabase memory — do NOT set React session yet
            const { data: factors } = await supabase.auth.mfa.listFactors();
            const factor = factors?.totp?.find(f => f.status === 'verified');
            if (factor) {
              // Has 2FA — keep session in Supabase memory for challengeAndVerify,
              // but don't expose it to React state so the user isn't "logged in" yet
              _pendingMfaCreds.current = { fromSavedSession: true, factorId: factor.id };
              setMfaPending(true);
              setMfaFactorId(factor.id);
              // session stays null in React state — triggers redirect to /login
            } else {
              // No 2FA — fully log in
              setSession(restored);
              await ensureProfile();
            }
          } else {
            // Page refresh (sessionStorage): already authenticated this visit
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
    if (error) {
      sessionStorage.removeItem(PENDING_USERNAME_KEY);
      throw error;
    }

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
      // Store credentials so we can re-authenticate after MFA code entry
      // Sign out the partial AAL1 session so user isn't logged in until MFA passes
      const factorId = factor?.id ?? null;
      await supabase.auth.signOut();
      // Store creds in memory for completeMfaLogin to use
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
      // Fresh login path: re-sign-in with stored email/password to get AAL1 session
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: creds.email,
        password: creds.password,
      });
      if (signInErr) throw signInErr;
    }
    // Saved-session path: session already active in Supabase memory — call verify directly

    const fid = creds.factorId || factorId;
    if (!fid) throw new Error('No MFA factor found — try signing in again.');

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: fid, code });
    if (error) throw error;

    // MFA passed — expose the session to React state
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    _pendingMfaCreds.current = null;
    setSession(freshSession);
    setMfaPending(false);
    setMfaFactorId(null);
    ensureProfile().catch(() => {});
    if (!localStorage.getItem('duely_save_login')) setShowSaveLogin(true);
    return true;
  }

  async function signOut() {
    await supabase.auth.signOut();
    clearSavedSession();
    _pendingMfaCreds.current = null;
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
