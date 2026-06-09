import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SAVE_LOGIN_KEY = 'duely_save_login';
const SAVE_SESSION_KEY = 'duely_saved_session';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false,       // never auto-persist — we handle this manually
    detectSessionInUrl: true,
  },
});

// Call this after login if user chose to save — manually persists the session
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

// Call on app start — restores saved session if user previously chose to save
export async function restoreSavedSession() {
  try {
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
