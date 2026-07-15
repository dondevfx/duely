import { getCurrentSession } from './supabase';

const BASE = import.meta.env.VITE_API_URL || '/api';

// Reads the in-memory session — synchronous, no Supabase state machine, no lock contention.
function getAuthHeaders() {
  const sess = getCurrentSession();
  if (!sess?.access_token) return {};
  return { Authorization: `Bearer ${sess.access_token}` };
}

async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
    ...options.headers,
  };
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  // Tolerate non-JSON responses (proxy/CDN 502s, timeouts, empty bodies) so the
  // user sees a clean error instead of "Unexpected token < in JSON".
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: (path, body) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),
};
