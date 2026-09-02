// Making the demo look like a real lobby.
//
// Three separate tells, all of them the kind of thing you only notice by
// playing it: the same opponent name coming round again, an opponent whose
// survival time was always exactly 85% of yours, and a profile card that cut
// "Champion" to "Champio" and clipped its own rank badge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DEMO_ACCOUNT_IDS = process.env.DEMO_ACCOUNT_IDS || 'test-demo-id';
const { randomFunnyName, FUNNY_NAMES } = require('../src/services/demoAccounts');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const CARDASH = read('src', 'services', 'carDashEngine.js');
const POPUP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'ChatSidebar.jsx'), 'utf8');

// ── Names ─────────────────────────────────────────────────────────────────

test('a full pass over the pool repeats nothing', () => {
  // Independent random draws produced duplicates inside a dozen matches —
  // ordinary, not unlucky, at this pool size. Seeing the same stranger twice
  // in one sitting is the tell the realistic names exist to remove.
  const seen = new Set();
  for (let i = 0; i < FUNNY_NAMES.length; i++) seen.add(randomFunnyName());
  assert.equal(seen.size, FUNNY_NAMES.length, 'a bag must empty before it refills');
});

test('the same name never comes twice in a row, across bag boundaries', () => {
  // The seam is the whole difficulty: a naive reshuffle can put the name just
  // used at the front of the next bag, which is the one repeat a player is
  // most likely to notice.
  // A thousand bags, not forty.
  //
  // A back-to-back repeat can only happen AT a seam, and only when the
  // reshuffle happens to place the just-drawn name at the draw end — about a
  // 1-in-90 chance per seam. Forty seams catches a broken guard barely a third
  // of the time, which is how the first version of this test passed against
  // the wrong end of the bag. A thousand seams misses with probability around
  // one in eighty thousand, and costs a few milliseconds.
  let prev = null;
  for (let i = 0; i < FUNNY_NAMES.length * 1000; i++) {
    const n = randomFunnyName();
    assert.notEqual(n, prev, `"${n}" repeated back to back at draw ${i}`);
    prev = n;
  }
});

test('the pool is big enough to be worth having', () => {
  assert.ok(FUNNY_NAMES.length >= 80, `only ${FUNNY_NAMES.length} names`);
  assert.equal(new Set(FUNNY_NAMES).size, FUNNY_NAMES.length, 'duplicate entries shrink the bag');
});

// ── Rush Hour's rigged opponent ───────────────────────────────────────────

test('the bot no longer posts a fixed fraction of the player time', () => {
  // 0.85x on both time and score, every match: survive 28 seconds and the
  // opponent always died at 24, with a score in the same ratio. A real
  // opponent's run is not a scaled copy of yours.
  assert.ok(!/Math\.floor\(hT \* 0\.85\)/.test(CARDASH), 'the fixed time ratio is back');
  assert.ok(!/Math\.floor\(hS \* 0\.85\)/.test(CARDASH), 'the fixed score ratio is back');
  assert.match(CARDASH, /const gap = Math\.max\(1_200, Math\.floor\(hT \* rand\(0\.08, 0\.42\)\)\)/);
  assert.match(CARDASH, /scoreFromMs = \(ms\)/,
    "the bot's score must come from its own time, not from the player's score");
});

test('the rigged result still holds', () => {
  // Varying the margin must not accidentally hand the bot the win the demo
  // exists to prevent — score is what decides, so it stays strictly under.
  assert.match(CARDASH, /Math\.min\(scoreFromMs\(bT\), Math\.max\(0, hS - 1\)\)/);
  // And when the bot is meant to win, it leads on both, since time breaks a tie.
  assert.match(CARDASH, /Math\.max\(hS \+ 1, scoreFromMs\(bT\)\)/);
});

test('the losing bot never posts an implausible run', () => {
  // A player who crashes at three seconds would otherwise give the bot a
  // sub-second time, which reads as broken rather than as an opponent.
  assert.match(CARDASH, /Math\.max\(2_000, hT - gap\)/);
});

// ── The profile popup ─────────────────────────────────────────────────────

test('the rank tile scales instead of truncating', () => {
  // truncate on a flex row shortens the text AND squeezes the icon, so the
  // two things that say what the rank IS were the two that went missing.
  // Comments stripped first: the note explaining why truncate was removed
  // says "truncate", and a test that reads prose passes when someone deletes
  // the code and keeps the note.
  const grid = POPUP.slice(POPUP.indexOf("{ label: 'ELO'"), POPUP.indexOf('{/* Wagered */}'))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/truncate/.test(grid), 'truncate cuts the rank name and the badge with it');
  assert.match(grid, /<FitText className="text-xs font-bold mt-1"/);
  assert.match(grid, /<RankIcon rank=\{s\.rank\} size=\{13\} \/>\{s\.rank\.name\}/);
  assert.match(grid, /text-xl sm:text-2xl font-black/, 'the rating is smaller on a phone');
});

test('the popup calls an unplaced account Unranked', () => {
  // Same bug the profile page had: getRank on a raw rating calls a new player
  // Bronze, because it cannot know they have never played.
  assert.ok(!/getRank\(data\.elo/.test(POPUP));
  assert.match(POPUP, /getDisplayRank\(data\)/);
});

test('both wagered labels are laid out the same way', () => {
  // "Diamonds Wagered" wrapped to two lines while "Coins Wagered" stayed on
  // one, so the two cards beside each other were different heights.
  const coins = /<FitText className="text-xs sm:text-sm text-muted mb-1">Coins Wagered<\/FitText>/;
  const diamonds = /<FitText className="text-xs sm:text-sm text-muted mb-1">Diamonds Wagered<\/FitText>/;
  assert.match(POPUP, coins);
  assert.match(POPUP, diamonds);
});
