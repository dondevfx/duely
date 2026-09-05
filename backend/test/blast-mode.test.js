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

test('a bot match reaches a countdown the page can actually render', () => {
  // Two rules, and the second is the one I broke.
  //
  // A bot match has nobody to wait for, so it must not sit on a searching
  // screen. But "set the phase to 'countdown'" is not the rule — Blackjack
  // has no such phase: its queue branch renders the countdown whenever
  // countdown > 0 and the spinner otherwise, so setting the count first is
  // what skips the spinner. Renaming the phase there rendered nothing at all,
  // because no branch matched, and the countdown vanished from the game.
  //
  // So: whatever phase the bot path sets, the page has to have a branch for
  // it, and a countdown has to be on screen when it arrives.
  const PAGES = ['BlockBlastGame', 'BlackjackGame', 'CoinFlipGame'];
  const enclosing = (s, at) => {
    const start = s.lastIndexOf('function ', at);
    let depth = 0;
    for (let j = s.indexOf('{', start); j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return s.slice(start, j);
    }
    return s.slice(start);
  };

  for (const page of PAGES) {
    const src = strip(fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', `${page}.jsx`), 'utf8'));
    let found = 0;
    for (const m of src.matchAll(/_vs_bot'/g)) {
      const body = enclosing(src, m.index);
      if (!/^function play/.test(body)) continue;
      const fname = body.slice(9, body.indexOf('('));
      found++;

      // The setPhase nearest the emit — not "anywhere in the function", since
      // playAgain handles PvP and bot in two branches and its PvP branch
      // legitimately queues.
      const at = m.index - src.indexOf(body);
      let phase = null, bestDist = Infinity;
      for (const p of body.matchAll(/setPhase\('(\w+)'\)/g)) {
        const d = Math.abs(p.index - at);
        if (d < bestDist) { bestDist = d; phase = p[1]; }
      }
      assert.ok(phase, `${page}.${fname} sets no phase at all`);

      // 1. The page must render that phase.
      assert.ok(new RegExp(`phase === '${phase}'`).test(src),
        `${page}.${fname} enters the '${phase}' phase, which ${page} never renders`);

      // 2. A countdown has to be showing when it gets there — either the
      //    branch is the countdown, or it is gated on countdown > 0.
      const isCountdownPhase = phase === 'countdown';
      // Plain string scanning, no escapes.
      //
      // The regex version of this read `[\s\S]` inside a template literal,
      // where a backslash-s is just an "s" — the pattern silently became
      // `[sS]{0,400}` and matched nothing, so a correct page was reported as
      // having no countdown. Same class of mistake as the two earlier ones in
      // this suite. Every occurrence is checked, because the first is the
      // scroll-lock call rather than a render branch.
      const needle = `phase === '${phase}'`;
      let gatesOnCount = false;
      for (let k = src.indexOf(needle); k !== -1; k = src.indexOf(needle, k + 1)) {
        if (src.slice(k, k + 400).includes('countdown > 0')) { gatesOnCount = true; break; }
      }
      assert.ok(isCountdownPhase || gatesOnCount,
        `${page}.${fname} lands on '${phase}', which shows no countdown`);

      // 3. And the count is set, or the countdown branch has nothing to show.
      // Both measured from the emit, for the same reason the phase was:
      // playAgain has a PvP branch and a bot branch, and the PvP branch's
      // setPhase sits BEFORE the bot branch's setCountdown in the file. Taking
      // the first of each in the function said the count came second when it
      // does not — a correct page reported as broken.
      const nearest = (re) => {
        let best = null, dist = Infinity;
        for (const x of body.matchAll(re)) {
          const d = Math.abs(x.index - at);
          if (d < dist) { dist = d; best = x.index; }
        }
        return best;
      };
      const cAt = nearest(/setCountdown\((\d+)\)/g);
      assert.ok(cAt !== null, `${page}.${fname} never sets the count`);
      if (gatesOnCount) {
        const pAt = nearest(/setPhase\('\w+'\)/g);
        assert.ok(cAt < pAt,
          `${page}.${fname} sets the phase before the count, so the searching screen shows first`);
      }
    }
    assert.ok(found >= 1, `${page}: no bot-match function found to check`);
  }
});

test('every game has a countdown before play', () => {
  // Quick Match is the exception and is meant to be: it picks a game and
  // navigates into it, and that page runs its own countdown.
  const GAMES = ['BlockBlastGame', 'CarDashGame', 'ColorRushGame', 'TowerGame',
                 'WordleGame', 'CoinFlipGame', 'BlackjackGame'];
  for (const page of GAMES) {
    const src = strip(fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', `${page}.jsx`), 'utf8'));
    assert.match(src, /setCountdown\(/, `${page} never sets a countdown`);
    assert.ok(/phase === 'countdown'/.test(src) || /countdown > 0/.test(src),
      `${page} never renders a countdown`);
  }
});

test('a PvP queue still shows the queue screen', () => {
  // The flicker fix must not remove the screen from the case that needs it —
  // there really is a wait when the opponent is a person.
  assert.match(CODE, /join_block_blast_queue[\s\S]{0,200}setPhase\('queue'\)/);
});
