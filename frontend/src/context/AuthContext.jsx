import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase, restoreSavedSession, clearSavedSession } from '../utils/supabase';
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

  const fetchProfile = useCallback(async () => {
    // Don't hit the API if there's no active session
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s) { setProfile(null); return null; }
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
    // Subscribe to auth changes first
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setSession(sess);
      // Only handle profile updates after initial load is done
      if (initializedRef.current) {
        if (sess) {
          await ensureProfile();
        } else {
          setProfile(null);
        }
      }
    });

    // Then do the initial session restore
    async function init() {
      try {
        // Try to restore a previously saved session
        const restored = await restoreSavedSession();
        if (restored) {
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
      setMfaPending(true);
      setMfaFactorId(factor?.id ?? null);
      return { mfaRequired: true, factorId: factor?.id };
    }

    const profile = await ensureProfile();
    setShowSaveLogin(true);
    return profile;
  }

  async function completeMfaLogin(factorId, code) {
    // Re-fetch factorId if missing
    let fid = factorId;
    if (!fid) {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      fid = factors?.totp?.[0]?.id ?? null;
    }
    if (!fid) throw new Error('No MFA factor found — try signing in again.');

    console.log('[MFA] challengeAndVerify factorId:', fid, 'code:', code);
    const { data, error } = await supabase.auth.mfa.challengeAndVerify({ factorId: fid, code });
    if (error) {
      console.error('[MFA] challengeAndVerify error:', error);
      throw error;
    }
    console.log('[MFA] success:', data);
    setMfaPending(false);
    setMfaFactorId(null);
    ensureProfile().catch(() => {});
    setShowSaveLogin(true);
    return true;
  }

  async function signOut() {
    await supabase.auth.signOut();
    clearSavedSession();
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
