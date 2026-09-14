/**
 * Self-exclusion: a player locks their own account until a date they choose.
 *
 * While locked they cannot start any match, join a tournament, tip, or get a
 * deposit address. They CAN still sign in, look around, and withdraw: a lock
 * that trapped their money inside it would be a punishment, not a tool.
 *
 * A lock can be extended but never shortened or lifted early. That is the
 * point of it: the decision is made in advance, when the player is thinking
 * clearly, and cannot be undone on impulse.
 *
 * Stored as profiles.self_excluded_until (PENDING_SQL section 23). Read through
 * a short cache, because the gate runs on every game-start event; a lock set in
 * this process updates the cache at once.
 */
const CACHE_MS = 30 * 1000;
const cache = new Map(); // userId -> { until: ms (0 = none), at: ms }

async function excludedUntil(supabase, userId) {
  if (!userId) return 0;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.until;
  if (!supabase) return 0;
  let until = 0;
  try {
    const { data, error } = await supabase
      .from('profiles').select('self_excluded_until').eq('id', userId).single();
    // A missing column (section 23 not run yet) reads as "not locked": the
    // site must keep working before the migration, and nobody can be locked
    // before it exists.
    if (!error && data?.self_excluded_until) until = Date.parse(data.self_excluded_until) || 0;
  } catch { /* treated as not locked */ }
  cache.set(userId, { until, at: Date.now() });
  return until;
}

function setExcludedUntil(userId, untilMs) {
  cache.set(userId, { until: untilMs, at: Date.now() });
}

function lockMessage(untilMs) {
  const d = new Date(untilMs);
  const day = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `Your account is locked until ${day}. You set this with self-exclusion, and it can't be lifted early.`;
}

/** For REST routes: true (and a 403 sent) if this account is locked. */
async function rejectIfExcluded(supabase, req, res) {
  const until = await excludedUntil(supabase, req.user?.id);
  if (until > Date.now()) {
    res.status(403).json({ error: lockMessage(until), selfExcluded: true, until: new Date(until).toISOString() });
    return true;
  }
  return false;
}

// Socket events that START something. Resuming a match already in progress is
// deliberately not here: a lock set mid-game must not strand the other player.
const GATED_EVENTS = /^(join_[a-z_]+_queue|play_[a-z_]+_vs_bot|create_private_room|join_private_room|request_rematch|[a-z_]+_rematch_request|wordle_solo_start|invite_friend)$/;

module.exports = { excludedUntil, setExcludedUntil, lockMessage, rejectIfExcluded, GATED_EVENTS, _cache: cache };
