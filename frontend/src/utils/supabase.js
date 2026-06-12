import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SAVE_LOGIN_KEY = 'duely_save_login';
export const SAVE_SESSION_KEY = 'duely_saved_session';

// When true, removeItem calls for the session key are passed through (user sign-out).
// When false (default), they are silently dropped to prevent spurious sign-outs.
let _allowSessionRemoval = false;
export function allowSessionRemoval() { _allowSessionRemoval = true; }

// Custom storage wrapper: intercepts removeItem for the session key so that Supabase's
// internal _removeSession() calls (triggered by spurious SIGNED_OUT from rapid refresh,
// BroadcastChannel from old page, etc.) don't actually delete the session from storage.
// Supabase reads from storage on every getSession() call, so keeping it intact means
// the session survives even after Supabase fires SIGNED_OUT internally.
// The lock is a no-op: sessionStorage is per-tab, no cross-tab conflicts exist.
const SESSION_KEY = 'duely_session';
const guardedStorage = {
  getItem:    (key)        => window.sessionStorage.getItem(key),
  setItem:    (key, value) => window.sessionStorage.setItem(key, value),
  removeItem: (key) => {
    if (key === SESSION_KEY && !_allowSessionRemoval) return; // block spurious removal
    _allowSessionRemoval = false; // reset after an authorized removal
    window.sessionStorage.removeItem(key);
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: guardedStorage,
    storageKey: SESSION_KEY,
    lock: (_name, _acquireTimeout, fn) => fn(),
  },
});

// Directly write tokens to localStorage — no async, no lock needed
export function persistTokens(access_token, refresh_token) {
  if (!access_token || !refresh_token) return;
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
      const needsMfaCheck = sessionStorage.getItem('duely_needs_mfa_check');
      const source = needsMfaCheck ? 'saved' : 'refresh';
      return { session, source };
    }

    // localStorage — returning visitor with saved login
    const saved = localStorage.getItem(SAVE_LOGIN_KEY);
    const raw   = localStorage.getItem(SAVE_SESSION_KEY);
    if (!saved) return { session: null, source: null };
    if (!raw) {
      clearSavedSession();
      return { session: null, source: null };
    }

    const { access_token, refresh_token } = JSON.parse(raw);
    if (!access_token || !refresh_token) {
      clearSavedSession();
      return { session: null, source: null };
    }

    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) {
      clearSavedSession();
      return { session: null, source: null };
    }

    if (data.session) {
      persistTokens(data.session.access_token, data.session.refresh_token);
    }

    sessionStorage.setItem('duely_needs_mfa_check', '1');
    return { session: data.session, source: 'saved' };
  } catch (e) {
    console.error('[save-login] getStartupSession error:', e);
    return { session: null, source: null };
  }
}
