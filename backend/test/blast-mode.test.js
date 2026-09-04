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
  // nothing. How it drains is asserted below; this is only that it does.
  assert.ok(!/width: blastMode \? '100%' :/.test(CODE), 'the bar is pinned full again');
  assert.match(CODE, /blastDraining \? 'translateX\(-100%\)' : 'translateX\(0%\)'/);
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

test('the drain is linear, because it is a clock', () => {
  // An ease would spend longer near the ends and read as the timer slowing
  // down at the start and finish.
  assert.match(CODE, /`transform \$\{BLAST_MS\}ms linear`/);
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

// ── The drain has to be smooth ────────────────────────────────────────────

test('the bar is animated by the browser, not pushed from React', () => {
  // Setting the width 83 times a second is 83 renders of the whole board
  // competing with the grid for frames, and the bar visibly stepped — the
  // stutter was the updates arriving, not the animation. One transition lets
  // the compositor interpolate it.
  assert.ok(!/setEnergy\(\(left \/ BLAST_MS\) \* 100\)/.test(CODE),
    'the width is being pushed per tick again');
  assert.match(CODE, /transition: blastMode[\s\S]{0,40}transform \$\{BLAST_MS\}ms linear/,
    'the drain must be one linear transition');
});

test('the fill slides rather than being resized', () => {
  // width is a layout property; a transform can be composited. translateX
  // rather than scaleX because scaling squashes the rounded ends and the
  // gradient with them — sliding under the track's overflow keeps the
  // geometry exact.
  assert.match(CODE, /width: '100%',/);
  assert.ok(!/`width \$\{BLAST_MS\}ms linear`/.test(CODE), 'the width transition is back');
});

test('the pulse never touches transform', () => {
  // THE measured cause of the judder, and not a theory: verified in a browser
  // that an element with transform:translateX(-30%) plus a keyframe setting
  // transform:scale() computes to matrix(1.00149,0,0,1.00149,0,0) — the scale
  // alone, with the translate gone. A CSS animation replaces an inline
  // transform outright. So the pulse cancelled the drain, and pulsed the bar
  // twice a second besides.
  const kf = CODE.slice(CODE.indexOf('@keyframes powerUpPulse'), CODE.indexOf('`}</style>'));
  assert.ok(kf.length > 0, 'the keyframes are gone');
  assert.ok(!/transform:/.test(kf),
    'a keyframe that sets transform replaces the inline one entirely');
  assert.match(kf, /filter: brightness/);
  // And it belongs on the track, not on the fill it would otherwise cancel.
  const track = CODE.indexOf('bg-surface border border-border rounded-full overflow-hidden');
  const fill  = CODE.indexOf('transform: blastMode');
  const anim  = CODE.indexOf("animation: blastMode ? 'powerUpPulse");
  assert.ok(anim > track && anim < fill,
    'the pulse must sit on the track, above the fill it would otherwise cancel');
});

test('there is a frame between full and empty', () => {
  // Set to 0% in the same paint as 100% and there is nothing to animate from,
  // so the bar would simply be empty for five seconds.
  assert.match(CODE, /requestAnimationFrame\(\(\) => setBlastDraining\(true\)\)/);
  assert.match(CODE, /if \(!blastMode\) \{ setBlastDraining\(false\); return undefined; \}/);
});

test('the seconds counter is not what draws the bar', () => {
  // It can only ever show whole seconds, so that is all it is asked for — and
  // it stays on a deadline so it cannot disagree with the bar the browser is
  // animating on its own clock.
  assert.match(CODE, /setBlastSecondsLeft\(Math\.ceil\(left \/ 1000\)\)/);
  assert.match(CODE, /const left = until - Date\.now\(\)/);
});

// ── No queue screen for a bot match ───────────────────────────────────────

test('a bot match goes straight to the countdown', () => {
  // There is nobody to queue for: the room exists on the server the moment
  // the emit lands, so the queue screen showed for one frame on its way past.
  const FILES = {
    BlockBlastGame: CODE,
    BlackjackGame: strip(fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'BlackjackGame.jsx'), 'utf8')),
  };
  // Scoped to the enclosing function, not a window of characters around the
  // emit. joinQueue sits directly above playVsBot in both files, so a
  // fixed-width window reads the PvP queue call as if it belonged to the bot
  // path — which is what the first version of this test did, and it failed
  // against code that was already correct.
  const enclosing = (s, at) => {
    const start = s.lastIndexOf('function ', at);
    let depth = 0;
    for (let j = s.indexOf('{', start); j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return s.slice(start, j);
    }
    return s.slice(start);
  };
  for (const [name, src] of Object.entries(FILES)) {
    let found = 0;
    for (const m of src.matchAll(/_vs_bot'/g)) {
      const body = enclosing(src, m.index);
      // Only the functions a button calls — not socket handlers.
      if (!/^function play/.test(body)) continue;
      const fname = body.slice(9, body.indexOf('('));
      found++;

      // The setPhase NEAREST the emit, before or after it.
      //
      // Not "anywhere in the function": playAgain handles PvP and bot in two
      // branches, and its PvP branch legitimately queues — checking the whole
      // body flagged correct code. Not "the last one before the emit" either:
      // Block Burst sets the phase on the line after. Nearest is what
      // actually means "the phase set on the way into THIS match".
      const at = m.index - src.indexOf(body);
      let best = null, bestDist = Infinity;
      for (const p of body.matchAll(/setPhase\('(\w+)'\)/g)) {
        const d = Math.abs(p.index - at);
        if (d < bestDist) { bestDist = d; best = p[1]; }
      }
      assert.equal(best, 'countdown',
        `${name}.${fname} enters a bot match via the '${best}' phase, not the countdown`);
    }
    assert.ok(found >= 1, `${name}: no bot-match function found to check`);
  }
});

test('a PvP queue still shows the queue screen', () => {
  // The flicker fix must not remove the screen from the case that needs it —
  // there really is a wait when the opponent is a person.
  assert.match(CODE, /join_block_blast_queue[\s\S]{0,200}setPhase\('queue'\)/);
});
