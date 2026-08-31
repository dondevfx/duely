// Color Rush — the sixth game.
//
// Two things this file is actually watching for.
//
// First, REGISTRATION. Adding a game to this codebase means touching about
// eighteen separate lists, and the failure mode is never a crash — it is a game
// that quietly does not appear in the sidebar, or whose invites come back
// "Invalid game", or that is missing from the admin breakdown. Every one of
// those has already happened here at least once for some other game.
//
// Second, FAIRNESS. This is a staked match, so both players must climb the
// identical course and the server must never take the client's word for a
// score.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const HANDLERS = strip(be('socket', 'handlers.js'));
const ENGINE   = strip(be('services', 'colorRushEngine.js'));
const CANVAS   = strip(fe('components', 'ColorRushCanvas.jsx'));
const PAGE     = strip(fe('pages', 'ColorRushGame.jsx'));

// ── Registration ────────────────────────────────────────────────────────────

test('the game is registered everywhere a game has to be registered', () => {
  const sites = [
    ['App route',        fe('App.jsx'),                          /path="\/game\/color-rush"/],
    ['App import',       fe('App.jsx'),                          /import ColorRushGame/],
    ['games list',       fe('data', 'games.js'),                 /slug:\s*'color-rush'/],
    ['navbar',           fe('components', 'Navbar.jsx'),         /\/game\/color-rush/],
    ['sidebar list',     fe('components', 'LeftSidebar.jsx'),    /\/game\/color-rush/],
    ['sidebar key map',  fe('components', 'LeftSidebar.jsx'),    /'\/game\/color-rush':\s*'color-rush'/],
    ['quick match',      fe('pages', 'QuickMatch.jsx'),          /queueKey: 'color-rush'/],
    ['in-game help',     fe('components', 'GameHelp.jsx'),       /colorRush:/],
    ['challenge link',   fe('components', 'ChallengeLinkBox.jsx'), /colorRush/],
    ['invite toast route', fe('components', 'InviteToasts.jsx'), /colorRush:\s*'\/game\/color-rush'/],
    ['invite toast name',  fe('components', 'InviteToasts.jsx'), /colorRush:\s*'Color Rush'/],
    ['join modal',       fe('components', 'JoinRoomModal.jsx'),  /colorRush/],
    ['challenge page',   fe('pages', 'ChallengeJoin.jsx'),       /colorRush:\s*'\/game\/color-rush'/],
    ['lobby alias',      fe('components', 'GameLobby.jsx'),      /'color-rush':\s*'colorRush'/],
    ['admin breakdown',  fe('pages', 'Admin.jsx'),               /key: 'colorRush'/],
    ['leaderboard tab',  fe('pages', 'Leaderboard.jsx'),         /id: 'colorRush'/],
    ['profile stats',    fe('pages', 'Profile.jsx'),             /colorRush:\s*\{/],
    ['ticker',           be('services', 'tickerService.js'),     /colorRush:/],
    ['leaderboard score games', be('routes', 'leaderboard.js'),  /'colorRush'/],
    ['server alias',     be('socket', 'handlers.js'),            /'color-rush':\s*'colorRush'/],
    ['server valid type',be('socket', 'handlers.js'),            /VALID_GAME_TYPES[^\n]*colorRush/],
  ];
  const missing = sites.filter(([, src, re]) => !re.test(src)).map(([name]) => name);
  assert.deepEqual(missing, [], `not registered in: ${missing.join(', ')}`);
});

test('the icon is drawn once and reused, not respelled per list', () => {
  // The icon used to be an emoji literal copied into a dozen lists, and the
  // one that got missed showed a different game's face in the sidebar. There
  // is now a single drawing per game, so the thing to check is that nothing
  // has quietly gone back to spelling its own.
  const icons = fe('components', 'GameIcon.jsx');
  assert.match(icons, /function ColorRush\(\)/, 'Color Rush needs an icon');
  assert.match(icons, /colorRush:\s+ColorRush,/, 'wired to the colorRush key');

  // Every place that lists games must ASK for the icon rather than carry one.
  const sites = [
    ['games list',   fe('data', 'games.js')],
    ['navbar',       fe('components', 'Navbar.jsx')],
    ['sidebar',      fe('components', 'LeftSidebar.jsx')],
    ['quick match',  fe('pages', 'QuickMatch.jsx')],
    ['leaderboard',  fe('pages', 'Leaderboard.jsx')],
    ['profile',      fe('pages', 'Profile.jsx')],
    ['help panel',   fe('components', 'GameHelp.jsx')],
    ['join modal',   fe('components', 'JoinRoomModal.jsx')],
    ['challenge',    fe('pages', 'ChallengeJoin.jsx')],
    ['lobby',        fe('components', 'GameLobby.jsx')],
    ['ticker',       fe('components', 'MatchTicker.jsx')],
  ];
  const missing = sites.filter(([, src]) => !/GameIcon/.test(src)).map(([n]) => n);
  assert.deepEqual(missing, [], `still spelling their own icon: ${missing.join(', ')}`);
});

test('no game list carries a leftover emoji of its own', () => {
  // The failure this catches: half the lists converted, half still printing an
  // emoji, so the same game wears two different faces on two screens.
  const GAME_EMOJI = /[\u{1F0CF}\u{1F7E6}\u{1F7E1}\u{1F697}\u{1F5FC}\u{1F524}\u{1F3A8}\u{1F300}]/u;
  const sites = [
    ['games list',  fe('data', 'games.js')],
    ['navbar',      fe('components', 'Navbar.jsx')],
    ['quick match', fe('pages', 'QuickMatch.jsx')],
    ['help panel',  fe('components', 'GameHelp.jsx')],
    ['join modal',  fe('components', 'JoinRoomModal.jsx')],
    ['challenge',   fe('pages', 'ChallengeJoin.jsx')],
    ['ticker data', be('services', 'tickerService.js')],
  ];
  const bad = sites.filter(([, src]) => GAME_EMOJI.test(src)).map(([n]) => n);
  assert.deepEqual(bad, [], `game emoji left behind in: ${bad.join(', ')}`);
});


test('the room lookup tables all know about it', () => {
  // Three separate copies of this table drive forfeits, disconnects and the
  // leave path. A game missing from one of them leaves matches that never
  // settle when a player drops.
  const n = (HANDLERS.match(/getColorRushRoomBySocket,\s*deleteColorRushRoom,\s*'colorRush'/g) || []).length;
  assert.equal(n, 3, `expected 3 room-lookup registrations, found ${n}`);
});

test('invites and codes can start one', () => {
  // _pairPrivatePlayers is a switch on game type; a missing case is a code that
  // mints fine and then does nothing for either player, which is exactly how
  // Rush Hour shipped originally.
  assert.match(HANDLERS, /case 'colorRush':\s*\{[\s\S]{0,600}?createDirectColorRushRoom/);
  assert.match(HANDLERS, /case 'colorRush':[\s\S]{0,1200}?startColorRushCountdown/);
});

test('a private Color Rush match is marked private, a queued one is not', () => {
  const priv = HANDLERS.slice(HANDLERS.indexOf('async function _pairPrivatePlayers'));
  assert.match(priv, /color_rush_match_found[^\n]*isPrivate: true/,
    'a private match must tell the client so, or Rematch never appears');

  // And the QUEUE path must not claim to be private. It did for two other
  // games: a queue match then offered a Rematch that no server-side offer
  // existed for, so the button did nothing.
  const q = HANDLERS.slice(HANDLERS.indexOf("socket.on('join_color_rush_queue'"),
                            HANDLERS.indexOf("socket.on('leave_color_rush_queue'"));
  assert.doesNotMatch(q, /isPrivate: true/,
    'the queue path must NOT mark matches private');
});

test('no queue path anywhere claims to be private', () => {
  // The general form of the bug above — cheaper to assert once for all games
  // than to remember it per game.
  const bad = [];
  for (const m of HANDLERS.matchAll(/socket\.on\('join_(\w+?)_queue'[\s\S]*?(?=socket\.on\(')/g)) {
    if (/isPrivate: true/.test(m[0])) bad.push(m[1]);
  }
  assert.deepEqual(bad, [], `queue handlers wrongly marking matches private: ${bad.join(', ')}`);
});

// ── The server owns the outcome ─────────────────────────────────────────────

test('a claimed score is clamped against server-measured time', () => {
  assert.match(ENGINE, /const maxScoreFor = \(ms\) =>/);
  for (const fn of ['trackColorRushProgress', 'handleColorRushDeath']) {
    const at = ENGINE.indexOf(`function ${fn}`);
    assert.notEqual(at, -1, `${fn} is gone`);
    const body = ENGINE.slice(at, ENGINE.indexOf('\n}', at));
    assert.match(body, /maxScoreFor\(/, `${fn} must clamp the claimed score`);
  }
});

test('survival time is measured, never accepted', () => {
  const at = ENGINE.indexOf('async function handleColorRushDeath');
  const body = ENGINE.slice(at, ENGINE.indexOf('\n}', at));
  assert.match(body, /Date\.now\(\) - room\.startedAt/,
    'the server must time the run itself');
  assert.doesNotMatch(body, /room\.times\[socketId\] = Number\(/,
    'a client-claimed time must never be stored directly');
});

test('settlement cannot run twice', () => {
  // This is the +44 ELO bug. Several paths funnel into _resolveFromTimes and
  // two landing in the same tick both passed a check-only guard, applying the
  // rating change twice.
  const at = ENGINE.indexOf('async function _resolveFromTimes');
  const body = ENGINE.slice(at, at + 900);
  assert.match(body, /if \([^)]*room\.resolving\) return;/,
    'the room must be claimed before settling');
  const claim = body.indexOf('room.resolving = true');
  const firstAwait = body.indexOf('await');
  assert.ok(claim !== -1 && (firstAwait === -1 || claim < firstAwait),
    'the claim must happen synchronously, BEFORE the first await');
});

test('a wagered bot match cannot be won by dying instantly', () => {
  assert.match(ENGINE, /BOT_WIN_MIN_MS/);
  const at = ENGINE.indexOf('if (room.isSolo && bot)');
  const body = ENGINE.slice(at, at + 900);
  assert.match(body, /cleared[\s\S]{0,300}?hS \+ 2/,
    'missing the bar, the bot must be pinned ahead on score AND time');
});

test('a stalled player does not freeze their opponent', () => {
  // Leaving must never beat playing: a player who is ahead must not be able to
  // background the tab and deny the other their catch-up window.
  const at = ENGINE.indexOf('const watch = setInterval');
  const body = ENGINE.slice(at, ENGINE.indexOf('fresh.botTimers.push(watch)'));
  assert.match(body, /_maybeResolve/);
  assert.match(body, /checkColorRushOvertake/);
});

test('the loser gets the same 15 seconds as every other game', () => {
  assert.match(ENGINE, /CATCHUP_MS = 15_000/);
  assert.match(ENGINE, /color_rush_catchup/);
});

// ── Both players climb the same course ──────────────────────────────────────

test('the course comes from one server-issued seed', () => {
  assert.match(ENGINE, /seed: randomInt\(1000000\)/,
    'the seed decides a staked outcome, so it must not come from Math.random');
  assert.match(ENGINE, /emit\('color_rush_start', \{ seed: fresh\.seed \}\)/);
  assert.match(PAGE,   /socket\.on\('color_rush_start'/);
  assert.match(PAGE,   /<ColorRushCanvas[\s\S]{0,120}seed=\{seed\}/);
});

test('obstacles are derived from the index, not from a random stream', () => {
  // A sequential PRNG makes the course depend on how many numbers each client
  // happened to draw, so one extra call on one side silently hands that player
  // a different climb. Hashing (seed, index) removes the ordering question.
  assert.match(CANVAS, /const rnd01 = \(seed, i, salt\)/);
  const at = CANVAS.indexOf('function obstacleAt');
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }', at));
  assert.doesNotMatch(body, /Math\.random/, 'the course must not use Math.random');
  for (const field of ['shape', 'dotted', 'dir', 'speed', 'offset']) {
    // Sliced to the end of the assignment rather than the end of the LINE —
    // these expressions wrap, and a line-bounded match silently stops checking
    // the moment one of them grows a second line, which is exactly what
    // happened when the spin ramp was added.
    const at2 = body.indexOf(`const ${field}`);
    assert.notEqual(at2, -1, `${field} is gone`);
    const expr = body.slice(at2, body.indexOf(';', at2));
    assert.match(expr, /rnd01\(seed, i,/, `${field} must be derived from (seed, index)`);
  }
});

test('each obstacle spins faster than the one below it, up to a readable limit', () => {
  // The rates are tuning values and are allowed to move; what must hold is that
  // the spin compounds, never slows, has no step where the two rates meet, and
  // does not reach the readable ceiling so early that the run is at its hardest
  // before it has begun. A flat 1.16 capped out around obstacle 11 — too soon.
  // Escaped twice: inside a template literal `\s` is just "s".
  const num = (n) => Number(CANVAS.match(new RegExp(`const ${n}\\s*=\\s*([\\d.]+)`))[1]);
  const early = num('SPIN_RAMP');
  const late  = num('SPIN_RAMP_LATE');
  const knee  = num('SPIN_RAMP_KNEE');
  const spinMax = num('SPIN_MAX');

  assert.ok(early > 1 && late > 1, 'the spin must speed up, not slow down');
  assert.ok(late <= early, 'the late rate must ease off, not steepen');
  assert.ok(early < 1.2, `an early rate of ${early} reaches the cap almost immediately`);

  const at = CANVAS.indexOf('function obstacleAt');
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }', at));
  const rampExpr = body.slice(body.indexOf('const ramp'), body.indexOf('const speed'));
  const expr = body.slice(body.indexOf('const speed'), body.indexOf(';', body.indexOf('const speed')));
  assert.match(rampExpr, /Math\.pow\(SPIN_RAMP, i\)/, 'the early stretch must compound per obstacle');
  assert.match(rampExpr, /Math\.pow\(SPIN_RAMP_LATE, i - SPIN_RAMP_KNEE\)/,
    'the late stretch must compound from the knee, not from zero');
  assert.match(expr, /Math\.min\(/, 'and it must be capped');

  // Run the curve THE SOURCE COMPUTES, not a copy of it written here.
  //
  // This was reimplemented rather than evaluated, which made it worthless for
  // the thing it is meant to catch: changing the source formula to restart the
  // late ramp from zero — a real drop at the join — left every assertion below
  // passing, because they were measuring the test's own arithmetic.
  //
  // The multiplier in front of the ramp is read from the source too; if it
  // changes, the ceiling arrives somewhere else.
  const base = Number(expr.match(/Math\.min\(([\d.]+) \* ramp/)[1]);
  const rampSrc = rampExpr.slice(rampExpr.indexOf('=') + 1).trim().replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func
  const rampFn = new Function('i', 'SPIN_RAMP', 'SPIN_RAMP_LATE', 'SPIN_RAMP_KNEE',
    `return (${rampSrc});`);
  const speed = (i) => Math.min(base * rampFn(i, early, late, knee), spinMax);

  let worst = 0, worstAt = 0;
  for (let i = 1; i <= 80; i++) {
    assert.ok(speed(i) >= speed(i - 1), `the spin drops between obstacle ${i - 1} and ${i}`);
    if (speed(i) < spinMax && speed(i) / speed(i - 1) > worst) {
      worst = speed(i) / speed(i - 1); worstAt = i;
    }
  }
  assert.ok(worst <= early + 1e-9,
    `obstacle ${worstAt} jumps x${worst.toFixed(3)}, more than the ${early} early rate — there is a step at the join`);

  // The climb must take a real run to arrive.
  const capAt = knee + Math.log(spinMax / (base * Math.pow(early, knee))) / Math.log(late);
  assert.ok(capAt >= 14, `the spin hits its ceiling by obstacle ${Math.round(capAt)} — too early to be a climb`);

  // The cap is what keeps this a game of reading the spin. A color is present
  // for a quarter turn, so the window to enter or leave is (pi/2)/omega — at
  // the cap that has to stay above what a person can actually react to.
  const window = (Math.PI / 2) / spinMax;
  assert.ok(window >= 0.3,
    `at the cap a color is only present for ${window.toFixed(2)}s — too fast to act on`);

  // And the jitter has to be inside the clamp, or a single obstacle can beat
  // the cap on its own.
  assert.ok(expr.indexOf('rnd01') < expr.lastIndexOf('SPIN_MAX'),
    'the jitter must be applied before the clamp, not after it');
});

test('nothing about the course depends on the device', () => {
  // The visible slice of the course is fixed in world units, so a tablet gets
  // no more warning about an approaching obstacle than a phone does.
  assert.match(CANVAS, /const VIEW_H\s*=\s*\d+/);
  assert.match(CANVAS, /scale = H \/ VIEW_H/,
    'the scale must come from the height against a fixed world view');
});

test('physics run on a fixed step, so a slow frame cannot phase through a wall', () => {
  assert.match(CANVAS, /const FIXED_DT/);
  assert.match(CANVAS, /while \(acc >= FIXED_DT\) \{ step\(FIXED_DT\)/);
  assert.match(CANVAS, /if \(frame > MAX_FRAME\) frame = MAX_FRAME/,
    'a backgrounded tab must not teleport the ball on return');
});

test('the ball travels less per step than the collision band is wide', () => {
  // The actual guarantee behind the fixed step, checked against the real
  // numbers rather than trusting the comment.
  const num = (re) => Number(CANVAS.match(re)[1]);
  const fallMax = Math.abs(num(/const FALL_MAX = (-?\d+)/));
  const ballR   = num(/const BALL_R\s*=\s*(\d+)/);
  const thick   = num(/const THICK\s*=\s*(\d+)/);
  const dt      = 1 / num(/const FIXED_DT = 1 \/ (\d+)/);
  const perStep = fallMax * dt;
  const band    = ballR + thick / 2;
  assert.ok(perStep < band,
    `at top speed the ball moves ${perStep.toFixed(1)}u per step into a ${band}u band — it can tunnel through`);
});

// ── The rules the player is actually playing by ─────────────────────────────

test('a band only kills on a colour mismatch', () => {
  const at = CANVAS.indexOf('function hitTest');
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }\n', at));
  assert.match(body, /colorAtAngle\([^)]*\) !== S\.color\) return true;/);
});

test('colour is decided by angle, never by distance round the outline', () => {
  // This is what makes a nested obstacle possible at all. A square's bottom
  // edge is a different fraction of its perimeter than a circle's bottom is of
  // its circumference, so colouring by arc length made the two loops of a
  // "square with a circle inside" present DIFFERENT colours at the entry — and
  // the ball only has one colour, so those obstacles could not be entered.
  assert.match(CANVAS, /function colorAtAngle\(a, offset, mirror\)/);
  assert.doesNotMatch(CANVAS, /colorAtArc/, 'the arc-length colouring must be gone');
  assert.doesNotMatch(CANVAS, /cum\b/,      'and its arc-length tables with it');
});

test('the colour that kills you is the one on the lane', () => {
  // Not the colour of whichever bit of outline is merely nearest. On a polygon
  // a corner can swing sideways and be the closest point while the ball is
  // still crossing the lane, and that corner may be a different quarter —
  // which lets the outer and inner loops disagree again.
  const at = CANVAS.indexOf('function hitTest');
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }\n', at));
  assert.match(body, /laneBearing/, 'the colour must be read at the lane bearing');
  assert.match(body, /\(dy >= 0 \? Math\.PI \/ 2 : -Math\.PI \/ 2\) - a/);
  assert.doesNotMatch(body, /colorAtAngle\(near\.a/,
    'judging by the nearest point is what let nested loops disagree');
});

test('the way OUT has to be matched too', () => {
  // The first version cleared a band once you had matched it, so you could
  // leave through any color. That made the middle of an obstacle a corridor.
  // Now every contact is checked, which is only fair because the shapes are
  // sized to let you hold station inside and wait for your color to come
  // round to the top.
  const at = CANVAS.indexOf('function hitTest');
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }\n', at));
  assert.doesNotMatch(body, /cleared/, 'no band may be exempted from the check');
  assert.match(body, /colorAtAngle\([^)]*\) !== S\.color\) return true;/);
});

test('a nested ring counter-rotates, and still lines up on the lane', () => {
  // Both halves of one request: the inner ring must visibly spin the other way,
  // AND it must still be enterable. Mirroring the colour lookup about the
  // vertical axis is what buys both — the pattern travels the opposite way
  // round while still agreeing with the outer ring where the ball crosses.
  assert.match(CANVAS, /const inner = \(pts\) => \(\{ pts, spin: -1, mirror: true \}\)/);
  assert.match(CANVAS, /const outer = \(pts\) => \(\{ pts, spin: 1, mirror: false \}\)/);
  assert.match(CANVAS, /th \* loop\.spin/, 'each loop must be drawn at its own signed angle');

  // Every nested family must actually use inner() for its second loop.
  for (const name of ['doubleCircle', 'squareCircle', 'triangleCircle']) {
    const at = CANVAS.indexOf(`name: '${name}'`);
    const line = CANVAS.slice(at, CANVAS.indexOf('\n', at));
    assert.match(line, /inner\(/, `${name}'s inner loop must counter-rotate`);
  }
});

test('the mirror makes outer and inner agree at both lane crossings', () => {
  // The property proven by hand, so it cannot quietly stop being true.
  // colorAtAngle(a, off, mirror) = floor(norm(mirror ? 3π-a : a) / (π/2)) + off
  const norm = (a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const colorAtAngle = (a, off, mirror) =>
    (Math.floor(norm(mirror ? 3 * Math.PI - a : a) / (Math.PI / 2)) + off) & 3;

  for (let off = 0; off < 4; off++) {
    for (let k = 0; k < 720; k++) {
      const th = (k / 720) * Math.PI * 2;
      for (const dy of [-1, 1]) {
        const bearing = dy >= 0 ? Math.PI / 2 : -Math.PI / 2;
        const o = colorAtAngle(bearing - th * 1, off, false);   // outer: spin +1
        const i = colorAtAngle(bearing - th * -1, off, true);   // inner: spin -1, mirrored
        assert.equal(i, o, `outer ${o} vs inner ${i} at offset ${off}, angle ${k}, dy ${dy}`);
      }
    }
  }
});

test('there is room between obstacles to hold station', () => {
  // Holding position costs a full tap arc of bob. If the clear space between
  // one obstacle and the next is smaller than that arc, there is nowhere to
  // wait for your colour and the game stops being about timing.
  const num = (re) => Number(CANVAS.match(re)[1]);
  const gap    = num(/const OBSTACLE_GAP = (\d+)/);
  const jump   = num(/const JUMP_V\s*=\s*(\d+)/);
  const grav   = Math.abs(num(/const GRAV\s*=\s*(-?\d+)/));
  const reach  = num(/const SHAPE_REACH = (\d+)/);
  const arc    = (jump * jump) / (2 * grav);        // how far one tap lifts you
  const clear  = gap - 2 * reach;
  assert.ok(clear > arc * 2,
    `only ${clear.toFixed(0)}u of clear space between obstacles against a ${arc.toFixed(0)}u tap arc`);
});

test('the colour switcher sits midway between two obstacles', () => {
  // It used to sit just past the obstacle it belonged to, which put it under
  // 40 units below the next entry band: your colour changed and the ring
  // arrived before you could act on it.
  assert.match(CANVAS, /const SWITCHER_OFFSET = OBSTACLE_GAP \/ 2;/,
    'the switcher must be at the midpoint, not an arbitrary offset');
  assert.match(CANVAS, /switcherY: FIRST_Y \+ i \* OBSTACLE_GAP \+ SWITCHER_OFFSET/);
});

test('the obstacles are big enough to hold station inside', () => {
  // The innermost loop of a nested shape has to leave more than one tap arc of
  // clear air, or a player who ends up inside cannot stop and is funnelled
  // straight out through whatever colour happens to be there.
  const num = (re) => Number(CANVAS.match(re)[1]);
  const jump  = num(/const JUMP_V\s*=\s*(\d+)/);
  const grav  = Math.abs(num(/const GRAV\s*=\s*(-?\d+)/));
  const ballR = num(/const BALL_R\s*=\s*(\d+)/);
  const thick = num(/const THICK\s*=\s*(\d+)/);
  const arc   = (jump * jump) / (2 * grav);
  const reach = ballR + thick / 2;
  // Every circleLoop radius used as an inner loop.
  const inners = [...CANVAS.matchAll(/inner\(circleLoop\((\d+)\)\)/g)].map(m => Number(m[1]));
  assert.ok(inners.length >= 3, `expected the nested shapes, found ${inners.length}`);
  for (const r of inners) {
    const window = 2 * (r - reach);
    assert.ok(window > arc,
      `an inner ring of ${r} leaves ${window}u to hover in against a ${arc}u tap arc`);
  }
});

test('the palette is four colors that stay apart on black', () => {
  // Black was one of them, on a black background, which needed a light rim to
  // be visible at all — and that rim was drawn wider than the band, so it
  // showed past its neighbours. Four bright colors remove both problems.
  for (const key of ['white', 'blue', 'green', 'red']) {
    assert.match(CANVAS, new RegExp(`key: '${key}'`), `missing color: ${key}`);
  }
  assert.doesNotMatch(CANVAS, /key: 'black'/, 'black on black is gone');
  assert.doesNotMatch(CANVAS, /rim/, 'and the rim it needed with it');
  const n = (CANVAS.match(/\{ key: '/g) || []).length;
  assert.equal(n, 4, `expected exactly four colors, found ${n}`);
});

test('a dotted obstacle is exactly as solid as a plain one', () => {
  // Dotted is a look. If the gaps were real, a player would die on something
  // that looked like empty space.
  const at = CANVAS.indexOf('function drawLoop');
  const body = CANVAS.slice(at, CANVAS.indexOf('function drawDiamond'));
  assert.match(body, /if \(dotted\)/, 'dotted must be a drawing branch');
  const hit = CANVAS.slice(CANVAS.indexOf('function hitTest'), CANVAS.indexOf('function pickups'));
  assert.doesNotMatch(hit, /dotted/, 'collision must not know about dotted at all');
});

test('bands are drawn by clipping one continuous outline, not by cutting it', () => {
  // Cutting the outline into four paths gives every cut its own end cap, so at
  // a corner the two bands meet at an angle and leave a notch or sit on top of
  // each other — the sloppy joins in the bug report. Stroking the whole
  // outline four times, each clipped to a quarter, keeps the corners mitred
  // and cuts along an exact radius instead.
  const at = CANVAS.indexOf('function drawLoop');
  const body = CANVAS.slice(at, CANVAS.indexOf('function drawDiamond'));
  assert.match(body, /ctx\.clip\(\)/, 'each band must be a clipped wedge');
  assert.match(body, /ctx\.lineJoin = 'miter'/, 'corners must be mitred');
  assert.doesNotMatch(body, /bisectBoundary/, 'the outline must not be cut up any more');
  assert.match(body, /ctx\.closePath\(\);\s*\n\s*ctx\.strokeStyle/,
    'the stroked path must be the whole closed outline');
});

test('the run sits in the page like every other game', () => {
  // It was briefly fixed and full-bleed to cover the site header, which also
  // covered the sidebar and the chat. Every other game renders its canvas
  // inside the normal page, and this one has to match or it is the odd one
  // out on every screen.
  const at = PAGE.indexOf("if (phase === 'playing')");
  assert.notEqual(at, -1, 'the playing branch is gone');
  const branch = PAGE.slice(at, at + 400);
  assert.doesNotMatch(branch, /fixed inset-0/,
    'a full-bleed run hides the header, sidebar and chat');
  assert.match(branch, /className="relative"/, 'same wrapper as the other games');
  // And the canvas has to leave room for the header rather than sitting under it.
  assert.match(CANVAS, /height: 'calc\(100dvh - 56px\)'/);
  assert.match(CANVAS, /maxWidth: 'calc\(\(100dvh - 56px\) \* 0\.62\)'/);
});

test('the death burst is the ball colour, and on screen', () => {
  const at = CANVAS.indexOf('function drawBits');
  const body = CANVAS.slice(at, CANVAS.indexOf('function render', at));
  assert.match(body, /const col = COLORS\[S\.color\];/, 'the burst takes the ball colour');
  assert.match(body, /fillStyle = col\.fill/);
  assert.match(body, /strokeStyle = col\.fill/, 'the ring too');
  assert.doesNotMatch(body, /#FFFFFF|'white'/, 'nothing in the burst may be hard-coded white');

  // Small pieces under a heavy glow read as white however saturated the fill
  // is, which is what this looked like on a phone.
  const blur = Number(body.match(/shadowBlur = (\d+)/)[1]);
  assert.ok(blur <= 6, `a ${blur}px glow on a small piece washes the colour out`);

  // Falling out of the bottom is one of the two ways to die, and the ball is
  // then BELOW the frame — drawing the burst at its real position put the
  // whole animation off screen.
  assert.match(body, /sy\(S\.burstY\)/, 'the burst must draw from the clamped origin');
  const die = CANVAS.slice(CANVAS.indexOf('function die'), CANVAS.indexOf('function stepBits'));
  assert.match(die, /S\.burstY = Math\.max\(S\.y, S\.camBottom \+ VIEW_H \* [\d.]+\)/,
    'the origin must be clamped into view');
});

test('the start screen runs out instead of waiting forever', () => {
  assert.match(CANVAS, /const START_GRACE = 10;/);
  const at = CANVAS.indexOf('function step');
  const body = CANVAS.slice(at, CANVAS.indexOf('function die'));
  assert.match(body, /S\.waitT \+= dt;[\s\S]{0,120}?if \(S\.waitT >= START_GRACE\) S\.started = true;/,
    'the grace period must expire and let the ball go');
});

test('the HUD shows the score, top-right, and nothing else', () => {
  const at = CANVAS.indexOf('function drawHUD');
  assert.notEqual(at, -1, 'drawHUD is gone');
  // Bounded by the function's own closing brace. Anchoring on a comment does
  // not work here: CANVAS has its comments stripped, so a missing marker makes
  // indexOf return -1 and the slice swallows the rest of the file.
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }', at));
  const drawn = body.indexOf('String(S.score)');
  assert.notEqual(drawn, -1, 'the score must be drawn');
  // Checked on the alignment in force WHEN THE SCORE IS DRAWN, not anywhere in
  // the function: drawHUD resets alignment on its way out, so a looser match
  // is satisfied by that reset and stops checking placement at all.
  assert.match(body.slice(0, drawn), /textAlign = 'right'/, 'the score is right-aligned');
  assert.match(body, /fillText\(String\(S\.score\), W - \d+/, 'and anchored to the right edge');
  // The clock is gone: the match is decided on diamonds, so a running timer
  // was reporting a number that does not count for anything.
  assert.doesNotMatch(body, /simT/, 'no clock on the HUD');
  // And the catch-up banner sits in the centre, out of the corner the score owns.
  assert.match(PAGE, /absolute left-1\/2 -translate-x-1\/2 top-3/,
    'the catch-up banner belongs in the top centre');
});

test('time is not a tracked stat anywhere', () => {
  // Elapsed time is still measured server-side — the anti-cheat clamp, the
  // catch-up window and an exact-tie break all need it — but the player is
  // playing for diamonds and nothing else is recorded or shown.
  assert.doesNotMatch(ENGINE, /colorRushMs/, 'no companion time stat');
  assert.match(ENGINE, /updateHighscore\(supabase, [^,]+, 'colorRush', \w+\)/,
    'score only, not a score/time pair');
  assert.doesNotMatch(be('routes', 'leaderboard.js'), /colorRush: 'colorRushMs'/);
  assert.doesNotMatch(fe('pages', 'Profile.jsx'), /colorRush[^\n]*timeKey/);
  assert.doesNotMatch(fe('pages', 'Leaderboard.jsx'), /id: 'colorRush'[^\n]*showTime/);
  // And no time on either result card.
  assert.doesNotMatch(PAGE, /fmtTime/, 'the result card must not show a time');
});

test('a dropped connection ends the run, not the match', () => {
  // Switching apps on a phone suspends the page and takes the socket with it.
  // Treating that as a forfeit makes a staked match hinge on a phone call.
  // Both players climb their own copy of the same course at the same time, so
  // nobody is waiting on a turn and there is no reason it has to cost the
  // stake — the player keeps the score the server had already verified.
  assert.match(ENGINE, /function endRunOnDisconnect\(io, supabase, roomId, socketId\)/);
  const at = ENGINE.indexOf('function endRunOnDisconnect');
  const body = ENGINE.slice(at, ENGINE.indexOf('\n}', at));
  assert.match(body, /room\.times\[socketId\] = verified/, 'the run ends at verified progress');
  assert.match(body, /if \(room\.isSolo\) return false;/,
    'a bot room has no second human to carry on — leave that to the forfeit');
  assert.match(body, /_armCatchup/, 'the survivor still gets their catch-up window');
  // And the disconnect path must actually prefer it over the generic forfeit.
  assert.match(HANDLERS, /gameType === 'colorRush'\s*\n?\s*&& endRunOnDisconnect\([^)]*\)\) return;/);
});

test('a finalised player cannot keep scoring', () => {
  // Once a run has ended — by death, a stall or a dropped connection — late
  // pings must not revive it or move the score it finished on.
  const at = ENGINE.indexOf('function trackColorRushProgress');
  const body = ENGINE.slice(at, ENGINE.indexOf('\n}', at));
  assert.match(body, /if \(room\.times\[socketId\] != null\) return null;/);
});

test('leaving in any way still forfeits', () => {
  // Three separate paths, and a game missing from any one of them leaves a
  // match that never settles.
  for (const h of ['player_forfeit', 'leave_game', 'disconnect']) {
    const at = HANDLERS.indexOf(`socket.on('${h}'`);
    assert.notEqual(at, -1, `${h} handler is gone`);
    assert.ok(HANDLERS.slice(at, at + 9000).includes('getColorRushRoomBySocket'),
      `${h} does not know about Color Rush`);
  }
  assert.match(PAGE, /useLeaveGuard\(socket\)/, 'the page must forfeit on the way out');
});

test('nothing user-facing spells it "colour"', () => {
  // The site says color everywhere else.
  for (const [name, src] of [['canvas', CANVAS], ['page', PAGE], ['help', fe('components', 'GameHelp.jsx')]]) {
    const strings = [...src.matchAll(/'([^'\n]{4,})'|"([^"\n]{4,})"/g)].map(m => m[1] || m[2]);
    const bad = strings.filter(s => /colour/i.test(s));
    assert.deepEqual(bad, [], `${name} has British spelling in user-facing text: ${bad.join(' | ')}`);
  }
});

test('the six requested obstacle families all exist', () => {
  for (const name of ['circle', 'square', 'triangle', 'doubleCircle', 'squareCircle', 'triangleCircle']) {
    assert.match(CANVAS, new RegExp(`name: '${name}'`), `missing obstacle: ${name}`);
  }
});

test('a colour switcher always changes the colour', () => {
  // One that can hand back the colour you already hold reads as a bug.
  const at = CANVAS.indexOf('function pickups');
  const body = CANVAS.slice(at, CANVAS.indexOf('\n    }\n', at));
  assert.match(body, /filter\(c => c !== S\.color\)/);
});

// ── The page is the same page as every other game ───────────────────────────

test('the lobby, result and forfeit screens are the shared components', () => {
  for (const c of ['GameLobby', 'ResultScreen', 'GameHelp', 'PrivateWaiting', 'ChallengeLinkBox']) {
    assert.match(PAGE, new RegExp(`import ${c} from`), `${c} must be the shared component`);
  }
  assert.match(PAGE, /useLeaveGuard\(socket\)/, 'leaving must forfeit like every other game');
  assert.match(PAGE, /useResumeMatch\(socket/);
});

test('it offers the same modes as the other games', () => {
  assert.match(PAGE, /onQueue=\{joinQueue\}/);
  assert.match(PAGE, /onBot=\{playVsBot\}/);
  assert.match(PAGE, /onBotFree=\{playVsBotFree\}/);
  assert.match(PAGE, /onCreatePrivate=\{createPrivate\}/);
  assert.match(PAGE, /onJoinPrivate=\{joinPrivate\}/);
});

test('the private rematch is wired, on every result card', () => {
  assert.match(PAGE, /usePrivateRematch\(socket, 'color_rush_match_found'\)/);
  const cards = (PAGE.match(/onPlayAgain=\{/g) || []).length;
  const wired = (PAGE.match(/onPrivateRematch=\{/g) || []).length;
  assert.equal(wired, cards, `${cards} result cards but only ${wired} wired for rematch`);
});

test('no Rush Hour wording survived the copy', () => {
  // This page started as a copy of Rush Hour's, and stale copy is how a game
  // ends up telling players to change lanes.
  for (const word of ['Rush Hour', 'car_dash', 'carDash', 'HighwayCanvas', 'traffic', 'lanes']) {
    assert.ok(!PAGE.includes(word), `Rush Hour leftover in the Color Rush page: ${word}`);
  }
});

// ── Dotted outlines ─────────────────────────────────────────────────────────

test('dots are spaced by distance, so every shape has the same density', () => {
  // They used to be spread by VERTEX INDEX — 64 of them as a fraction of
  // pts.length — so spacing was an accident of how each shape was built. A
  // circle is 120 points and a triangle is 3: the same 64 dots landed 11.6
  // units apart on an inner circle, where they are 21 wide, so they overlapped
  // by half. That is the clumping on the edges.
  const raw = fe('components', 'ColorRushCanvas.jsx');
  assert.match(raw, /function dotPositions\(loop\)/, 'the dotting is not computed from geometry');
  assert.match(raw, /const DOT_GAP = THICK \* 1\.3;/, 'no distance-based spacing');
  assert.doesNotMatch(raw, /const N = 64;/, 'the fixed dot count is back');
  assert.doesNotMatch(raw, /\(k \/ N\) \* pts\.length/, 'still walking by vertex index');
});

test('a dot lands exactly on every corner, at even spacing, on every shape', () => {
  // Run the real geometry rather than assert on its source. 64 does not divide
  // by 3, so no dot ever landed ON a triangle's corner — two straddled it and
  // left the corner looking broken open.
  const raw = fe('components', 'ColorRushCanvas.jsx');
  const cut = (from, to) => raw.slice(raw.indexOf(from), raw.indexOf(to, raw.indexOf(from)));
  const geom = new Function(
    'const TAU=Math.PI*2, THICK=21;'
    + cut('function circleLoop', 'function polyLoop')
    + cut('function polyLoop', 'const DOT_GAP')
    + cut('const DOT_GAP', 'const inner =')
    + '; return { dotPositions, circleLoop, polyLoop };')();

  const THICK = 21;
  const shapes = {
    'inner circle': [geom.circleLoop(118), false],
    'outer circle': [geom.circleLoop(275), false],
    triangle:       [geom.polyLoop(3, 275), true],
    triangleCircle: [geom.polyLoop(3, 285), true],
    square:         [geom.polyLoop(4, 235, 0), true],
  };

  for (const [name, [pts, isPoly]] of Object.entries(shapes)) {
    const dots = geom.dotPositions({ pts });
    let min = Infinity, max = 0;
    for (let i = 0; i < dots.length; i++) {
      const a = dots[i], b = dots[(i + 1) % dots.length];
      const g = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (g > 1) { min = Math.min(min, g); max = Math.max(max, g); }
    }
    // No overlap: centres must be at least a dot's width apart.
    assert.ok(min >= THICK, `${name}: dots overlap — closest pair is ${min.toFixed(1)} apart, they are ${THICK} wide`);
    // Even: the whole outline reads as one rhythm rather than bunching.
    assert.ok(max - min < 2, `${name}: spacing runs ${min.toFixed(1)}-${max.toFixed(1)}, which reads as clumped`);
    // Consistent across shapes, which is what the index walk never was.
    assert.ok(min > 25 && max < 31, `${name}: density ${min.toFixed(1)}-${max.toFixed(1)} is off the others`);
    if (isPoly) {
      for (const c of pts) {
        assert.ok(dots.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < 0.001),
          `${name}: no dot sits on the corner at ${c.map(v => v.toFixed(0))} — it will look broken open`);
      }
    }
  }
});

test('dotted is still only a look, never a real gap', () => {
  // Collision does not consult the dots. If it ever did, a player would die on
  // something that looked like empty space between two beads.
  const raw = fe('components', 'ColorRushCanvas.jsx');
  const hit = raw.slice(raw.indexOf('const laneBearing'), raw.indexOf('const laneBearing') + 400);
  assert.doesNotMatch(hit, /dotted|dotPositions/, 'collision is reading the dotting');
});

test('no obstacle grows wider than a phone screen', () => {
  // The canvas scales on HEIGHT (scale = H / VIEW_H), so the width a shape may
  // use is set by the aspect ratio: half-width <= 600 * (W/H) world units. On
  // the narrowest phones in circulation — a 21:9 handset — that is about 276.
  //
  // Measured to the outside of the STROKE, including the mitre that overhangs
  // each corner: 15 units on a square's 90 degrees, 21 on a triangle's 60. A
  // radius that looks safe is not, which is the trap this test exists for.
  const num = (re) => Number(CANVAS.match(re)[1]);
  const thick = num(/const THICK\s*=\s*(\d+)/);
  const hw = thick / 2;
  const NARROWEST = 600 * (360 / 784);        // a 21:9 phone, navbar removed

  const block = CANVAS.slice(CANVAS.indexOf('const SHAPES = ['),
                             CANVAS.indexOf('];', CANVAS.indexOf('const SHAPES = [')));
  const shapes = [...block.matchAll(/name: '(\w+)',\s+loops: \[(.*)\] \}/g)];
  assert.equal(shapes.length, 6, `expected the six families, found ${shapes.length}`);

  const polyHalf = (R, n, rot) => {
    const miter = hw / Math.sin((Math.PI * (n - 2) / n) / 2);
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(Math.cos(rot + (i / n) * 2 * Math.PI) * (R + miter)));
    return m;
  };

  const tooWide = [];
  for (const [, name, loops] of shapes) {
    for (const l of loops.matchAll(/(outer|inner)\((circleLoop|polyLoop)\(([^)]*)\)\)/g)) {
      const a = l[3].split(',').map((v) => Number(v.trim()));
      const half = l[2] === 'circleLoop'
        ? a[0] + hw
        : polyHalf(a[1], a[0], a.length > 2 ? a[2] : Math.PI / 2);
      if (half > NARROWEST) tooWide.push(`${name} ${l[1]}: ${half.toFixed(0)}u > ${NARROWEST.toFixed(0)}u`);
    }
  }
  assert.deepEqual(tooWide, [], `these run off the side of a phone: ${tooWide.join(', ')}`);
});

test('a nested pair is scaled together, so the lane between them survives', () => {
  // Growing an outer ring on its own closes the gap its inner ring sits in.
  // The lane has to stay wide enough to hold station in.
  const num = (re) => Number(CANVAS.match(re)[1]);
  const thick = num(/const THICK\s*=\s*(\d+)/);
  const ballR = num(/const BALL_R\s*=\s*(\d+)/);
  const block = CANVAS.slice(CANVAS.indexOf('const SHAPES = ['),
                             CANVAS.indexOf('];', CANVAS.indexOf('const SHAPES = [')));
  const nested = [...block.matchAll(/name: '(\w+)',\s+loops: \[outer\((?:circleLoop|polyLoop)\(([^)]*)\)\), inner\(circleLoop\((\d+)\)\)\]/g)];
  assert.equal(nested.length, 3, `expected three nested families, found ${nested.length}`);
  for (const [, name, outerArgs, innerR] of nested) {
    const a = outerArgs.split(',').map((v) => Number(v.trim()));
    const outerR = a.length > 1 ? a[1] : a[0];
    const lane = (outerR - thick / 2) - (Number(innerR) + thick / 2);
    assert.ok(lane >= 2 * ballR + 20,
      `${name}: only ${lane}u of lane between its rings, and the ball is ${2 * ballR}u across`);
  }
});
