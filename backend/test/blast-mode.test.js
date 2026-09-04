// Blast mode: the bar that runs backwards, and the taps that used to vanish.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'BlockBlastGame.jsx'), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = strip(SRC);

const blastClick = CODE.slice(CODE.indexOf('function handleBlastClick'),
                              CODE.indexOf('\n  }', CODE.indexOf('function handleBlastClick')));

test('the bar drains instead of sitting full', () => {
  // Two things said the same thing — a bar pinned at 100% and a number
  // counting down beside it — and the bar, the bigger of the two, said
  // nothing.
  assert.match(CODE, /setEnergy\(\(left \/ BLAST_MS\) \* 100\)/);
  assert.ok(!/width: blastMode \? '100%'/.test(CODE), 'the bar is pinned full again');
  assert.match(CODE, /width: `\$\{energy\}%`/);
});

test('the drain is measured against a deadline, not counted down', () => {
  // A tick that arrives late — a dropped frame, a backgrounded tab — would
  // otherwise stretch the five seconds. Reading the clock each time keeps the
  // bar where the wall clock says it should be.
  assert.match(CODE, /const left = until - Date\.now\(\)/);
  assert.match(CODE, /blastUntilRef\.current = Date\.now\(\) \+ BLAST_MS/);
});

test('one constant for how long blast lasts', () => {
  // The countdown, the drain and the backstop timeout all have to agree.
  assert.match(CODE, /const BLAST_MS = 5000;/);
  assert.ok(!/\b5000\b(?!.*BLAST_MS)/.test(CODE.replace('const BLAST_MS = 5000;', '')) ||
            (CODE.match(/5000/g) || []).length === 1,
    'a bare 5000 somewhere else will drift out of step');
});

test('the bar does not ease while it is draining', () => {
  // The drain already moves it every 60ms; a 200ms transition on top makes
  // the bar lag its own countdown.
  assert.match(CODE, /blastMode \? '' : 'transition-all duration-200'/);
});

// ── The taps that vanished ────────────────────────────────────────────────

test('a blast tap applies immediately', () => {
  // Everything used to sit inside a 200ms setTimeout so the flash could play
  // over the old cells. Tapping faster than that lost rows:
  //   tap A -> timer scheduled carrying grid A and score A
  //   tap B -> reads scoreRef, which timer A has not written yet
  //   +200  -> timer A puts the board back, undoing B on screen
  //   +300  -> timer B writes score B, and A's points are gone
  assert.ok(!/setTimeout\(\(\) => \{\s*setGrid\(g\);/.test(blastClick),
    'the board update is behind a timer again');
  const setGridAt = blastClick.indexOf('setGrid(g);');
  const firstTimer = blastClick.indexOf('setTimeout');
  assert.ok(setGridAt > 0, 'the board is never updated');
  assert.ok(firstTimer === -1 || setGridAt < firstTimer,
    'the board must be written before any timer is scheduled');
  for (const line of ['scoreRef.current = newScore;', 'setScore(newScore);']) {
    assert.ok(blastClick.includes(line), `${line} is missing`);
  }
});

test('the score is read and written in the same tick', () => {
  // The stale read is the part that actually lost points: scoreRef was only
  // written inside the timer, so a second tap computed its total from the
  // score before the first.
  const read  = blastClick.indexOf('scoreRef.current + pts');
  const write = blastClick.indexOf('scoreRef.current = newScore');
  assert.ok(read > 0 && write > read, 'the write must follow the read directly');
  const between = blastClick.slice(read, write);
  assert.ok(!/setTimeout/.test(between), 'a timer sits between reading and writing the score');
});

test('overlapping flashes add rather than replace', () => {
  // setFlashCells(cells) with a fresh Set threw away a still-playing flash
  // from the previous tap. Additive, so two quick taps light up both rows.
  assert.match(blastClick, /setFlashCells\(prev => \{/);
  assert.match(blastClick, /next\.add\(k\)/);
  assert.match(blastClick, /next\.delete\(k\)/);
});

test('a cell responds on contact, not on release', () => {
  // A click only counts if press and release land on the SAME cell. Tap fast
  // on a gapped grid and a finger that slides one cell between the two
  // produces no click at all.
  assert.match(CODE, /onPointerDown=\{\(\) => blastMode && handleBlastClick\(r\)\}/);
  assert.ok(!/onClick=\{\(\) => blastMode && handleBlastClick\(r\)\}/.test(CODE),
    'click waits for release and can be dropped entirely');
});
