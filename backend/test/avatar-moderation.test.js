// Profile pictures — the platform's first user-generated content, and the
// moderation standing between an upload and every other player seeing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { flattenScores, SAFE_LEAF, REJECT_AT } = require('../src/services/imageModeration');
const { sniff, MAX_BYTES, ALLOWED } = require('../src/routes/avatar');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

// Mirrors the route's decision so the scoring rules can be exercised without
// a network call.
function worstViolation(models) {
  const scores = flattenScores(models);
  let worst = null;
  for (const [p, v] of Object.entries(scores)) {
    if (SAFE_LEAF.test(p)) continue;
    if (v >= REJECT_AT && (!worst || v > worst.score)) worst = { path: p, score: v };
  }
  return worst;
}

// ── Score interpretation ────────────────────────────────────────────────

test('a clean image passes', () => {
  const clean = {
    nudity: { sexual_activity: 0.01, sexual_display: 0.02, erotica: 0.03, none: 0.99 },
    gore:   { prob: 0.01 },
    weapon: { classes: { firearm: 0.00, knife: 0.01 } },
  };
  assert.equal(worstViolation(clean), null);
});

test('a high "none" score is not treated as a violation', () => {
  // nudity.none = 0.99 means "definitely NOT nudity". Reading it as a
  // violation score would reject every clean photo — the inversion SAFE_LEAF
  // exists to prevent.
  assert.ok(SAFE_LEAF.test('nudity.none'));
  assert.equal(worstViolation({ nudity: { none: 0.99, sexual_activity: 0.01 } }), null);
});

test('"prob" is NOT treated as safe — it is the gore/offensive score', () => {
  // A first version of SAFE_LEAF listed prob alongside none/safe/score. For
  // the gore and offensive models the response is { gore: { prob: 0.97 } }
  // and that number IS the violation, so gore passed straight through.
  // Caught by running realistic responses through this before wiring it up.
  assert.ok(!SAFE_LEAF.test('gore.prob'), 'prob must count as a violation score');
  const hit = worstViolation({ gore: { prob: 0.93 }, nudity: { none: 0.98 } });
  assert.equal(hit?.path, 'gore.prob');
});

test('each violation category is caught', () => {
  const cases = {
    'nudity.sexual_activity': { nudity: { sexual_activity: 0.97, none: 0.01 } },
    'gore.prob':              { nudity: { none: 0.98 }, gore: { prob: 0.93 } },
    'weapon.classes.firearm': { nudity: { none: 0.99 }, weapon: { classes: { firearm: 0.88 } } },
    'offensive.prob':         { nudity: { none: 0.99 }, offensive: { prob: 0.81 } },
  };
  for (const [expected, models] of Object.entries(cases)) {
    assert.equal(worstViolation(models)?.path, expected, `${expected} was not caught`);
  }
});

test('scores are read by walking the whole response, not fixed paths', () => {
  // Sightengine nests differently per model AND per model version, so a
  // hardcoded path that silently misses would let an unchecked image pass as
  // clean. A moderation check that fails open is worse than none, because it
  // is trusted.
  const deep = { some: { future: { model: { badness: 0.99 } } } };
  assert.equal(worstViolation(deep)?.path, 'some.future.model.badness');
});

// ── File validation ─────────────────────────────────────────────────────

const withTail = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(20)]);

test('real image formats are identified by their magic bytes', () => {
  assert.equal(sniff(withTail([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
  assert.equal(sniff(withTail([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), 'image/png');
  assert.equal(
    sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)])),
    'image/webp');
});

test('non-images are rejected regardless of what they claim to be', () => {
  // The content type a client sends is a claim; the first bytes are a fact.
  for (const [name, buf] of [
    ['html', Buffer.from('<html><script>alert(1)</script></html>')],
    ['svg',  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ['exe',  withTail([0x4D, 0x5A, 0x90, 0x00])],
    ['tiny', Buffer.alloc(3)],
  ]) {
    assert.equal(sniff(buf), null, `${name} must not be accepted as an image`);
  }
});

test('SVG specifically cannot get through', () => {
  // Worth its own test: SVG is an image format browsers render, and it can
  // carry script. It is deliberately absent from the allow-list.
  assert.ok(!Object.keys(ALLOWED).includes('image/svg+xml'));
});

// ── Route ordering and enforcement ──────────────────────────────────────

const AVATAR = strip(read('src', 'routes', 'avatar.js'));

test('the image is moderated BEFORE it is stored', () => {
  // An image that reaches storage has a public URL, and a public URL has
  // already been served to somebody by the time an after-the-fact job runs.
  assert.ok(AVATAR.indexOf('moderation.checkImage') < AVATAR.indexOf('.upload('),
    'checkImage must run before the storage upload');
});

test('an unconfigured moderation service blocks uploads rather than allowing them', () => {
  const svc = strip(read('src', 'services', 'imageModeration.js'));
  assert.match(svc, /notConfigured = true/,
    'missing credentials must throw, not silently pass every image');
  assert.match(AVATAR, /e\.notConfigured[\s\S]{0,200}?503/,
    'the route must refuse the upload when moderation is unavailable');
});

test('a revoked uploader is stopped server-side', () => {
  // Hiding the button is a courtesy; this is the rule.
  assert.ok(AVATAR.indexOf('avatar_banned') < AVATAR.indexOf('moderation.checkImage'),
    'the ban is checked before any work is done');
  assert.match(AVATAR, /avatar_banned[\s\S]{0,300}?403/);
});

test('the size cap is enforced before the image is sent anywhere', () => {
  assert.equal(MAX_BYTES, 3 * 1024 * 1024);
  assert.ok(AVATAR.indexOf('MAX_BYTES') < AVATAR.indexOf('moderation.checkImage'));
});

// ── Body size limit ─────────────────────────────────────────────────────

test('the avatar parser is mounted BEFORE the global express.json()', () => {
  // Express runs middleware in registration order, so a later mount never
  // sees the request: the global express.json() matched /api/avatar first,
  // applied its default 100kb cap and returned "request entity too large"
  // before the 5mb parser existed in the chain. Every upload failed,
  // including small photos. Same ordering rule the webhook raw-body parser
  // above it already depends on.
  const idx = strip(read('src', 'index.js'));
  const avatarAt = idx.indexOf("app.use('/api/avatar'");
  const globalAt = idx.indexOf('app.use(express.json());');
  assert.notEqual(avatarAt, -1, 'the avatar route is not mounted');
  assert.notEqual(globalAt, -1, 'the global json parser is gone');
  assert.ok(avatarAt < globalAt,
    'the avatar parser must be registered before the global one, or its limit never applies');
  assert.match(idx.slice(avatarAt, avatarAt + 120), /limit: '5mb'/);
});

// ── Reports ─────────────────────────────────────────────────────────────

const REPORTS = strip(read('src', 'routes', 'reports.js'));
const ADMIN   = strip(read('src', 'routes', 'admin.js'));

test('a player cannot report themselves', () => {
  assert.match(REPORTS, /reportedId === reporterId/);
});

test('only known reasons are accepted', () => {
  const { REASONS } = require('../src/routes/reports');
  assert.deepEqual([...REASONS].sort(), ['cheating', 'other', 'pfp']);
});

test('a duplicate report reads as success', () => {
  // From the reporter's side the outcome is identical — this person is
  // already reported for this — and saying "duplicate" invites working out
  // what else can be filed to inflate the count.
  assert.match(REPORTS, /23505[\s\S]{0,120}?duplicate: true/);
});

test('a report decision is claimed, so two admins cannot both resolve it', () => {
  const at = ADMIN.indexOf("router.post('/reports/:id/decide'");
  assert.notEqual(at, -1, 'the decision route is gone');
  assert.match(ADMIN.slice(at, at + 900), /\.eq\('status', 'open'\)/,
    'the update must be scoped to an open report');
});

test('removing a picture revokes uploads by default', () => {
  // Clearing alone is an invitation to re-upload the same image.
  const at = ADMIN.indexOf("router.post('/users/:id/remove-avatar'");
  assert.notEqual(at, -1);
  const route = ADMIN.slice(at, at + 1200);
  assert.match(route, /banFuture !== false/, 'the default must be to revoke');
  assert.match(route, /avatar_url: null, avatar_banned: ban/);
});

test('removing a picture deletes the stored object, not just the link', () => {
  const at = ADMIN.indexOf("router.post('/users/:id/remove-avatar'");
  assert.match(ADMIN.slice(at, at + 1400), /storage\.from\('avatars'\)\.remove/,
    'a public URL that still resolves is still reachable');
});

test('the admin routes survive the migration not being run', () => {
  // player_reports and the avatar columns arrive with PENDING_SQL 18. One
  // unknown column makes PostgREST reject a whole query — the exact failure
  // that made the player panel unreachable via a phantom email_confirmed_at.
  assert.match(ADMIN, /player_reports\/\.test\(error\.message/,
    'a missing reports table must degrade, not 500');
  assert.match(ADMIN, /avatar_url\|avatar_banned\/\.test\(error\.message/,
    'missing avatar columns must degrade, not 500');
});

test('email_confirmed_at is not selected from profiles', () => {
  // It lives on auth.users. Selecting it here made PostgREST reject the query
  // for every player, and because the fallback reused the same column list,
  // BOTH attempts failed and the panel 404'd on every click.
  const base = ADMIN.slice(ADMIN.indexOf('const PROFILE_BASE'), ADMIN.indexOf('const PROFILE_BASE') + 300);
  assert.ok(!/email_confirmed_at/.test(base),
    'email_confirmed_at is not a profiles column');
});
