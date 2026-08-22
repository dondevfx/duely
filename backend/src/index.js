// Sentry must be required/initialised before anything else so it can
// instrument the app. No-op until SENTRY_DSN is set. (Also loads dotenv.)
const { Sentry, enabled: sentryEnabled } = require('./instrument');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const leaderboardRoutes = require('./routes/leaderboard');
const matchRoutes = require('./routes/match');
const bonusRoutes = require('./routes/bonus');
const rewardsRoutes = require('./routes/rewards');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const affiliateRoutes = require('./routes/affiliate');
const rakebackRoutes = require('./routes/rakeback');
const kycRoutes      = require('./routes/kyc');
const supportRoutes = require('./routes/support');
const { apiLimiter, authLimiter } = require('./middleware/rateLimit');
const registerSocketHandlers = require('./socket/handlers');
const swapPoller        = require('./services/swapPoller');
const blockchainMonitor = require('./services/blockchainMonitor');
const tickerService     = require('./services/tickerService');

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',');

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Trust Railway's reverse proxy so rate-limiter sees real client IPs
app.set('trust proxy', 1);

// Security headers. This is a JSON API consumed cross-origin by the frontend,
// so CSP (meant for HTML pages) is disabled and CORP is set to cross-origin —
// the valuable protections (HSTS, no-sniff, hide X-Powered-By, etc.) stay on.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Webhooks must be registered BEFORE express.json() — Stripe needs raw body for signature verification
app.use('/api/webhooks', webhookRoutes(supabase));

app.use(express.json());
app.use('/api', apiLimiter);

// /me is a frequent profile-read — register it before authLimiter so it
// only hits the generous apiLimiter, not the tight auth rate limit.
const { requireAuth } = require('./middleware/auth');
const _supabaseRef = supabase;
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data, error } = await _supabaseRef.from('profiles').select('*').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Profile not found' });
  const { isDemo } = require('./services/demoAccounts');
  res.json({ ...data, is_admin: req.user.id === process.env.ADMIN_USER_ID, is_demo: isDemo(req.user.id) });
});
app.use('/api/auth', authLimiter, authRoutes(supabase));
app.use('/api/wallet', walletRoutes(supabase, io));
app.use('/api/leaderboard', leaderboardRoutes(supabase));
app.use('/api/match', matchRoutes(supabase));
app.use('/api/bonus', bonusRoutes(supabase));
app.use('/api/rewards', rewardsRoutes(supabase));
app.use('/api/admin', adminRoutes(supabase, io));
app.use('/api/support', supportRoutes(supabase, io));
app.use('/api/affiliate', affiliateRoutes(supabase));
app.use('/api/rakeback', rakebackRoutes(supabase));
app.use('/api/kyc', kycRoutes(supabase));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ping',   (_req, res) => res.send('pong'));

registerSocketHandlers(io, supabase);

// JSON 404 for any unmatched API route — prevents Express returning HTML pages
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Sentry error handler — reports thrown errors before our handler formats them.
// No-op when Sentry isn't configured. Must come after routes, before ours.
if (sentryEnabled) Sentry.setupExpressErrorHandler(app);

// Global error handler — converts all unhandled throws to JSON (never HTML)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
});

// Start background services
swapPoller.init(supabase);
blockchainMonitor.init(supabase);
tickerService.init(io, supabase);
require('./services/alertService').init(supabase);

// Refund any match that was interrupted by the previous process exiting —
// entry fees were taken but the in-memory room died, so nobody was ever paid.
require('./services/escrowService').refundAbandonedEscrows(supabase).catch(e =>
  console.error('[escrow] startup sweep error:', e.message)
);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`React Duel backend running on port ${PORT}`);
});
