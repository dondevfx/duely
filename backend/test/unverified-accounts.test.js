// Never-verified accounts: reminders, a countdown, then deletion at day 21,
// never of an account that held money.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const U = require('../src/services/unverifiedAccounts');

const DAY = U.DAY;
const AFTER_LAUNCH = U.LAUNCH + 30 * DAY;   // well past the launch grace

function fakeSupabase(users, { coins = {}, moneyTx = {}, countFails = false } = {}) {
  const deleted = [];
  return {
    deleted,
    auth: { admin: {
      listUsers: async ({ page }) => ({ data: { users: page === 1 ? users : [] }, error: null }),
      deleteUser: async (id) => { deleted.push(id); return { error: null }; },
    } },
    from: (table) => {
      const q = { _id: null };
      q.select = () => q;
      q.eq = (_c, v) => { q._id = v; return q; };
      q.in = () => q;
      q.maybeSingle = async () => ({ data: { c_coins: coins[q._id] ?? 0 }, error: null });
      q.then = (resolve) => resolve(table === 'transactions'
        ? (countFails ? { count: null, error: { message: 'down' } } : { count: moneyTx[q._id] ?? 0, error: null })
        : { data: null, error: null });
      return q;
    },
  };
}
const user = (id, createdMs, extra = {}) => ({ id, email: `${id}@x.com`, created_at: new Date(createdMs).toISOString(), email_confirmed_at: null, app_metadata: { provider: 'email' }, ...extra });
const quiet = { error() {}, log() {} };

test('deleted at day 21, not a moment before', async () => {
  const now = AFTER_LAUNCH;
  const sb = fakeSupabase([user('old', now - 21 * DAY - 1000), user('young', now - 20 * DAY)]);
  const r = await U.sweepUnverified(sb, { now, log: quiet });
  assert.deepEqual(sb.deleted, ['old']);
  assert.equal(r.deleted.length, 1);
});

test('never deletes an account that held money, or on a failed money check', async () => {
  const now = AFTER_LAUNCH, old = now - 30 * DAY;
  const sb = fakeSupabase([user('coins', old), user('deposited', old), user('clean', old)],
    { coins: { coins: 2.5 }, moneyTx: { deposited: 1 } });
  const r = await U.sweepUnverified(sb, { now, log: quiet });
  assert.deepEqual(sb.deleted, ['clean']);
  assert.equal(r.skipped.length, 2);
  const sb2 = fakeSupabase([user('unknown', old)], { countFails: true });
  await U.sweepUnverified(sb2, { now, log: quiet });
  assert.deepEqual(sb2.deleted, [], 'deleted when it could not tell whether money was involved');
});

test('verified, Google, demo and admin accounts are never touched', async () => {
  const now = AFTER_LAUNCH, old = now - 60 * DAY;
  const sb = fakeSupabase([
    user('verified', old, { email_confirmed_at: new Date(old).toISOString() }),
    user('google', old, { app_metadata: { provider: 'google' } }),
    user('demo', old), user('admin', old),
  ]);
  await U.sweepUnverified(sb, { now, isDemo: (id) => id === 'demo', adminId: 'admin', log: quiet });
  assert.deepEqual(sb.deleted, []);
});

test('an account that existed at launch gets seven days of countdown first', async () => {
  const ancient = U.LAUNCH - 200 * DAY;
  assert.equal(U.deadlineFor(ancient), U.LAUNCH + 7 * DAY);
  const sb = fakeSupabase([user('ancient', ancient)]);
  await U.sweepUnverified(sb, { now: U.LAUNCH + 6 * DAY, log: quiet });
  assert.deepEqual(sb.deleted, [], 'deleted before its seven days were up');
});

test('the popup stages: none, one reminder from day 3, countdown for the last 7 days', async () => {
  const E = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'emailVerification.js')).href);
  for (const k of ['SOFT_AT', 'HARD_AT', 'DELETE_AT', 'MIN_COUNTDOWN', 'LAUNCH']) assert.equal(E[k], U[k], `${k} differs from the backend`);
  const created = AFTER_LAUNCH;
  const u = user('p', created);
  assert.equal(E.verificationStage(u, created + 2 * DAY).stage, 'none');
  assert.equal(E.verificationStage(u, created + 3 * DAY).stage, 'soft');
  assert.equal(E.verificationStage(u, created + 13 * DAY).stage, 'soft');
  const h = E.verificationStage(u, created + 15 * DAY);
  assert.equal(h.stage, 'hard', 'day 15 should go straight to the countdown');
  assert.equal(h.deadline, created + 21 * DAY);
  assert.equal(E.verificationStage({ ...u, email_confirmed_at: 'x' }, created + 15 * DAY).stage, 'none');
});

test('the popup is mounted, and the authenticator label is "Duely: username"', () => {
  const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
  assert.ok(fe('App.jsx').includes('<VerifyEmailPrompt />'));
  assert.ok(fe('pages', 'Profile.jsx').includes('otpauth://totp/Duely:${encodeURIComponent(profile?.username'));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8').includes('startUnverifiedSweep(supabase'));
});
