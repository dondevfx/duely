// Identity verification, and the gate it feeds.
//
// The gate is the part that matters: an unverified player must not be able to
// take money out by ANY route. That is why it lives in the shared guards rather
// than in each withdrawal handler — a check that only one route runs is a check
// with a way around it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const WALLET = strip(read('src', 'routes', 'wallet.js'));
const ADMIN  = strip(read('src', 'routes', 'admin.js'));
const { validateSubmission, ageOn } = require('../src/routes/kyc');

// ── The gate ───────────────────────────────────────────────────────────────

function guards() {
  const at = WALLET.indexOf('async function withdrawalGuards');
  assert.notEqual(at, -1, 'withdrawalGuards is gone');
  return WALLET.slice(at, WALLET.indexOf("router.post('/withdraw'", at));
}

test('every withdrawal route is gated on identity', () => {
  // Not "the fiat route checks KYC" — BOTH routes run withdrawalGuards, so
  // putting it there covers crypto and fiat together and cannot drift apart.
  assert.match(guards(), /await kycApproved\(req\.user\.id\)/,
    'the shared guards must check identity, or the crypto route has no gate at all');

  const crypto = WALLET.slice(
    WALLET.indexOf("router.post('/withdraw'"),
    WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(crypto, /await withdrawalGuards\(req\)/);
  const fiat = WALLET.slice(WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(fiat, /await withdrawalGuards\(req\)/);
});

test('the gate tells the client what to do about it', () => {
  // A refusal that only says "no" leaves the player to find the page on their
  // own. The flag is what lets the wallet send them straight there.
  assert.match(guards(), /kycRequired: true/,
    'the refusal must carry kycRequired, or the wallet cannot redirect');
});

test('identity is checked before any balance moves', () => {
  const g = guards();
  assert.ok(g.indexOf('kycApproved') !== -1);
  // The guards run before the route body, so nothing in the route can deduct
  // first. Assert the ordering that actually exists rather than a proxy for it.
  const route = WALLET.slice(WALLET.indexOf("router.post('/withdraw'"));
  assert.ok(route.indexOf('await withdrawalGuards(req)') < route.indexOf('deductCoins('),
    'the guards must run before the deduction');
});

test('the identity check fails closed', () => {
  const fn = WALLET.slice(
    WALLET.indexOf('async function kycApproved'),
    WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(fn, /catch\s*\{\s*return false;/,
    'a missing column or an unreadable profile must read as "not verified"');
  assert.match(fn, /=== 'approved'/, 'only an explicit approval counts');
});

// ── Submission rules ───────────────────────────────────────────────────────

const GOOD = {
  legalName: 'Ada Lovelace', dateOfBirth: '1990-05-04',
  addressLine1: '12 Bell St', city: 'Austin', region: 'TX',
  postalCode: '73301', country: 'us',
};

test('a complete submission is accepted and normalised', () => {
  const { fields, error } = validateSubmission(GOOD);
  assert.equal(error, undefined);
  assert.equal(fields.country, 'US', 'the country code is stored uppercase');
  assert.equal(fields.legal_name, 'Ada Lovelace');
  assert.equal(fields.address_line2, null, 'an omitted line 2 is null, not ""');
});

test('under-18 is refused', () => {
  const now = new Date();
  const justUnder = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate() + 1));
  const { error } = validateSubmission({ ...GOOD, dateOfBirth: justUnder.toISOString().slice(0, 10) });
  assert.match(error || '', /at least 18/, 'a day short of 18 must still be refused');
});

test('exactly 18 today is accepted', () => {
  const now = new Date();
  const exactly = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  const { error } = validateSubmission({ ...GOOD, dateOfBirth: exactly.toISOString().slice(0, 10) });
  assert.equal(error, undefined, 'the birthday itself counts');
});

test('a future date of birth is refused', () => {
  // Reads as a large negative age, which the minimum-age check catches, but it
  // is worth pinning: a client can send anything.
  const next = new Date(Date.now() + 86400000 * 365).toISOString().slice(0, 10);
  const { error } = validateSubmission({ ...GOOD, dateOfBirth: next });
  assert.ok(error, 'a date in the future cannot be a date of birth');
});

test('every address field is required', () => {
  for (const key of ['addressLine1', 'city', 'region', 'postalCode']) {
    const { error } = validateSubmission({ ...GOOD, [key]: '   ' });
    assert.ok(error, `${key} must be required — whitespace is not an address`);
  }
});

test('a name must contain an actual letter', () => {
  assert.ok(validateSubmission({ ...GOOD, legalName: '123456' }).error);
  assert.ok(validateSubmission({ ...GOOD, legalName: '' }).error);
  // Real names are messy and must survive.
  for (const name of ["Seán O'Brien", 'Anne-Marie D’Ath', '李 明']) {
    assert.equal(validateSubmission({ ...GOOD, legalName: name }).error, undefined,
      `${name} is a real name and must be accepted`);
  }
});

test('an unknown country code is refused', () => {
  assert.ok(validateSubmission({ ...GOOD, country: 'USA' }).error, 'ISO-2 only');
  assert.ok(validateSubmission({ ...GOOD, country: '' }).error);
});

test('ageOn handles the day before and after a birthday', () => {
  assert.equal(ageOn('2000-06-15', new Date('2018-06-14T12:00:00Z')), 17);
  assert.equal(ageOn('2000-06-15', new Date('2018-06-15T12:00:00Z')), 18);
});

// ── Review ─────────────────────────────────────────────────────────────────

function decideRoute() {
  const at = ADMIN.indexOf("router.post('/kyc/:id/decide'");
  assert.notEqual(at, -1, 'the KYC decision route is gone');
  return ADMIN.slice(at, at + 3000);
}

test('a decision is claimed before it is acted on', () => {
  // Two admins clicking Approve at the same moment must not both succeed.
  // Scoping the update to status='pending' means the second one matches no row.
  const r = decideRoute();
  assert.match(r, /\.eq\('status', 'pending'\)/,
    'the update must be scoped to a pending row, or a decision can be made twice');
});

test('a rejection must carry a reason', () => {
  assert.match(decideRoute(), /A rejection needs a reason/,
    'the player is shown this — "rejected" alone tells them nothing to act on');
});

test('the submission is decided before the gate opens', () => {
  const r = decideRoute();
  assert.ok(r.indexOf("from('kyc_submissions')") < r.indexOf("from('profiles')"),
    'opening the gate first would let someone withdraw against a record that was never written');
});

test('the review queue is admin-only', () => {
  for (const route of ["router.get('/kyc'", "router.post('/kyc/:id/decide'"]) {
    const at = ADMIN.indexOf(route);
    assert.notEqual(at, -1, `${route} is gone`);
    assert.match(ADMIN.slice(at, at + 120), /requireAuth, requireAdmin/,
      `${route} must require an admin`);
  }
});

// ── The page that replaced the fake one ────────────────────────────────────

test('Settings no longer pretends to save verification', () => {
  // It wrote name, address and date of birth to localStorage and showed a
  // "Saved" tick. Nothing reached the server and no withdrawal was unblocked.
  const profile = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Profile.jsx'), 'utf8');
  assert.ok(!/verify_name|verify_addr|verify_dob/.test(profile),
    'the localStorage verification form must be gone, not merely hidden');
  assert.match(profile, /kyc\/status/, 'Settings must read the real status from the server');
});

test('a failed request keeps the body, so flags survive', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'api.js'), 'utf8');
  assert.match(api, /err\.data = data/,
    'kycRequired and mfaRequired live in the body — dropping it leaves the caller unable to act');
});
