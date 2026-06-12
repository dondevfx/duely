import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Supabase client used ONLY for network operations:
// signInWithPassword, signOut, refreshSession, MFA, getUser (backend).
// persistSession:false  → Supabase never touches storage (we own storage).
// autoRefreshToken:false → Supabase never runs a timer (we own the timer).
// detectSessionInUrl:false → no OAuth redirect handling.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// ── Our own session storage ────────────────────────────────────────────────
// sessionStorage: lives for the tab's lifetime, cleared on tab close.
// We own reads/writes — no Supabase state machine involved.

const SESSION_KEY = 'duely_session';
export const SAVE_LOGIN_KEY = 'duely_save_login';
export const SAVE_SESSION_KEY = 'duely_saved_session';

// In-memory reference — kept in sync with sessionStorage.
// api.js and SocketContext read this for zero-async token access.
let _currentSession = null;
const _sessionListeners = [];

export function getCurrentSession() {
  return _currentSession;
}

// Subscribe to session changes (sign-in, refresh, sign-out).
// Returns an unsubscribe function.
export function onSessionChange(cb) {
  _sessionListeners.push(cb);
  return () => {
    const i = _sessionListeners.indexOf(cb);
    if (i >= 0) _sessionListeners.splice(i, 1);
  };
}

export function storeSession(sess) {
  _currentSession = sess;
  if (sess) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
  _sessionListeners.forEach(cb => cb(sess));
}

export function readSessionFromStorage() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Save-login (localStorage) ──────────────────────────────────────────────

export function persistTokens(access_token, refresh_token) {
  if (!access_token || !refresh_token) return;
  localStorage.setItem(SAVE_LOGIN_KEY, 'true');
  localStorage.setItem(SAVE_SESSION_KEY, JSON.stringify({ access_token, refresh_token }));
}

export function clearSavedSession() {
  localStorage.removeItem(SAVE_LOGIN_KEY);
  localStorage.removeItem(SAVE_SESSION_KEY);
}

export function loadSavedTokens() {
  try {
    if (!localStorage.getItem(SAVE_LOGIN_KEY)) return null;
    const raw = localStorage.getItem(SAVE_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// ── Token refresh ──────────────────────────────────────────────────────────

// Calls Supabase's refresh endpoint and returns the new session, or null on failure.
export async function doTokenRefresh(refresh_token) {
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error || !data?.session) return null;
    return data.session;
  } catch { return null; }
}
