// Friend invite links. Shared with people who have no account yet, so the risky
// parts are not the happy path — they are: the link must not add you to
// yourself, must not leak a user id to an anonymous caller, must not be able to
// double-add, and the pending-invite handoff must not outlive the sign-up flow
// and hijack an unrelated login later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
const pendingSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'pendingInvite.js'), 'utf8');

function loadPending() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const body = pendingSrc.replace(/export /g, '');
  const fn = new Function('localStorage',
    `${body}; return { savePendingInvite, takePendingInvite };`);
  return { ...fn(localStorage), store };
}

// ── the handoff across sign-up ──────────────────────────────────────────

test('an invite survives being saved and taken', () => {
  const { savePendingInvite, takePendingInvite } = loadPending();
  savePendingInvite('alice');
  assert.equal(takePendingInvite().route, '/add-friend/alice');
});

test('taking it clears it, so it cannot fire twice', () => {
  const { savePendingInvite, takePendingInvite } = loadPending();
  savePendingInvite('alice');
  takePendingInvite();
  assert.equal(takePendingInvite(), null,
    'a leftover invite would hijack the next unrelated login');
});

test('a stale invite is ignored', () => {
  const { savePendingInvite, takePendingInvite, store } = loadPending();
  savePendingInvite('alice');
  const v = JSON.parse(store['duely.pendingFriendInvite']);
  v.at = Date.now() - 2 * 60 * 60 * 1000;          // two hours ago
  store['duely.pendingFriendInvite'] = JSON.stringify(v);
  assert.equal(takePendingInvite(), null, 'the TTL must drop it');
});

test('usernames needing encoding round-trip safely', () => {
  const { savePendingInvite, takePendingInvite } = loadPending();
  savePendingInvite('a b&c');
  assert.equal(takePendingInvite().route, '/add-friend/a%20b%26c');
});

test('corrupt storage does not throw', () => {
  const { takePendingInvite, store } = loadPending();
  store['duely.pendingFriendInvite'] = 'not json';
  assert.equal(takePendingInvite(), null);
});

test('nothing stored means nothing to resume', () => {
  assert.equal(loadPending().takePendingInvite(), null);
});

// ── the endpoints ───────────────────────────────────────────────────────

const publicRoute = authSrc.slice(
  authSrc.indexOf("router.get('/friend-invite/:username'"),
  authSrc.indexOf("router.post('/friend-invite/:username'"));

const claimRoute = authSrc.slice(
  authSrc.indexOf("router.post('/friend-invite/:username'"),
  authSrc.indexOf("router.post('/friend-accept/:id'"));

test('the public lookup does not require auth', () => {
  // It has to render for someone who has not signed up yet.
  assert.ok(!/requireAuth/.test(publicRoute),
    'gating this would show a login wall instead of who invited them');
});

test('the public lookup does not hand out the user id', () => {
  assert.ok(/const \{ id, \.\.\.safe \} = p/.test(publicRoute),
    'an anonymous caller must not be able to harvest user ids by username');
  assert.ok(/res\.json\(safe\)/.test(publicRoute));
});

test('claiming requires auth', () => {
  assert.ok(/requireAuth/.test(claimRoute),
    'anyone could otherwise add strangers to each other');
});

test('you cannot friend yourself with your own link', () => {
  assert.ok(/inviter\.id === myId/.test(claimRoute));
});

test('admin and demo accounts are excluded from both routes', () => {
  assert.ok(/ADMIN_ID/.test(publicRoute) && /isDemo/.test(publicRoute));
  assert.ok(/ADMIN_ID/.test(claimRoute) && /isDemo/.test(claimRoute));
});

test('an existing friendship is reported, not duplicated', () => {
  assert.ok(/alreadyFriends: true/.test(claimRoute));
  const idx = claimRoute.indexOf('alreadyFriends');
  assert.ok(claimRoute.indexOf('.insert(') > idx,
    'the already-friends check must come before any insert');
});

test('a pending request in either direction is accepted, not duplicated', () => {
  assert.ok(/requester_id\.eq\.\$\{myId\},addressee_id\.eq\.\$\{inviter\.id\}/.test(claimRoute) &&
            /requester_id\.eq\.\$\{inviter\.id\},addressee_id\.eq\.\$\{myId\}/.test(claimRoute),
    'the lookup must cover both directions or a reversed request duplicates');
  assert.ok(/status: 'accepted' \}\)\.eq\('id', existing\.id\)/.test(claimRoute));
});

test('the link skips the pending step', () => {
  // Both sides consented: one published the link, the other opened it.
  assert.ok(/insert\(\{ requester_id: inviter\.id, addressee_id: myId, status: 'accepted' \}\)/.test(claimRoute),
    'a link invite must land as accepted, not pending');
});

test('a lost insert race still reports success', () => {
  // Two tabs opening the same link: the loser must not show an error for an
  // outcome that did happen.
  const tail = claimRoute.slice(claimRoute.indexOf('if (error) {'));
  assert.ok(/maybeSingle\(\)/.test(tail) && /if \(now\) return res\.json/.test(tail),
    'on insert failure it must re-check before reporting failure');
});

test('the invite route is reachable without being logged in', () => {
  const app = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf8');
  const line = app.split('\n').find((l) => l.includes('/add-friend/:username'));
  assert.ok(line, 'the route must exist');
  assert.ok(!/ProtectedRoute/.test(line),
    'wrapping it would break the whole point — new users have no account yet');
});
