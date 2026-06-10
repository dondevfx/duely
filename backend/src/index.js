require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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
const { apiLimiter, authLimiter } = require('./middleware/rateLimit');
const registerSocketHandlers = require('./socket/handlers');
const swapPoller        = require('./services/swapPoller');
const blockchainMonitor = require('./services/blockchainMonitor');

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

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Webhooks must be registered BEFORE express.json() — Stripe needs raw body for signature verification
app.use('/api/webhooks', webhookRoutes(supabase));

app.use(express.json());
app.use('/api', apiLimiter);

app.use('/api/auth', authLimiter, authRoutes(supabase));
app.use('/api/wallet', walletRoutes(supabase));
app.use('/api/leaderboard', leaderboardRoutes(supabase));
app.use('/api/match', matchRoutes(supabase));
app.use('/api/bonus', bonusRoutes(supabase));
app.use('/api/rewards', rewardsRoutes(supabase));
app.use('/api/admin', adminRoutes(supabase));
app.use('/api/affiliate', affiliateRoutes(supabase));
app.use('/api/rakeback', rakebackRoutes(supabase));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

registerSocketHandlers(io, supabase);

// JSON 404 for any unmatched API route — prevents Express returning HTML pages
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler — converts all unhandled throws to JSON (never HTML)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
});

// Start background services
swapPoller.init(supabase);
blockchainMonitor.init(supabase);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`React Duel backend running on port ${PORT}`);
});
