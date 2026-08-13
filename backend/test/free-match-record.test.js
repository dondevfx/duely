// A free match is still a match: it has a winner, a loser and a score. What it
// must not do is move a rating or pay anything out, because nothing was staked.
//
// Every engine used to bundle those two decisions into one condition —
// `if (!isFree) { applyEloUpdate(...); increment_win(...) }` — so switching off
// the rating for free play also switched off the record, and a free game did
// not appear to have happened at all.
//
// These assert the two are gated separately. The regression they guard against
// is re-merging them, which is the natural thing to do when adding a game.
//
// Checked by walking the enclosing `if` blocks rather than scanning a window of
// nearby text. A window is useless here: in the ORIGINAL code the nearest few
// characters before increment_win were the end of the ELO call, so a text scan
// reported the counter as ungated and passed against the very bug it exists to
// catch. Enclosing-block analysis sees `if (!isFree)` wherever it sits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Source with comments stripped, starting AFTER the requires — `applyEloUpdate`
// appears in the import line too, and matching that instead of the call site is
// another way this test can fool itself.
function body(file) {
  const raw = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'services', file), 'utf8')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  return raw.slice(raw.indexOf('\n', raw.lastIndexOf("require('./")));
}

// Conditions of every `if` block enclosing `idx`, innermost first.
function enclosingIfs(src, idx) {
  const conds = [];
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') { depth++; continue; }
    if (ch !== '{') continue;
    if (depth > 0) { depth--; continue; }

    // An unclosed '{' before idx opens a block that contains it. If it is an
    // `if`, the text just before it is `... if ( <cond> )`.
    const head = src.slice(0, i).trimEnd();
    if (!head.endsWith(')')) continue;
    let p = head.length - 1, d = 0;
    for (; p >= 0; p--) {
      if (head[p] === ')') d++;
      else if (head[p] === '(') { if (--d === 0) break; }
    }
    if (p < 0) continue;
    if (/\bif\s*$/.test(head.slice(0, p))) conds.push(head.slice(p + 1, -1).trim());
  }
  return conds;
}

const occurrences = (src, needle) => {
  const out = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i);
  return out;
};

const STAKE = /isFree|freeSolo|\branked\b/;

// The condition each engine uses to mean "this match is rated".
const RATED_GATE = {
  'blackjackEngine.js':  /!isFree/,
  'coinFlipEngine.js':   /!isFree/,
  'blockBlastEngine.js': /!isFree|!freeSolo/,
  'carDashEngine.js':    /\branked\b/,
};

for (const [file, gate] of Object.entries(RATED_GATE)) {
  test(`${file} rates only a staked match`, () => {
    const src = body(file);
    const calls = occurrences(src, 'applyEloUpdate(');
    assert.ok(calls.length > 0, 'no applyEloUpdate call found');
    for (const at of calls) {
      const conds = enclosingIfs(src, at);
      assert.ok(conds.some(c => gate.test(c)),
        `${file} applies a rating with no stake check in scope: [${conds.join(' | ')}]`);
    }
  });

  test(`${file} counts the win regardless of stake`, () => {
    const src = body(file);
    const calls = occurrences(src, "increment_win'");
    assert.ok(calls.length > 0, 'no increment_win call found');
    let contested = 0;
    for (const at of calls) {
      const conds = enclosingIfs(src, at);
      // Block Burst's free solo endless is excluded on purpose — see the
      // dedicated test below. It cannot be lost, so it is not a contest.
      if (conds.some(c => /freeSolo/.test(c))) continue;
      contested++;
      const blocking = conds.filter(c => STAKE.test(c));
      assert.deepEqual(blocking, [],
        `${file} still drops free wins from the record, gated by: ${blocking.join(' | ')}`);
    }
    assert.ok(contested > 0, `${file}: no contested win counter found`);
  });
}

test('a blackjack draw is still neither a win nor a loss', () => {
  // Separating record from rating must not turn a draw into a win.
  const src = body('blackjackEngine.js');
  for (const at of occurrences(src, "increment_win'")) {
    assert.ok(enclosingIfs(src, at).some(c => /!isDraw/.test(c)),
      'the counters must stay inside the !isDraw branch');
  }
});

test('Word VS counted free matches all along, and still does', () => {
  const src = body('wordleEngine.js');
  for (const at of occurrences(src, "increment_win'")) {
    assert.deepEqual(enclosingIfs(src, at).filter(c => /isFree/.test(c)), []);
  }
});

test('Word VS still refuses to rate a free match', () => {
  // The bug fixed alongside this: it wrote ratings regardless of stake.
  const src = body('wordleEngine.js');
  assert.match(src, /if \(winner && loser && !isFree\)/);
  for (const at of occurrences(src, 'update({ elo: new')) {
    assert.ok(enclosingIfs(src, at).some(c => /!= null/.test(c)),
      'a rating write must be gated on actually having a rating');
  }
});

test('an unloseable solo run records a score but not a win', () => {
  // The one place the "free still counts" rule is deliberately not applied.
  //
  // Block Burst's free solo endless always wins by design. Counting that toward
  // the win record would be a farm: queue solo, crash immediately, bank a win,
  // repeat — and the profile's W/L would stop meaning anything. A win needs an
  // opponent, and this mode has none. Rush Hour's solo endless already records
  // no W/L either, so the two solo modes agree.
  //
  // The score still counts, because a personal best is the point of the mode.
  const src = body('blockBlastEngine.js');
  const solo = occurrences(src, "increment_win'")
    .filter(at => enclosingIfs(src, at).some(c => /freeSolo/.test(c)));
  assert.equal(solo.length, 1, 'expected exactly one solo win counter, behind the freeSolo gate');

  const hs = occurrences(src, 'updateHighscore(')
    .filter(at => enclosingIfs(src, at).some(c => /freeSolo/.test(c)));
  assert.equal(hs.length, 0, 'the solo highscore must NOT sit behind the freeSolo gate');
});

test('a score is recorded regardless of stake', () => {
  for (const f of ['blockBlastEngine.js', 'carDashEngine.js', 'wordleEngine.js']) {
    const src = body(f);
    const calls = [...occurrences(src, 'updateHighscore('), ...occurrences(src, 'updateHighscorePair(')];
    assert.ok(calls.length > 0, `${f}: no highscore update found`);
    for (const at of calls) {
      const blocking = enclosingIfs(src, at).filter(c => STAKE.test(c));
      assert.deepEqual(blocking, [], `${f} gates its score on the stake: ${blocking.join(' | ')}`);
    }
  }
});
