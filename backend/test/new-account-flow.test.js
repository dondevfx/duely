// What a brand-new account sees, and what it must not.
//
// Five separate reports, one theme: a new account was being treated as an old
// one. Its rating moved before it had a rank, its badge said Bronze while
// every other screen said Unranked, and the age/terms agreement it never made
// was assumed from a key the previous account on that phone had left behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
// Comments describe the rules; only the code enforces them.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ELO     = read('src', 'services', 'eloService.js');
const PROFILE = strip(read('..', 'frontend', 'src', 'pages', 'Profile.jsx'));
const RANKS   = read('..', 'frontend', 'src', 'utils', 'ranks.js');
const TOS     = strip(read('..', 'frontend', 'src', 'components', 'AgeToSModal.jsx'));
const AUTH    = read('src', 'routes', 'auth.js');
const APP     = strip(read('..', 'frontend', 'src', 'App.jsx'));
const WALLET  = read('src', 'routes', 'wallet.js');
const WALLETUI = strip(read('..', 'frontend', 'src', 'pages', 'Wallet.jsx'));
const NOTIFY  = strip(read('..', 'frontend', 'src', 'components', 'NotifyToast.jsx'));

const ENGINES = ['blackjackEngine', 'blockBlastEngine', 'carDashEngine', 'coinFlipEngine',
                 'colorRushEngine', 'towerEngine', 'wordleEngine'];

// ── 1. No rating movement before a rank ───────────────────────────────────

test('the placement guard cannot be opted out of', () => {
  // It used to take force=true, and four of the seven engines passed it — so
  // a new account watched its rating swing while every screen said Unranked.
  // Removing the parameter rather than defaulting it is what stops a call
  // site quietly opting out again.
  assert.ok(!/function applyEloUpdate\([^)]*force/.test(ELO),
    'applyEloUpdate must not accept a force flag');
  assert.ok(!/function applyEloAndMeasure\([^)]*force/.test(ELO));
  assert.match(ELO, /if \(total < 3\) return \{ applied: false, placement: true \}/);
});

test('no engine writes the elo column directly', () => {
  // A raw update bypasses the guard entirely — which is exactly how Word VS,
  // solo Word VS, and the Block Burst and Tower bot matches kept moving a
  // new account's rating after the flag was removed from everything else.
  for (const e of ENGINES) {
    const src = strip(read('src', 'services', `${e}.js`));
    assert.ok(!/update\(\{\s*elo:/.test(src),
      `${e} writes elo directly, skipping the placement guard`);
  }
  const handlers = strip(read('src', 'socket', 'handlers.js'));
  assert.ok(!/update\(\{\s*elo:/.test(handlers),
    'solo Word VS settles through handlers.js and must go through applyEloUpdate too');
});

test('no engine passes a fourth argument to applyEloUpdate', () => {
  for (const e of ENGINES) {
    const src = read('src', 'services', `${e}.js`);
    assert.ok(!/applyEloUpdate\([^)]*,\s*true\)/.test(src),
      `${e} still forces past placement`);
  }
});

test('a skipped write reports the stored rating, not the computed one', () => {
  // Otherwise the result card announces a swing the database never took —
  // the same class of bug as the +44-on-a-+22-win this codebase already fixed.
  for (const [file, dir] of [['blockBlastEngine', 'services'], ['towerEngine', 'services']]) {
    const src = read('src', dir, `${file}.js`);
    assert.match(src, /if \(!r\?\.applied\) humanNewElo = (humanEloBefore|eloBefore)/,
      `${file} reports a rating it did not write`);
  }
  assert.match(read('src', 'socket', 'handlers.js'), /if \(!r\?\.applied\) newElo = currentElo/);
});

// ── 2. Unranked reads as Unranked ─────────────────────────────────────────

test('the profile page shows the display rank, not the raw elo band', () => {
  // getRank(1000) is Bronze. A new account has never played, so its badge said
  // Bronze on the profile page while the navbar and result card said Unranked.
  assert.ok(!/getRank\(profile\.elo\)/.test(PROFILE),
    'getRank on a raw elo cannot know the player is unplaced');
  assert.match(PROFILE, /getDisplayRank\(profile\)/);
  assert.match(RANKS, /if \(!isRanked\(profile\)\) return UNRANKED/);
});

test('no rating is shown until there is a rank to attach it to', () => {
  assert.match(PROFILE, /isRanked\(profile\) \? `\$\{profile\.elo\} ELO`/,
    'the rank card must not print 1000 ELO under an Unranked badge');
  // The bare form — `>{p?.elo} ELO` printed straight into the row. The
  // guarded form lives inside a template literal, `${p?.elo} ELO`, so the
  // preceding character is what tells them apart.
  assert.ok(!/>\{p\?\.elo\} ELO/.test(PROFILE),
    'friend rows must read Unranked too, not the rating everyone starts on');
  assert.equal((PROFILE.match(/isRanked\(p\)/g) || []).length, 2,
    'both the pending-request rows and the friends list');
});

test('the friends list is sent what it needs to tell ranked from unranked', () => {
  const friends = AUTH.slice(AUTH.indexOf("router.get('/friends'"), AUTH.indexOf("const ADMIN_ID"));
  assert.match(friends, /wins, losses/, 'without these every friend reads as Unranked');
  assert.match(friends, /avatar_url/, 'and without this every friend row shows an initial');
});

// ── 3. The agreement belongs to the account ───────────────────────────────

test('acceptance is read from the account, not from the browser', () => {
  assert.match(TOS, /api\.get\('\/auth\/tos-status'\)/);
  assert.match(TOS, /api\.post\('\/auth\/tos-accept'\)/);
  assert.match(AUTH, /router\.get\('\/tos-status'/);
  assert.match(AUTH, /router\.post\('\/tos-accept'/);
});

test('the first acceptance is the one kept', () => {
  const accept = AUTH.slice(AUTH.indexOf("router.post('/tos-accept'"));
  assert.match(accept.slice(0, 600), /\.is\('tos_accepted_at', null\)/,
    'when it matters what someone agreed to, it matters when they agreed to it');
});

test('nothing is shown while the answer is unknown', () => {
  // Defaulting to pending flashes a full-screen legal modal at every returning
  // player on every page load; defaulting to accepted lets a new account
  // through without ever being asked.
  assert.match(APP, /tosServer !== null/);
  assert.match(TOS, /useState\(null\)/);
});

test('the migration does not backfill acceptance', () => {
  // Stamping existing accounts would record an agreement they never made, on
  // the one column where the record IS the point. Section 19 backfills for
  // exactly the opposite reason.
  const sql = read('..', 'PENDING_SQL.sql');
  const section = sql.slice(sql.indexOf('20. Age + Terms acceptance'));
  assert.match(section, /ADD COLUMN IF NOT EXISTS tos_accepted_at/);
  assert.ok(!/UPDATE profiles[\s\S]{0,200}SET tos_accepted_at = now\(\)/.test(section),
    'nobody has agreed as an account yet, and pretending otherwise is the bug');
});

// ── 4. Withdrawal tells you what to do, not just no ───────────────────────

test('an unverified email is flagged, not just refused in prose', () => {
  const guards = WALLET.slice(WALLET.indexOf('async function withdrawalGuards'));
  assert.match(guards.slice(0, 900), /emailVerificationRequired: true/,
    'the page cannot open the fix from a sentence');
});

test('the wallet opens the verification prompt on that flag', () => {
  assert.match(WALLETUI, /err\.data\?\.emailVerificationRequired/);
  assert.match(WALLETUI, /<VerifyEmailModal/);
  const modal = read('..', 'frontend', 'src', 'components', 'VerifyEmailModal.jsx');
  assert.match(modal, /auth\.resend\(\{ type: 'signup'/,
    'being told to verify an email is useless without a way to send the link');
});

// ── 6. A name that arrives with a face ────────────────────────────────────

test('a tip toast shows the sender', () => {
  assert.match(NOTIFY, /<Avatar/);
  assert.match(NOTIFY, /fromAvatar/);
  const tip = WALLET.slice(WALLET.indexOf("emit('tip_received'") - 1200,
                           WALLET.indexOf("emit('tip_received'") + 200);
  assert.match(tip, /avatar_url/, 'req.user is the auth user and carries no picture');
  assert.match(tip, /fromAvatar/);
});
