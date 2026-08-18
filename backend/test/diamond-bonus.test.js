// The diamond bonus: how much, how often, and who says so.
//
// The amount and the period were written out by hand in three places on the
// page as well as being enforced on the server. Changing the offer meant
// remembering all of them, and any one missed advertises a bonus the server
// will refuse to give.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BONUS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'bonus.js'), 'utf8');
const UI = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'DailyBonus.jsx'), 'utf8');

const constant = (name) => {
  // A character class, not a backslash escape. Writing this file through a
  // shell repeatedly ate one backslash, turning \s into a literal 's' — which
  // matches nothing and reports the constant as missing.
  const m = BONUS.match(new RegExp('const ' + name + '[ ]*=[ ]*([^;]+);'));
  assert.ok(m, name + ' is gone');
  return eval(m[1]);   // eslint-disable-line no-eval -- a constant expression from our own source
};

test('the bonus is 500 diamonds every minute', () => {
  assert.equal(constant('DIAMOND_BONUS'), 500);
  assert.equal(constant('DIAMOND_COOLDOWN_MS'), 60 * 1000);
});

test('the page is told both numbers rather than restating them', () => {
  const status = BONUS.slice(BONUS.indexOf("router.get('/diamond-status'"),
                             BONUS.indexOf("router.post('/diamond-claim'"));
  assert.match(status, /bonusAmount: DIAMOND_BONUS/);
  assert.match(status, /cooldownMs:\s*DIAMOND_COOLDOWN_MS/,
    'without the period the page has to hardcode it, which is how it drifts');
});

test('the page hardcodes neither', () => {
  assert.ok(!/Claim 250|every 5 minutes|Claim \d+ Diamonds every \d/.test(UI),
    'the offer must be rendered from what the server sent');
  assert.match(UI, /status\?\.bonusAmount/, 'the amount comes from the server');
  assert.match(UI, /status\?\.cooldownMs/,  'so does the period');
});

test('the claim credits the same constant it advertises', () => {
  // Advertising one number and crediting another is the failure this whole
  // arrangement exists to prevent.
  const claim = BONUS.slice(BONUS.indexOf("router.post('/diamond-claim'"));
  assert.match(claim.slice(0, 1400), /credit_diamonds', \{ user_id: req\.user\.id, amount: DIAMOND_BONUS \}/);
});

test('the cooldown is still enforced atomically', () => {
  // A one-minute cooldown is claimed far more often than a five-minute one, so
  // the race this guard closes gets a great deal more traffic.
  const claim = BONUS.slice(BONUS.indexOf("router.post('/diamond-claim'"));
  assert.match(claim.slice(0, 900), /last_diamond_bonus\.is\.null,last_diamond_bonus\.lt\./,
    'the cooldown must be part of the UPDATE, or two requests can both claim');
  assert.match(claim.slice(0, 1200), /if \(!claimed \|\| claimed\.length === 0\)/,
    'only the request that actually stamped the row may credit');
});
