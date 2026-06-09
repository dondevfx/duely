import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../utils/supabase';
import { api } from '../utils/api';

const AuthContext = createContext(null);

// Persist pending username across email confirmation if needed
const PENDING_USERNAME_KEY = 'rd_pending_username';

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState(null);

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

  // Try to create profile using a pending username stored at signup time
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
    // Fast-path: if no token in storage, skip the network round-trip
    const hasStoredSession = !!localStorage.getItem('duely_auth');
    if (!hasStoredSession) {
      setLoading(false);
    }

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session) {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
          const { data: factors } = await supabase.auth.mfa.listFactors();
          const factor = factors?.totp?.[0];
          setMfaPending(true);
          setMfaFactorId(factor?.id ?? null);
          setLoading(false);
        } else {
          ensureProfile().finally(() => setLoading(false));
        }
      } else {
        setLoading(false);
      }
    });

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
    // Store username before signup so ensureProfile can use it after session arrives
    sessionStorage.setItem(PENDING_USERNAME_KEY, username.trim());

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      sessionStorage.removeItem(PENDING_USERNAME_KEY);
      throw error;
    }

    // If email confirmation is OFF, we get a session immediately
    if (data.session) {
      await api.post('/auth/profile', { username: username.trim() });
      sessionStorage.removeItem(PENDING_USERNAME_KEY);
      await fetchProfile();
    }
    // If email confirmation is ON, session is null here.
    // ensureProfile() will fire via onAuthStateChange after the user confirms.

    return data;
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Check if MFA verification is required
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp?.[0];
      setMfaPending(true);
      setMfaFactorId(factor?.id ?? null);
      return { mfaRequired: true, factorId: factor?.id };
    }

    const profile = await ensureProfile();
    return profile; // null if no profile row exists yet
  }

  async function completeMfaLogin(factorId, code) {
    const { data: challenge, error: ce } = await supabase.auth.mfa.challenge({ factorId });
    if (ce) throw ce;
    const { error: ve } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    if (ve) throw ve;
    setMfaPending(false);
    setMfaFactorId(null);
    return ensureProfile();
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setMfaPending(false);
    setMfaFactorId(null);
  }

  const refreshProfile = useCallback(() => fetchProfile(), [fetchProfile]);

  return (
    <AuthContext.Provider value={{ session, profile, loading, mfaPending, mfaFactorId, signUp, signIn, signOut, refreshProfile, completeMfaLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
