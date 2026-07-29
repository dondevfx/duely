const rateLimit = require('express-rate-limit');

// 200/15min (~13 req/min) was far too tight for an interactive app: the client
// refreshes the profile after every match/balance change and polls the deposit
// balance every 10s, so an active session exhausted the budget and then every
// API call 429'd — the app looked frozen and even login broke (/auth/me).
// Limits are per-IP, so players sharing a network (household, mobile carrier
// NAT) share one bucket, which made it worse. 1000/15min (~66/min sustained)
// still blocks scraping/abuse with plenty of headroom for real play.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Login/signup attempts — tight enough to stop brute force, but not so tight
// that everyone behind one IP gets locked out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  message: { error: 'Too many auth attempts, please try again later.' },
});

// Per-socket click rate tracking (in-memory)
const socketClickTimes = new Map();

function checkSocketClickRate(socketId) {
  const now = Date.now();
  const times = socketClickTimes.get(socketId) || [];
  const recent = times.filter(t => now - t < 1000);
  recent.push(now);
  socketClickTimes.set(socketId, recent);
  return recent.length <= 5;
}

function cleanupSocket(socketId) {
  socketClickTimes.delete(socketId);
}

module.exports = { apiLimiter, authLimiter, checkSocketClickRate, cleanupSocket };
