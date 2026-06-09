const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
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
