import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SAVE_LOGIN_KEY = 'duely_save_login';
const SAVE_SESSION_KEY = 'duely_saved_session';

// Use sessionStorage so session survives page refresh but NOT tab/browser close.
// If user chose "Save login", we additionally persist to localStorage.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: window.sessionStorage,
    storageKey: 'duely_session',
  },
});

// Call after login when user clicks Save — persists session to localStorage
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

// Called on app startup — restores saved session from localStorage if user chose to save
export async function restoreSavedSession() {
  try {
    // First check if there's already a session in sessionStorage (page refresh case)
    const { data: { session: existing } } = await supabase.auth.getSession();
    if (existing) return existing;

    // Then check localStorage for a saved login
    const saved = localStorage.getItem(SAVE_LOGIN_KEY);
    if (!saved) return null;
    const raw = localStorage.getItem(SAVE_SESSION_KEY);
    if (!raw) return null;
    const { access_token, refresh_token } = JSON.parse(raw);
    if (!access_token || !refresh_token) return null;
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) {
      clearSavedSession();
      return null;
    }
    return data.session;
  } catch {
    clearSavedSession();
    return null;
  }
}

// Clear saved session on sign out
export function clearSavedSession() {
  localStorage.removeItem(SAVE_LOGIN_KEY);
  localStorage.removeItem(SAVE_SESSION_KEY);
}
