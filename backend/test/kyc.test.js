// Identity verification via Didit, and the gate it feeds.
//
// Only BANK withdrawals are gated. Crypto withdrawals deliberately are not: a
// verification costs real money past the free monthly allowance, so a player
// verifies at the moment they need to and never again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const WALLET   = strip(read('src', 'routes', 'wallet.js'));
const WEBHOOKS = strip(read('src', 'routes', 'webhooks.js'));
const didit = require('../src/services/diditService');

// ── Where the gate is, and is not ──────────────────────────────────────────

function guards() {
  const at = WALLET.indexOf('async function withdrawalGuards');
  assert.notEqual(at, -1, 'withdrawalGuards is gone');
  return WALLET.slice(at, WALLET.indexOf("router.post('/withdraw'", at));
}

test('crypto withdrawals are not gated on identity', () => {
  // Deliberate. Putting it back in the shared guards would charge for a
  // verification every player needs, including those who only take crypto out.
  assert.ok(!/kycApproved/.test(guards()),
    'the shared guards must not check identity — that would gate crypto too');

  const crypto = WALLET.slice(
    WALLET.indexOf("router.post('/withdraw'"),
    WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.ok(!/kycApproved/.test(crypto),
    'the crypto route must not check identity');
});

test('bank withdrawals are gated on identity', () => {
  const fiat = WALLET.slice(WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.match(fiat, /await kycApproved\(req\.user\.id\)/,
    'the fiat route is the one and only identity gate');
  assert.match(fiat, /kycRequired: true/,
    'the refusal must carry kycRequired, or the wallet cannot open the flow');
});

test('identity is checked before the balance moves', () => {
  const fiat = WALLET.slice(WALLET.indexOf("router.post('/withdraw-fiat'"));
  assert.ok(fiat.indexOf('kycApproved(') < fiat.indexOf('deductCoins('),
    'a payout to someone unidentified is the one that cannot be undone');
});

test('the identity check fails closed', () => {
  const fn = WALLET.slice(
    WALLET.indexOf('async function kycApproved'),
    WALLET.indexOf('async function withdrawalGuards'));
  assert.match(fn, /catch\s*\{\s*return false;/, 'an error must not read as approved');
  assert.match(fn, /=== 'approved'/, 'only an explicit approval counts');
});

// ── Didit's status vocabulary ──────────────────────────────────────────────

test('In Review is neither approved nor rejected', () => {
  // The trap. A human at Didit is still looking: approving would let an
  // unverified player withdraw, rejecting would fail somebody who is fine.
  // Same shape as PayPal's UNCLAIMED in the payout watcher.
  assert.equal(didit.mapStatus('In Review'), 'pending');
});

test('Kyc Expired can close the gate again', () => {
  // A previously APPROVED verification that lapsed. If this mapped to anything
  // that leaves 'approved' in place, an expired player keeps withdrawing.
  assert.equal(didit.mapStatus('Kyc Expired'), 'unverified');
});

test('an unfinished verification is not a rejection', () => {
  // The player closed the tab. Telling them they were declined is both wrong
  // and discouraging — they simply start again.
  assert.equal(didit.mapStatus('Expired'), 'unverified');
  assert.equal(didit.mapStatus('Abandoned'), 'unverified');
});

test('only Approved approves', () => {
  const approved = Object.entries(didit.STATUS_MAP)
    .filter(([, v]) => v === 'approved').map(([k]) => k);
  assert.deepEqual(approved, ['Approved'],
    'exactly one Didit status may open the gate');
});

test('every documented status is mapped', () => {
  for (const s of ['Not Started', 'In Progress', 'Approved', 'Declined', 'In Review',
                   'Awaiting User', 'Resubmitted', 'Expired', 'Abandoned', 'Kyc Expired']) {
    assert.ok(didit.STATUS_MAP[s], `${s} is unmapped`);
  }
});

test('an unknown status holds rather than guesses', () => {
  // Didit's strings are case-sensitive with spaces. A new or mistyped one must
  // never fall through to approved.
  assert.equal(didit.mapStatus('approved'), 'pending', 'case matters — this is not "Approved"');
  assert.equal(didit.mapStatus('Something New'), 'pending');
});

// ── Webhook safety ─────────────────────────────────────────────────────────

function webhook() {
  const at = WEBHOOKS.indexOf("router.post('/didit'");
  assert.notEqual(at, -1, 'the Didit webhook is gone');
  return WEBHOOKS.slice(at);
}

test('the webhook verifies its signature before doing anything', () => {
  const w = webhook();
  assert.ok(w.indexOf('verifyWebhook') < w.indexOf("from('profiles')"),
    'an unverified caller must not be able to approve anyone');
  assert.match(w, /express\.raw/,
    'the signature is over the body, so it must not be re-encoded before checking');
});

test('a sandbox event cannot approve a real player', () => {
  assert.match(webhook(), /p\.environment !== didit\.ENVIRONMENT/,
    'without this, the sandbox secret approves production accounts');
});

test('a stale event cannot undo a newer one', () => {
  // Retries mean an old "In Progress" can land after "Approved".
  assert.match(webhook(), /didit_updated_at.*>.*eventAt|Number\(existing\.didit_updated_at/s,
    'out-of-order delivery must be dropped, not applied');
});

test('a decision with no player is discarded, not applied', () => {
  assert.match(webhook(), /!userId \|\| !sessionId/,
    'vendor_data carries the user id — without it a decision belongs to nobody');
});

test('signature verification is constant-time and time-bounded', () => {
  const svc = read('src', 'services', 'diditService.js');
  assert.match(svc, /timingSafeEqual/, 'a plain compare leaks how much of a forgery was right');
  assert.match(svc, /MAX_SKEW_SEC/, 'a replayed webhook must expire');
});

// ── Session creation ───────────────────────────────────────────────────────

const KYC = strip(read('src', 'routes', 'kyc.js'));

test('an approved player cannot start another session', () => {
  assert.match(KYC, /already verified/i,
    'each verification costs money — once is once');
});

test('an unfinished session is reused rather than re-bought', () => {
  assert.match(KYC, /reused: true/,
    'a player returning to a half-finished check must not trigger a second one');
});

test('the session is recorded before the player is sent to it', () => {
  const route = KYC.slice(KYC.indexOf("router.post('/session'"));
  assert.ok(route.indexOf("from('kyc_submissions')") < route.indexOf('res.json({ url: session.url })'),
    'an unrecorded session means the webhook arrives matching no row');
});

test('a missed webhook can be recovered by asking Didit', () => {
  // The webhook is a delivery, and deliveries get missed. Without this a player
  // whose event was dropped is finished at Didit and 'pending' here forever,
  // with nothing able to move them. It happened on the first live run: every
  // event was correctly discarded for an environment mismatch, and the decision
  // had nowhere else to come from.
  assert.match(KYC, /router\.post\('\/refresh'/, 'the recovery path is gone');
});

test('refresh and the webhook cannot disagree', () => {
  // Two places deciding what "In Review" means is how they drift apart.
  const refresh = KYC.slice(KYC.indexOf("router.post('/refresh'"));
  assert.match(refresh, /didit\.mapStatus\(session\.status\)/,
    'refresh must use the same mapping as the webhook, not its own');
});

test('there is no manual identity form left', () => {
  // It collected a name, address and date of birth for an admin to eyeball,
  // which verified nothing — anyone could type a plausible name.
  assert.ok(!/validateSubmission|legalName/.test(KYC),
    'the manual form must be gone, not merely unused');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Kyc.jsx')),
    'the manual KYC page must be deleted');
});

test('verification is not offered in Settings', () => {
  // It is prompted at the point of a bank withdrawal instead, so nobody is
  // nudged into paying for a check they do not need.
  const profile = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Profile.jsx'), 'utf8');
  assert.ok(!/verify_name|kycStatus|KYC_BADGE/.test(profile),
    'Settings must not carry a verification panel');
});

test('a failed request keeps the body, so flags survive', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'api.js'), 'utf8');
  assert.match(api, /err\.data = data/,
    'kycRequired lives in the body — dropping it leaves the caller unable to act');
});
