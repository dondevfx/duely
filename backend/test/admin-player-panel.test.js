// The admin player-detail panel: real account bans (the only ban that
// existed before this was chatBanned — in-memory, chat-only, gone on
// restart, and nothing else on the platform respected it), and manual
// balance adjustments that go through the same atomic RPCs and leave the
// same transaction trail every other balance change in this app does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const ADMIN    = strip(read('src', 'routes', 'admin.js'));
const WALLET   = strip(read('src', 'routes', 'wallet.js'));
const HANDLERS = strip(read('src', 'socket', 'handlers.js'));

function route(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `${marker} is gone`);
  const open = src.indexOf('{', src.indexOf('async (req, res)', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces reading ${marker}`);
}

// ── Ban enforcement ──────────────────────────────────────────────────────

test('a banned account cannot authenticate a socket at all', () => {
  const at = HANDLERS.indexOf("socket.on('authenticate'");
  const body = HANDLERS.slice(at, HANDLERS.indexOf("socket.on('", at + 20));
  assert.match(body, /banned,ban_reason|banned, ban_reason/,
    'the profile select must fetch banned status, or there is nothing to check');
  const bannedCheckAt = body.indexOf('if (profile.banned)');
  assert.notEqual(bannedCheckAt, -1, 'the banned check is gone');
  const setsUserAt = body.indexOf('authenticatedUser = {');
  assert.ok(bannedCheckAt < setsUserAt,
    'the banned check must run BEFORE authenticatedUser is set, or a banned account gets a working session anyway');
  assert.match(body.slice(bannedCheckAt, bannedCheckAt + 200), /return;/,
    'the banned branch must actually stop, not just emit an error and continue');
});

test('withdrawalGuards checks banned as a backstop, independent of the socket gate', () => {
  // The socket gate stops a NEW session; a JWT issued before the ban can
  // still be valid after it. Withdrawal is the one place that gap cannot be
  // left open even briefly.
  const at = WALLET.indexOf('async function withdrawalGuards');
  const body = WALLET.slice(at, WALLET.indexOf("router.post('/withdraw'", at));
  assert.match(body, /\.select\('banned, ban_reason'\)/, 'must read banned status');
  assert.match(body, /if \(p\?\.banned\)/, 'must actually branch on it');
});

// ── Ban / unban routes ───────────────────────────────────────────────────

test('banning requires a reason', () => {
  const body = route(ADMIN, "router.post('/users/:id/ban'");
  assert.match(body, /if \(!reason\)/, 'an empty reason must be rejected — it is what the player sees');
});

test('ban and unban both require admin', () => {
  for (const marker of ["router.post('/users/:id/ban'", "router.post('/users/:id/unban'"]) {
    const at = ADMIN.indexOf(marker);
    assert.notEqual(at, -1, `${marker} is gone`);
    assert.match(ADMIN.slice(at, at + 100), /requireAuth, requireAdmin/, `${marker} must require an admin`);
  }
});

// ── Manual balance adjustment ────────────────────────────────────────────

test('an adjustment requires a non-zero amount and a note', () => {
  const body = route(ADMIN, "router.post('/users/:id/adjust-balance'");
  assert.match(body, /!Number\.isFinite\(amount\) \|\| amount === 0/, 'zero or NaN must be rejected');
  assert.match(body, /if \(!note\)/, 'a note must be required — it is the only record of why a hand-edit happened');
});

test('a single adjustment is capped, as a typo guard', () => {
  const body = route(ADMIN, "router.post('/users/:id/adjust-balance'");
  assert.match(body, /Math\.abs\(amount\) > 50_000/,
    'an admin fat-fingering an extra zero must not be able to move an unbounded amount in one request');
});

test('the adjustment goes through the same atomic credit/deduct every other balance change uses', () => {
  const body = route(ADMIN, "router.post('/users/:id/adjust-balance'");
  assert.match(body, /await creditCoins\(supabase, id, amount\)/, 'a positive adjustment must use creditCoins, not a raw update');
  assert.match(body, /await deductCoins\(supabase, id, Math\.abs\(amount\)\)/, 'a negative adjustment must use deductCoins, which fails on insufficient balance');
});

test('every adjustment writes a transaction row of the new admin_adjustment type', () => {
  const body = route(ADMIN, "router.post('/users/:id/adjust-balance'");
  assert.match(body, /type: 'admin_adjustment'/, 'a balance move with no transaction row is invisible to every audit this session built');
  assert.match(body, /notes: `\$\{note\} \(by \$\{req\.user\.id\}\)`/, 'the record must say who did it and why, not just how much');
});

test('a transaction-write failure after a successful balance move is escalated, not swallowed', () => {
  // The money has already moved and cannot be silently retried without
  // risking a double-adjustment — this needs to be loud, the same pattern
  // the fiat withdrawal route already uses for the same situation.
  const body = route(ADMIN, "router.post('/users/:id/adjust-balance'");
  assert.match(body, /console\.error\(`\[admin\] CRITICAL/, 'a lost transaction record for a real balance move must not fail silently');
});

test('adjust-balance requires admin', () => {
  const at = ADMIN.indexOf("router.post('/users/:id/adjust-balance'");
  assert.match(ADMIN.slice(at, at + 100), /requireAuth, requireAdmin/);
});

test('the player-detail route requires admin and returns one combined payload', () => {
  const at = ADMIN.indexOf("router.get('/users/:id'");
  assert.notEqual(at, -1, 'the player-detail route is gone');
  assert.match(ADMIN.slice(at, at + 100), /requireAuth, requireAdmin/);
  const body = route(ADMIN, "router.get('/users/:id'");
  // The profile is now spread with email/email_confirmed_at read from
  // auth.users, so this checks the three PARTS are all present rather than
  // pinning one exact literal.
  assert.match(body, /res\.json\(\{/, 'the route must return a combined payload');
  assert.match(body, /profile: \{ \.\.\.resolvedProfile/, 'profile must be included');
  assert.match(body, /transactions: transactions \|\| \[\]/, 'transactions must be included');
  assert.match(body, /matches,/, 'matches must be included');
});
