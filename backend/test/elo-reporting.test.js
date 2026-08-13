// A result card should show a rating only when a rating actually moved.
//
// Every engine except Rush Hour reported the player's UNCHANGED rating for
// unrated outcomes — free play, and draws in blackjack. The card had no way to
// tell that apart from a real result, so it rendered "1000 (+0)": a rated match
// that happened to be worth nothing.
//
// null is the signal for "this mode does not rate". The frontend hides the row
// on null, so any engine that keeps sending a number is silently claiming to
// have rated a match it did not.
//
// Word VS was worse than a display problem: it computed AND WROTE new ratings
// regardless of the stake, so a free match really did move your rating while the
// same free match in any other game did not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs
  .readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const ENGINES = {
  'blackjackEngine.js':  '(isDraw || isFree)',
  'coinFlipEngine.js':   'isFree',
  'blockBlastEngine.js': 'isFree',
  'carDashEngine.js':    'ranked',
};

for (const [file, cond] of Object.entries(ENGINES)) {
  test(`${file} reports null rather than the unchanged rating`, () => {
    const src = read(file);
    assert.match(src, /newWinnerElo: null, newLoserElo: null/,
      `${file} must report null for an unrated outcome`);
    // The give-away for the old shape: handing back the player's own rating.
    assert.doesNotMatch(src, /newWinnerElo: winner\.elo/,
      `${file} still reports the unchanged rating, which renders as "(+0)"`);
    assert.ok(src.includes(cond), `${file} should still branch on ${cond}`);
  });
}

test('Word VS only computes a rating when the match is staked', () => {
  const src = read('wordleEngine.js');
  assert.match(src, /if \(winner && loser && !isFree\)/,
    'an unstaked Word VS match must not produce a new rating');
});

test('Word VS writes a rating only when it has one', () => {
  // This is the half that matters: without it, nulling the reported value would
  // hide a change that still happened.
  const src = read('wordleEngine.js');
  for (const [who, col] of [['newWinnerElo', 'winner'], ['newLoserElo', 'loser']]) {
    const at = src.indexOf(`update({ elo: ${who} })`);
    assert.ok(at > 0, `${who} update not found`);
    const before = src.slice(Math.max(0, at - 220), at);
    assert.match(before, new RegExp(`if \\(${who} != null\\)`),
      `the ${col} rating write must be gated on the rating existing`);
  }
});

test('Word VS starts from null, not from the current rating', () => {
  const src = read('wordleEngine.js');
  assert.match(src, /let newWinnerElo\s*=\s*null/);
  assert.match(src, /let newLoserElo\s*=\s*null/);
});

test('a free run in Block Burst solo still writes no rating at all', () => {
  // Covered in detail by solo-free.test.js; asserted here so the two rules are
  // not accidentally decoupled.
  const src = read('blockBlastEngine.js');
  assert.match(src, /if \(supabase && !freeSolo\) \{/);
});

test('the rated path is untouched — a staked match still rates', () => {
  for (const file of Object.keys(ENGINES)) {
    const src = read(file);
    assert.match(src, /calculateNewRatings\(/,
      `${file} must still compute ratings for staked matches`);
  }
});
