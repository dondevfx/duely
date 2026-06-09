const { createClient } = require('@supabase/supabase-js');

// Singleton anon client — reused across requests to avoid creating a new
// TCP connection and TLS handshake on every API call.
let _anonClient = null;
function getAnonClient() {
  if (!_anonClient) {
    _anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return _anonClient;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = header.slice(7);
  const { data: { user }, error } = await getAnonClient().auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = user;
  next();
}

module.exports = { requireAuth };
