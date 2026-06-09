import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase, restoreSavedSession, clearSavedSession } from '../utils/supabase';
import { api } from '../utils/api';

const AuthContext = createContext(null);

const PENDING_USERNAME_KEY = 'rd_pending_username';

export function AuthProvider({ children }) {
  const [session, setSession]       = useState(null);
  const [profile, setProfile]       = useState(null);
  const [loading, setLoading]       = useState(true);
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState(null);
  const [showSaveLogin, setShowSaveLogin] = useState(false);

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
    async function init() {
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
      setLoading(false);
    }

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        ensureProfile();
      } else {
        setProfile(null);
      }
    });

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
    setShowSaveLogin(true); // show save login prompt after successful login
    return profile;
  }

  async function completeMfaLogin(factorId, code) {
    const { data: challenge, error: ce } = await supabase.auth.mfa.challenge({ factorId });
    if (ce) throw ce;
    const { error: ve } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    if (ve) throw ve;
    setMfaPending(false);
    setMfaFactorId(null);
    const profile = await ensureProfile();
    setShowSaveLogin(true);
    return profile;
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
