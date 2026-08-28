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

test('the same icon is used everywhere the game is listed', () => {
  // The icon is hand-copied into a dozen lists. Changing it means changing all
  // of them, and the one that gets missed shows a different game's face in the
  // sidebar or the invite toast.
  // Each site says exactly where ITS icon lives. A heuristic search finds the
  // NEIGHBOURING game's icon instead — these lists run one line per game.
  const sites = [
    ['games list',  fe('data', 'games.js'),                /slug:\s*'color-rush',[\s\S]{0,80}?icon:\s*'(.+?)'/],
    ['navbar',      fe('components', 'Navbar.jsx'),        /\{ icon: '(.+?)', label: 'Color Rush'/],
    ['sidebar',     fe('components', 'LeftSidebar.jsx'),   /\{ icon: '(.+?)', label: 'Color Rush'/],
    ['quick match', fe('pages', 'QuickMatch.jsx'),         /name: 'Color Rush',\s*icon: '(.+?)'/],
    ['help panel',  fe('components', 'GameHelp.jsx'),      /colorRush: \{[\s\S]{0,40}?title: '(.+?) Color Rush'/],
    ['join modal',  fe('components', 'JoinRoomModal.jsx'), /colorRush:\s*'(.+?) Color Rush'/],
    ['challenge',   fe('pages', 'ChallengeJoin.jsx'),      /colorRush:\s*'(.+?) Color Rush'/],
    ['leaderboard', fe('pages', 'Leaderboard.jsx'),        /id: 'colorRush'[\s\S]{0,90}?icon: '(.+?)'/],
    ['profile',     fe('pages', 'Profile.jsx'),            /colorRush:\s*\{ emoji: '(.+?)'/],
    ['ticker',      be('services', 'tickerService.js'),    /colorRush:\s*\{ icon: '(.+?)'/],
    ['lobby title', fe('pages', 'ColorRushGame.jsx'),      /title="(.+?) Color Rush"/],
  ];
  const icons = new Set();
  const missing = [];
  for (const [name, src, re] of sites) {
    const m = src.match(re);
    if (!m) { missing.push(name); continue; }
    icons.add(m[1]);
  }
  assert.deepEqual(missing, [], `no icon found for: ${missing.join(', ')}`);
  assert.equal(icons.size, 1, `the icon has drifted — found ${[...icons].join(' ')}`);
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
  assert.match(HANDLERS, /case 'colorRush':\s*\{[\s\S]{0,400}?createDirectColorRushRoom/);
  assert.match(HANDLERS, /case 'colorRush':[\s\S]{0,600}?startColorRushCountdown/);
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
    assert.match(body, new RegExp(`${field}\\s*=[^\\n]*rnd01\\(seed, i,`),
      `${field} must be derived from (seed, index)`);
  }
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
