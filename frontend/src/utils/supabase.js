import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SAVE_LOGIN_KEY = 'duely_save_login';
export const SAVE_SESSION_KEY = 'duely_saved_session';

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

// Directly write tokens to localStorage — no async, no lock needed
export function persistTokens(access_token, refresh_token) {
  if (!access_token || !refresh_token) return;
  console.log('[save-login] persisting tokens to localStorage');
  localStorage.setItem(SAVE_LOGIN_KEY, 'true');
  localStorage.setItem(SAVE_SESSION_KEY, JSON.stringify({ access_token, refresh_token }));
}

export function clearSavedSession() {
  localStorage.removeItem(SAVE_LOGIN_KEY);
  localStorage.removeItem(SAVE_SESSION_KEY);
}

// On app startup: returns { session, source } where source is 'refresh'|'saved'|null
export async function getStartupSession() {
  try {
    // sessionStorage — page refresh in same tab
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      // If this session was restored from localStorage this tab, still treat as 'saved'
      // so MFA is re-checked on refresh too
      const needsMfaCheck = sessionStorage.getItem('duely_needs_mfa_check');
      const source = needsMfaCheck ? 'saved' : 'refresh';
      console.log('[save-login] restored from sessionStorage, source:', source);
      return { session, source };
    }

    // localStorage — returning visitor with saved login
    const saved = localStorage.getItem(SAVE_LOGIN_KEY);
    const raw   = localStorage.getItem(SAVE_SESSION_KEY);
    console.log('[save-login] localStorage check — saved:', saved, 'has tokens:', !!raw);
    if (!saved) return { session: null, source: null };
    if (!raw) {
      // SAVE_LOGIN_KEY exists but tokens are missing — clear so prompt shows again on next login
      clearSavedSession();
      return { session: null, source: null };
    }

    const { access_token, refresh_token } = JSON.parse(raw);
    if (!access_token || !refresh_token) {
      clearSavedSession();
      return { session: null, source: null };
    }

    console.log('[save-login] calling setSession with saved tokens');
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) {
      console.error('[save-login] setSession error:', error);
      clearSavedSession();
      return { session: null, source: null };
    }

    // Immediately update saved tokens with any rotated values
    if (data.session) {
      persistTokens(data.session.access_token, data.session.refresh_token);
    }

    // Mark this session as a saved-login restore so a page refresh re-checks MFA
    sessionStorage.setItem('duely_needs_mfa_check', '1');

    console.log('[save-login] restored from localStorage (saved)');
    return { session: data.session, source: 'saved' };
  } catch (e) {
    console.error('[save-login] getStartupSession error:', e);
    clearSavedSession();
    return { session: null, source: null };
  }
}
