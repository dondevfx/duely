// A free solo run is practice. Two rules have to hold together, and either one
// alone is a bug:
//
//   1. You cannot lose it. There is no stake, so losing to a bot you never bet
//      against is discouragement with nothing behind it.
//
//   2. It cannot touch rating or record. An unloseable game that awarded ELO is
//      an infinite ladder — queue solo, crash immediately, gain rating, repeat.
//
// Rule 1 without rule 2 is the dangerous combination, which is why they are
// tested as a pair rather than separately.
//
// Read from source: the settle path needs a live room, io and supabase. Comments
// are stripped first — an earlier test in this repo passed against its own prose
// instead of the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'services', 'blockBlastEngine.js'), 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

// The solo SETTLE block. There is more than one `if (room.isSolo)` in this file
// — an earlier one only drives the bot's live score — so anchor on the settle
// itself and walk back to the branch that contains it.
const anchor = src.indexOf('const freeSolo');
assert.ok(anchor > 0, 'free-solo handling not found');
const solo = src.slice(src.lastIndexOf('if (room.isSolo) {', anchor));
const block = solo.slice(0, solo.indexOf('\n    return;'));

test('a free run is identified by there being no stake', () => {
  assert.match(block, /const freeSolo = !\(room\.entryFee > 0\)/,
    'free must mean "no entry fee", not a separate flag that could disagree');
});

test('a free run always wins', () => {
  assert.match(block, /const humanWon = alwaysWin \? true :/);
  assert.match(block, /alwaysWin = room\.demoWin \|\| freeSolo/);
});

test('the bot score is forced below the player on a guaranteed win', () => {
  // Otherwise the card claims a victory while showing a higher bot score.
  assert.match(block, /if \(alwaysWin && botScore >= verifiedScore\)/);
});

test('a free run writes no rating and no win record', () => {
  // The guard that stops the unloseable game becoming a rating farm.
  assert.match(block, /if \(supabase && !freeSolo\) \{/);

  const gate = block.indexOf('if (supabase && !freeSolo)');
  const gated = block.slice(gate);
  for (const marker of ['elo:', 'increment_win', "from('matches')"]) {
    const at = gated.indexOf(marker);
    assert.ok(at > 0, `${marker} should live inside the paid-only branch`);
  }
  // Nothing rating-related may appear before the gate.
  const before = block.slice(0, gate);
  assert.doesNotMatch(before, /increment_win|increment_loss/);
  assert.doesNotMatch(before, /calculateNewRatings/);
});

test('a personal best is still recorded for a free run', () => {
  // Chasing a high score is the entire point of the mode, so this one must sit
  // OUTSIDE the paid-only gate.
  const gate = block.indexOf('if (supabase && !freeSolo)');
  const hs = block.indexOf('updateHighscore');
  assert.ok(hs > 0, 'highscore update not found');

  // It must be reached by a plain `if (supabase)`, not the gated branch.
  const preceding = block.slice(0, hs);
  const lastGuard = preceding.lastIndexOf('if (supabase');
  assert.ok(lastGuard > gate, 'the highscore update must be re-guarded after the paid-only block');
  assert.match(block.slice(lastGuard, hs), /if \(supabase\) \{/);
});

test('a paid bot match can still be lost and still counts', () => {
  // The money path must be untouched: settleBotMatch is still driven by the
  // real comparison, and a paid loss still pays out as a loss.
  assert.match(block, /room\.entryFee > 0[\s\S]*settleBotMatch\([\s\S]*humanWon/);
});
