// Two things a new account cannot get past on a phone.
//
// The age/terms gate linked to the documents it was asking you to agree to,
// and on a phone those links opened nothing — so the one thing someone was
// being asked to accept was the one thing they could not read. And the result
// card carried a placement tracker that only appears during an account's first
// three matches, laid out tall enough to push the card off a small screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const MODAL  = read('components', 'AgeToSModal.jsx');
const RESULT = read('components', 'ResultScreen.jsx');
const LEGAL  = read('data', 'legal.js');
const TOS_PAGE     = read('pages', 'ToS.jsx');
const PRIVACY_PAGE = read('pages', 'Privacy.jsx');

test('the gate opens the documents in place, not through a link', () => {
  // target="_blank" from inside a full-screen gate that blocks navigation
  // opens nothing on a phone, and in a webview there may be no tab to open.
  assert.ok(!/<Link[^>]*to="\/(tos|privacy)"/.test(MODAL),
    'the modal must not rely on navigating away to show the terms');
  assert.match(MODAL, /onClick=\{\(\) => setDoc\('tos'\)\}/);
  assert.match(MODAL, /onClick=\{\(\) => setDoc\('privacy'\)\}/);
});

test('both documents are scrollable, with the chrome pinned', () => {
  const doc = MODAL.slice(MODAL.indexOf('if (doc) {'), MODAL.indexOf('return (\n    <div className="fixed inset-0 z-50'));
  assert.match(doc, /overflow-y-auto/, 'the body must scroll');
  assert.match(doc, /max-h-full/, 'and the panel must be bounded by the screen');
  // shrink-0 on the header and the footer is what keeps the Back button
  // reachable on a short screen instead of scrolling away with the text.
  // Counted in className attributes only — the comment above them in the
  // source says "shrink-0" too, and a test that counts prose is a test that
  // passes when someone deletes the code and keeps the note.
  const classes = doc.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.equal((classes.match(/shrink-0/g) || []).length, 2);
  assert.match(doc, /TOS_SECTIONS/);
  assert.match(doc, /PRIVACY_SECTIONS/);
});

test('there is one copy of each document, not two', () => {
  // Two copies of a legal document is one that quietly stops matching what
  // people actually agreed to.
  assert.match(LEGAL, /export const TOS_SECTIONS/);
  assert.match(LEGAL, /export const PRIVACY_SECTIONS/);
  assert.match(TOS_PAGE, /import \{ TOS_SECTIONS \} from '\.\.\/data\/legal'/);
  assert.match(PRIVACY_PAGE, /import \{ PRIVACY_SECTIONS \} from '\.\.\/data\/legal'/);
  // The pages must render the shared data rather than an inline array of
  // their own — an inline `title:` here is a second copy.
  for (const [name, page] of [['ToS', TOS_PAGE], ['Privacy', PRIVACY_PAGE]]) {
    assert.ok(!/^\s+title: '/m.test(page), `${page && name} still holds its own copy of the text`);
  }
});

test('the documents kept their sections through the move', () => {
  // 15 in the Terms, 14 in the Privacy Policy. A silent truncation while
  // lifting them out would be the worst possible outcome of a refactor here.
  assert.equal((LEGAL.match(/^\s+title: '/gm) || []).length, 29);
  assert.match(LEGAL, /14\. Dispute Resolution and Arbitration/);
  assert.match(LEGAL, /15\. Changes to Terms/);
});

test('the placement row is one line on a phone and unchanged above sm', () => {
  const block = RESULT.slice(RESULT.indexOf('{!solo && !ranked &&'), RESULT.indexOf('{/* Stats */}'));
  assert.match(block, /flex items-center justify-center gap-2 sm:flex-col/,
    'a row on a phone, a column on a desktop');
  // Nothing is deleted — the longer wording is still there, just hidden on the
  // narrow layout.
  assert.match(block, /hidden sm:inline"> Matches</);
  assert.match(block, /hidden sm:inline"> — \{3 - placement\} match/);
});

test('the result card is tightened on a phone only', () => {
  // Every one of these is padding or a gap, and every one restores at sm.
  for (const cls of [
    'p-4 sm:p-7',
    'text-center mb-3 sm:mb-5',
    'p-3 sm:p-4 mb-3 sm:mb-4',
    'mt-3 sm:mt-4',
    'text-center mt-2 sm:mt-4',
  ]) {
    assert.ok(RESULT.includes(cls), `expected "${cls}" in ResultScreen`);
  }
  assert.ok(!/className="p-7"/.test(RESULT), 'the fixed desktop padding must be gone');
});

test('the game label never breaks across two lines', () => {
  // It sits opposite the player names in a justify-between row, and the names
  // take the space first — so a long username squeezed "Solo Endless" until it
  // broke, with "Endless" under "Solo". Reproduced at 360px: two lines with a
  // long name, one after.
  //
  // The names already truncate (min-w-0 + overflow-hidden), so the label
  // giving up its flexibility costs nothing — the side that can shorten
  // gracefully is the side that should.
  assert.match(RESULT, /className="text-xs text-muted whitespace-nowrap shrink-0">\{gameLabel\}/);
  // And the side that absorbs the squeeze still can.
  assert.match(RESULT, /className="text-muted min-w-0 flex items-center gap-1\.5 overflow-hidden"/);
});
