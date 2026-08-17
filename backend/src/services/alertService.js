/**
 * Periodic health sweep.
 *
 * The attention queue only helps if somebody looks at it. This checks it on a
 * timer and raises the ones that matter, so a stuck withdrawal surfaces before
 * the player does.
 *
 * Reports through Sentry when SENTRY_DSN is set and the console either way, so
 * it is useful with no configuration and better with it.
 */
const SWEEP_MS = 15 * 60 * 1000;

// Money owed to a real person — one is worth waking up for.
const CRITICAL = ['refund_failed', 'payout_failed', 'payout_uncertain'];
// Usually self-healing, so only interesting in bulk or when old.
//
// 'failed' is a withdrawal whose payout failed and whose refund SUCCEEDED — the
// player is whole, so one is not an emergency. In bulk it is: three in a row
// means the chain, the payout wallet or ChangeNow is down, and every player
// trying to withdraw is being turned away. That was invisible before, because
// the sweep only looked for the statuses where money was already lost.
const WARNING  = ['stuck', 'pending_retry', 'failed'];
const WARN_AT  = 3;
// A swap that has been converting for hours is not converting.
const STALE_CONVERTING_MS = 2 * 60 * 60 * 1000;

// Alert once per state, not every sweep — a problem that takes a day to fix
// should not produce 96 identical alerts, or they all get ignored.
let lastSignature = '';

function report(level, message, extra) {
  const line = `[alert:${level}] ${message}`;
  if (level === 'critical') console.error(line, extra || '');
  else console.warn(line, extra || '');
  try {
    const { Sentry, enabled } = require('../instrument');
    if (enabled) {
      Sentry.captureMessage(message, {
        level: level === 'critical' ? 'error' : 'warning',
        extra,
      });
    }
  } catch { /* monitoring must never break the sweep */ }
}

async function sweepOnce(supabase) {
  const { data } = await supabase
    .from('transactions')
    .select('id, status, amount_c, user_id, created_at')
    .in('status', [...CRITICAL, ...WARNING, 'converting'])
    .limit(500);
  if (!data) return null;

  const now = Date.now();
  const critical = data.filter(t => CRITICAL.includes(t.status));
  const warning  = data.filter(t => WARNING.includes(t.status));
  const stale    = data.filter(t => t.status === 'converting'
    && now - new Date(t.created_at).getTime() > STALE_CONVERTING_MS);

  const owed = critical.reduce((s, t) => s + (parseFloat(t.amount_c) || 0), 0);
  const signature = `${critical.length}:${warning.length}:${stale.length}`;
  const summary = { critical: critical.length, warning: warning.length, staleConverting: stale.length, owed };

  // Nothing wrong — reset so the next problem alerts even if it looks like one
  // that was already reported.
  if (!critical.length && warning.length < WARN_AT && !stale.length) {
    lastSignature = '';
    return summary;
  }
  if (signature === lastSignature) return summary;
  lastSignature = signature;

  if (critical.length) {
    report('critical',
      `${critical.length} transaction(s) need manual intervention — ${owed.toFixed(2)} coins owed`,
      { ids: critical.slice(0, 10).map(t => t.id) });
  }
  if (warning.length >= WARN_AT) {
    report('warning', `${warning.length} transactions stuck or retrying`,
      { ids: warning.slice(0, 10).map(t => t.id) });
  }
  if (stale.length) {
    report('warning', `${stale.length} deposit(s) converting for over 2h`,
      { ids: stale.slice(0, 10).map(t => t.id) });
  }
  return summary;
}

function init(supabase) {
  const run = () => sweepOnce(supabase).catch(e =>
    console.error('[alert] sweep failed:', e.message));
  // After boot settles, so a restart does not alert on rows that are about to
  // be picked up by the pollers anyway.
  setTimeout(run, 60_000);
  setInterval(run, SWEEP_MS);
  console.log('[alert] health sweep started');
}

module.exports = { init, sweepOnce, CRITICAL, WARNING, WARN_AT };
