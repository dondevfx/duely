/**
 * Accounts whose email is never verified are deleted, which frees the email.
 *
 * The timeline, from when the account was created:
 *   day 3    one reminder, the next time they open the site
 *   day 14   a popup on every visit, counting down to deletion
 *   day 21   the account is deleted
 * The same numbers live in frontend/src/utils/emailVerification.js, which
 * decides what the popups show; a test holds the two together.
 *
 * Two guards, because deletion cannot be undone:
 *
 * 1. Money. Deleting an account cascades to its transactions, so an account
 *    that ever held real money is NEVER deleted here: any coins, or any
 *    deposit, withdrawal or tip on record, and it is skipped and logged for a
 *    person to decide. Only never-funded accounts are removed.
 *
 * 2. Warning. Accounts that already existed when this shipped would otherwise
 *    be deleted on the first sweep with no warning at all, so every account
 *    gets at least seven days of countdown from LAUNCH.
 *
 * Only email sign-ups are considered: an account made with Google has a
 * provider-verified email. Demo accounts and the admin are never touched.
 * Set UNVERIFIED_SWEEP=off to stop the deletions entirely.
 */
const DAY = 24 * 60 * 60 * 1000;
const SOFT_AT   = 3 * DAY;
const HARD_AT   = 14 * DAY;
const DELETE_AT = 21 * DAY;
const MIN_COUNTDOWN = 7 * DAY;
// The day this shipped (UTC). See guard 2 above.
const LAUNCH = Date.UTC(2026, 8, 14);

const MONEY_TYPES = ['deposit', 'deposit_raw', 'withdrawal', 'tip_sent', 'tip_received'];

function deadlineFor(createdMs) {
  return Math.max(createdMs + DELETE_AT, LAUNCH + MIN_COUNTDOWN);
}

function isEmailSignup(user) {
  const provider = user?.app_metadata?.provider;
  return !provider || provider === 'email';
}

async function hasMoney(supabase, userId) {
  const { data: profile } = await supabase
    .from('profiles').select('c_coins').eq('id', userId).maybeSingle();
  if ((parseFloat(profile?.c_coins) || 0) > 0) return 'holds coins';
  const { count, error } = await supabase
    .from('transactions').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).in('type', MONEY_TYPES);
  // If the check itself fails, treat it as money: never delete on a guess.
  if (error) return `money check failed: ${error.message}`;
  if ((count ?? 0) > 0) return 'has deposit/withdrawal/tip history';
  return null;
}

/**
 * One pass. Returns what it did, for logs and tests.
 * `isDemo(userId)` and `adminId` keep those accounts out.
 */
async function sweepUnverified(supabase, { isDemo = () => false, adminId = null, now = Date.now(), log = console } = {}) {
  const out = { deleted: [], skipped: [] };
  if (!supabase?.auth?.admin) return out;
  const perPage = 1000;
  for (let page = 1; page < 1000; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) { log.error('[unverified] listUsers failed:', error.message); break; }
    const users = data?.users || [];
    for (const u of users) {
      if (u.email_confirmed_at || !isEmailSignup(u)) continue;
      if (u.id === adminId || isDemo(u.id)) continue;
      const created = Date.parse(u.created_at);
      if (!Number.isFinite(created) || now < deadlineFor(created)) continue;

      const money = await hasMoney(supabase, u.id);
      if (money) {
        out.skipped.push({ id: u.id, email: u.email, reason: money });
        log.error(`[unverified] NOT deleting unverified account ${u.id} (${u.email}): ${money}. Needs a person to decide.`);
        continue;
      }
      const { error: delErr } = await supabase.auth.admin.deleteUser(u.id);
      if (delErr) {
        out.skipped.push({ id: u.id, email: u.email, reason: `delete failed: ${delErr.message}` });
        log.error(`[unverified] delete failed for ${u.id}:`, delErr.message);
      } else {
        out.deleted.push({ id: u.id, email: u.email });
      }
    }
    if (users.length < perPage) break;
  }
  if (out.deleted.length) log.log?.(`[unverified] deleted ${out.deleted.length} never-verified account(s)`);
  return out;
}

function startUnverifiedSweep(supabase, opts = {}) {
  if (process.env.UNVERIFIED_SWEEP === 'off') {
    console.log('[unverified] sweep disabled (UNVERIFIED_SWEEP=off)');
    return null;
  }
  const run = () => sweepUnverified(supabase, opts).catch(e => console.error('[unverified] sweep:', e.message));
  const first = setTimeout(run, 60 * 1000);
  const every = setInterval(run, 6 * 60 * 60 * 1000);
  first.unref?.(); every.unref?.();
  return { first, every };
}

module.exports = {
  sweepUnverified, startUnverifiedSweep, deadlineFor,
  DAY, SOFT_AT, HARD_AT, DELETE_AT, MIN_COUNTDOWN, LAUNCH, MONEY_TYPES,
};
