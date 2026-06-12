const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Singleton anon client — reused across requests.
let _anonClient = null;
function getAnonClient() {
  if (!_anonClient) {
    _anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return _anonClient;
}

// In-memory token cache — keyed by the raw JWT string.
// Prevents hammering Supabase's getUser API on rapid page refreshes
// (4 refreshes in quick succession was triggering rate limits / latency spikes).
const _tokenCache = new Map(); // token → { user, validUntil }

// Cleanup expired entries every 60 s so the map doesn't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _tokenCache) {
    if (v.validUntil <= now) _tokenCache.delete(k);
  }
}, 60_000).unref();

// Decode JWT expiry without verifying the signature (used only to set cache TTL).
function _jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

/**
 * Verify a Bearer token.
 * 1. If SUPABASE_JWT_SECRET is set, verify the signature locally — zero network calls.
 * 2. Otherwise fall back to Supabase getUser, but cache the result for up to 30 s
 *    so repeated calls with the same token hit the cache, not the Supabase API.
 *
 * Returns the user object on success, or null on failure.
 */
async function verifyToken(token) {
  // Fast path: local verification with JWT secret (no network call, no rate limits).
  if (process.env.SUPABASE_JWT_SECRET) {
    try {
      const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
      // Build a minimal user object compatible with what Supabase returns.
      return {
        id: payload.sub,
        email: payload.email ?? null,
        role: payload.role ?? 'authenticated',
        app_metadata: payload.app_metadata ?? {},
        user_metadata: payload.user_metadata ?? {},
      };
    } catch {
      return null; // invalid signature or expired
    }
  }

  // Slow path: check cache first, then call Supabase.
  const cached = _tokenCache.get(token);
  if (cached && cached.validUntil > Date.now()) return cached.user;

  const { data: { user }, error } = await getAnonClient().auth.getUser(token);
  if (error || !user) {
    _tokenCache.delete(token);
    return null;
  }

  // Cache until token expiry or 30 s from now, whichever is sooner.
  const expMs  = _jwtExpMs(token);
  const ceiling = Date.now() + 30_000;
  const validUntil = expMs ? Math.min(expMs, ceiling) : ceiling;
  _tokenCache.set(token, { user, validUntil });
  return user;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const user = await verifyToken(header.slice(7));
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

module.exports = { requireAuth, verifyToken };
