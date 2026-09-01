// The signup reward: granted once, guarded by the database, and gone if the
// credit fails.
//
// A one-off grant is the easiest kind of bonus to get wrong, because the
// "you already had this" check has no cooldown to fall back on — there is a
// single column standing between one 5,000 diamond grant and any number of
// them. These tests hold the shape that makes that column sufficient.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const BONUS  = read('src', 'routes', 'bonus.js');
const MODAL  = read('..', 'frontend', 'src', 'components', 'SignupRewardModal.jsx');
const APP    = read('..', 'frontend', 'src', 'App.jsx');
const ICONS  = read('..', 'frontend', 'src', 'components', 'UiIcon.jsx');
const SQL    = read('..', 'PENDING_SQL.sql');

// The claim handler, from its route line to the end of the function.
const CLAIM = BONUS.slice(BONUS.indexOf("router.post('/signup-claim'"),
                          BONUS.indexOf("// ── Daily spin wheel"));

test('the grant is 5000 diamonds, named once', () => {
  const m = BONUS.match(/const SIGNUP_BONUS[ ]*=[ ]*(\d+);/);
  assert.ok(m, 'SIGNUP_BONUS is gone');
  assert.equal(Number(m[1]), 5000);
  // Advertised and credited from the same constant. A page told one number
  // and a handler crediting another is the classic version of this bug.
  const status = BONUS.slice(BONUS.indexOf("router.get('/signup-status'"),
                             BONUS.indexOf("router.post('/signup-claim'"));
  assert.match(status, /bonusAmount:\s*SIGNUP_BONUS/);
  assert.match(CLAIM, /amount:\s*SIGNUP_BONUS/);
});

test('the claim is guarded by a conditional UPDATE, not a preceding SELECT', () => {
  // This is the whole safety property. A SELECT that checks the column and a
  // later UPDATE that stamps it can both pass for two simultaneous requests,
  // and the grant is taken twice. Folding the check into the UPDATE's WHERE
  // makes the row lock decide it: exactly one request comes back with a row.
  assert.match(CLAIM, /\.is\('signup_bonus_claimed_at',\s*null\)/,
    'the null check must be part of the update, not a separate read');
  const stampAt  = CLAIM.indexOf('signup_bonus_claimed_at: new Date()');
  const creditAt = CLAIM.indexOf('credit_diamonds');
  assert.ok(stampAt > -1 && creditAt > stampAt,
    'the stamp must be claimed before the diamonds are credited');
  // And the loser of that race is turned away rather than credited anyway.
  assert.match(CLAIM, /claimed\.length === 0[\s\S]{0,120}Already claimed/);
});

test('a failed credit releases the claim', () => {
  // They got nothing, so they must be able to try again. Fails closed, the
  // same way the diamond and spin claims do.
  const onErr = CLAIM.slice(CLAIM.indexOf('if (credErr)'));
  assert.match(onErr, /signup_bonus_claimed_at:\s*null/,
    'a credit failure that keeps the stamp silently eats the grant');
});

test('the claim is recorded as a transaction', () => {
  assert.match(CLAIM, /type:\s*'diamond_bonus'[\s\S]{0,120}crypto_amount:\s*SIGNUP_BONUS/);
});

test('the migration backfills existing accounts', () => {
  // Without the backfill, shipping this hands 5,000 diamonds to every account
  // that already exists — the column is null for all of them.
  const section = SQL.slice(SQL.indexOf('19. Signup reward'));
  assert.match(section, /ADD COLUMN IF NOT EXISTS signup_bonus_claimed_at/);
  assert.match(section, /UPDATE profiles[\s\S]{0,200}SET signup_bonus_claimed_at = now\(\)[\s\S]{0,120}WHERE signup_bonus_claimed_at IS NULL/);
});

test('nothing on a hot path selects the pending column', () => {
  // PostgREST rejects an entire query for one unknown column, so a select on
  // a column whose migration has not been run takes down whatever it is part
  // of. Confined to the two signup-bonus handlers, a pending migration costs
  // the popup and nothing else.
  const files = ['src/routes/wallet.js', 'src/routes/rewards.js', 'src/socket/handlers.js',
                 'src/routes/auth.js', 'src/routes/admin.js'];
  for (const f of files) {
    assert.ok(!read(...f.split('/')).includes('signup_bonus_claimed_at'),
      `${f} selects a column that may not exist yet`);
  }
});

test('the modal asks the server, and keeps nothing locally', () => {
  assert.match(MODAL, /\/bonus\/signup-status/);
  assert.match(MODAL, /\/bonus\/signup-claim/);
  // localStorage would be wrong in both directions: cleared or on a second
  // device it re-offers a spent gift, and set by a failed claim it hides one
  // that was never given.
  // Code only — the doc comment above the component explains exactly why it
  // does not use localStorage, and that sentence is not a use of it.
  const code = MODAL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/localStorage/.test(code),
    'whether the gift is available is the database\'s answer, not the browser\'s');
});

test('the modal shows nothing until the server says there is a gift', () => {
  // An existing account must never see a flash of a present it cannot have.
  assert.match(MODAL, /useState\(null\)/);
  assert.match(MODAL, /amount === null[\s\S]{0,40}return null/);
  assert.match(MODAL, /d\?\.canClaim/, 'the server decides, not the presence of a response');
});

test('the gift waits behind the age and ToS check', () => {
  // Both are z-50 full-screen modals. Without the gate the gift paints over
  // the age confirmation, and the gift is the one that can wait.
  //
  // On ACCEPTED, not on "not pending". Acceptance is fetched from the account
  // now, and while that request is in flight it is neither accepted nor
  // pending — the window a new account would have used to slip the gift in
  // ahead of the age check.
  assert.match(APP, /\{tosAccepted && <SignupRewardModal \/>\}/);
  assert.ok(!/!tosPending && <SignupRewardModal/.test(APP));
});

test('the claim closes the popup rather than opening a second one', () => {
  // The confirmation panel was a step for its own sake — the balance in the
  // navbar updates behind it the moment it closes.
  assert.match(MODAL, /setClosed\(true\)/);
  assert.ok(!/setClaimed|Let's Play/.test(MODAL),
    'claiming should return the player to the site, not to another button');
});

test('the present is a drawn icon, not an emoji', () => {
  assert.match(ICONS, /export function GiftIcon/);
  assert.match(MODAL, /<GiftIcon/);
  assert.ok(!/🎁/.test(MODAL), 'the emoji renders as a different object on every platform');
  const gift = ICONS.slice(ICONS.indexOf('export function GiftIcon'),
                           ICONS.indexOf('export function BjIcon'));
  // Color is the point of the request — a flat monochrome present would not
  // read as a reward next to the coin and the diamond.
  assert.match(gift, /#F5C518|#FFD84D/, 'the ribbon carries the same gold as the coin and the lock');
  assert.match(gift, /linearGradient/, 'the box is lit, so it reads as a box');
});
