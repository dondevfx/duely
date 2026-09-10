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
  // arrangement exists to prevent. The amount is still the server's constant;
  // it is now passed to the function that also stamps the cooldown.
  const claim = BONUS.slice(BONUS.indexOf("router.post('/diamond-claim'"));
  assert.match(claim.slice(0, 1800),
    /rpc\('claim_diamond_bonus', \{\s*p_user_id: req\.user\.id,\s*p_amount:\s*DIAMOND_BONUS,/,
    'the credited amount is no longer the advertised constant');
});

test('the cooldown and the credit are the same statement', () => {
  // Stronger than the atomic stamp this replaced, and for a reason that took
  // an audit to see.
  //
  // The old shape stamped the cooldown (correctly, atomically), credited
  // separately, and cleared the stamp if the credit reported an error. But an
  // error is not proof that nothing happened — a response lost between the app
  // and Postgres reports a failure for a statement that committed — so on that
  // path the diamonds were paid AND the cooldown was cleared, and the next
  // request paid them again.
  //
  // claim_diamond_bonus does both halves in one UPDATE guarded by the
  // cooldown. There is nothing to roll back and no window to roll it back in.
  const claim = BONUS.slice(BONUS.indexOf("router.post('/diamond-claim'"));
  const body = claim.slice(0, 1800);

  assert.match(body, /rpc\('claim_diamond_bonus'/,
    'the claim is back to stamping and crediting separately');
  assert.ok(!/last_diamond_bonus: null/.test(body),
    'the claim clears its own cooldown again, which double-pays a credit that only looked failed');
  assert.match(body, /already_claimed/,
    'a second claim inside the cooldown is no longer reported as such');

  // And the function it calls really is one guarded statement.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'SCHEMA.sql'), 'utf8');
  const fn = schema.slice(schema.indexOf('FUNCTION claim_diamond_bonus'));
  const sql = fn.slice(0, fn.indexOf('$$;'));
  assert.match(sql, /UPDATE profiles[\s\S]*diamonds\s*=\s*diamonds \+ p_amount[\s\S]*last_diamond_bonus = now\(\)/,
    'the credit and the stamp are not the same UPDATE');
  assert.match(sql, /WHERE id = p_user_id[\s\S]*last_diamond_bonus IS NULL[\s\S]*INTERVAL '30 minutes'/,
    'the cooldown is not in the WHERE, so concurrent claims do not serialise');
});

test("the claim button shows the icon and a derived amount", () => {
  // The amount is read from the server, not written into the label, so the
  // button cannot advertise a figure the claim will not credit. That is the
  // point of sending bonusAmount at all, and it is easy to undo by typing the
  // number in while changing the wording.
  //
  // Plain substring checks: this is JSX containing `${...}` and quotes, and
  // every attempt to write it as a regex through a shell lost a backslash and
  // silently matched nothing.
  assert.ok(UI.includes("Claim <DiamondIcon />"),
    'the button must carry the diamond icon');
  assert.ok(UI.includes("amount.toLocaleString()"),
    'the amount must still be derived, never typed in');
});
