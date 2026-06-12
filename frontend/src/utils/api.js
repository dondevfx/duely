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
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: (path, body) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
};
