// Sentry error monitoring — initialised as early as possible so it can capture
// errors from the rest of the app. This is a NO-OP when SENTRY_DSN is not set,
// so the backend runs exactly as before until you paste in a key.
require('dotenv').config();
const Sentry = require('@sentry/node');

const enabled = !!process.env.SENTRY_DSN;

if (enabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Error monitoring only — no performance tracing overhead / cost.
    tracesSampleRate: 0,
    // Don't send local dev noise unless a DSN is explicitly set (it is, here).
  });
  console.log('[sentry] error monitoring enabled');
} else {
  console.log('[sentry] SENTRY_DSN not set — error monitoring disabled (safe)');
}

module.exports = { Sentry, enabled };
