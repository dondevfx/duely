import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SAVE_LOGIN_KEY = 'duely_save_login';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false,       // never auto-persist — we handle this manually
    detectSessionInUrl: true,
    storageKey: 'duely_auth',
  },
});

// Call this after login if user chose to save — manually persists the session
export async function saveSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    localStorage.setItem(SAVE_LOGIN_KEY, 'true');
    localStorage.setItem('duely_auth', JSON.stringify(session));
  }
}

// Call on app start — restores saved session if user previously chose to save
export async function restoreSavedSession() {
  const saved = localStorage.getItem(SAVE_LOGIN_KEY);
  if (!saved) return null;
  const raw = localStorage.getItem('duely_auth');
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    const { data, error } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (error) {
      // Token expired / invalid — clear saved login
      localStorage.removeItem(SAVE_LOGIN_KEY);
      localStorage.removeItem('duely_auth');
      return null;
    }
    return data.session;
  } catch {
    localStorage.removeItem(SAVE_LOGIN_KEY);
    localStorage.removeItem('duely_auth');
    return null;
  }
}

// Clear saved session on sign out
export function clearSavedSession() {
  localStorage.removeItem(SAVE_LOGIN_KEY);
  localStorage.removeItem('duely_auth');
}
