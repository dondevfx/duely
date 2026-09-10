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

/**
 * The money endpoints, per ACCOUNT rather than per IP.
 *
 * Defence in depth and nothing more. Every operation behind this is already
 * safe to repeat — claims are single conditional statements, deposits dedupe
 * on the transaction hash, deductions are guarded by the balance in the same
 * UPDATE — so an attacker who works around this limit gains nothing. It exists
 * to make a burst expensive and visible rather than to be the thing standing
 * between anyone and the balance.
 *
 * Keyed on the SESSION TOKEN, not the IP and not the user id.
 *
 * Not the IP, because a household or a mobile carrier NAT shares one and a
 * single player hammering claims should not lock out their neighbours.
 *
 * Not the user id either, for two reasons. This middleware runs before the
 * router's own requireAuth, so req.user does not exist yet; and reading the id
 * out of the token WITHOUT verifying it would let anyone spend a victim's
 * budget by sending their user id, turning a rate limit into a way to lock
 * somebody out of their own wallet. The token itself cannot be guessed, so
 * hashing it gives a per-session bucket with nothing to forge. Hashed rather
 * than used raw so a credential never becomes a map key or reaches a log.
 *
 * Generous on purpose. Sixty in five minutes is far more than any real session
 * produces — a tip, a claim, a withdrawal are all things a person does once —
 * and far less than a script needs to be worth writing.
 */
const crypto = require('crypto');
const moneyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ') && header.length > 20) {
      return 's:' + crypto.createHash('sha256').update(header.slice(7)).digest('hex').slice(0, 32);
    }
    return 'ip:' + req.ip;
  },
  message: { error: 'Too many requests. Wait a moment and try again.' },
  handler: (req, res, _next, options) => {
    // Logged, because a real player does not reach this and a script does.
    // This is the signal, not the block.
    console.warn(`[ratelimit] money endpoint flood ip=${req.ip} path=${req.originalUrl}`);
    res.status(options.statusCode).json(options.message);
  },
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

module.exports = { apiLimiter, authLimiter, moneyLimiter, checkSocketClickRate, cleanupSocket };
