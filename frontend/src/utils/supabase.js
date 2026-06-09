import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SAVE_LOGIN_KEY = 'duely_save_login';
const SAVE_SESSION_KEY = 'duely_saved_session';

// sessionStorage: survives refresh, cleared on tab/window close
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: window.sessionStorage,
    storageKey: 'duely_session',
  },
});

// Returns 'refresh' | 'saved' | null
// 'refresh' = session from sessionStorage (page reload, no MFA re-check needed)
// 'saved'   = session from localStorage (new visit, must re-check MFA)
export async function getStartupSession() {
  try {
    // Check sessionStorage first (Supabase handles this automatically)
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return { session, source: 'refresh' };

    // Check localStorage for a saved login
    const saved = localStorage.getItem(SAVE_LOGIN_KEY);
    if (!saved) return { session: null, source: null };
    const raw = localStorage.getItem(SAVE_SESSION_KEY);
    if (!raw) return { session: null, source: null };
    const { access_token, refresh_token } = JSON.parse(raw);
    if (!access_token || !refresh_token) return { session: null, source: null };

    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) {
      clearSavedSession();
      return { session: null, source: null };
    }
    // Clear from sessionStorage immediately — if MFA is required, a refresh
    // must go through the saved-login flow again, not bypass MFA via sessionStorage
    sessionStorage.removeItem('duely_session');
    return { session: data.session, source: 'saved' };
  } catch {
    clearSavedSession();
    return { session: null, source: null };
  }
}

// Save session to localStorage after user clicks "Save login"
export async function saveSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    localStorage.setItem(SAVE_LOGIN_KEY, 'true');
    localStorage.setItem(SAVE_SESSION_KEY, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }));
  }
}

// Returns saved tokens for re-authentication during MFA verify
export function getSavedTokens() {
  try {
    const raw = localStorage.getItem(SAVE_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearSavedSession() {
  localStorage.removeItem(SAVE_LOGIN_KEY);
  localStorage.removeItem(SAVE_SESSION_KEY);
}
