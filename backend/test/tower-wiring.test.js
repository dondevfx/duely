// Adding a game to this codebase means touching nineteen files, and the failure
// mode when one is missed is not a crash — it is a game that quietly cannot be
// forfeited, or never appears in Quick Match, or has no leaderboard.
//
// So the integration surface is asserted rather than remembered. Each check
// names a real consequence, because "tower is missing from a list" is not
// actionable on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = (p) => fs.readFileSync(p, 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const be = (...p) => strip(path.join(__dirname, '..', 'src', ...p));
const fe = (...p) => strip(path.join(__dirname, '..', '..', 'frontend', 'src', ...p));

const handlers = be('socket', 'handlers.js');
const engine   = be('services', 'towerEngine.js');

// Conditions of every `if` block enclosing `idx`, innermost first.
//
// Text-scanning backwards to the nearest "if (" does NOT work here: the rating
// update sits in its own `if (!isFree)` immediately above the win counter, so a
// naive scan reports the counter as fee-gated when it is not. Brace matching
// sees the real block structure.
function enclosingIfs(src, idx) {
  const conds = [];
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') { depth++; continue; }
    if (ch !== '{') continue;
    if (depth > 0) { depth--; continue; }
    const head = src.slice(0, i).trimEnd();
    if (!head.endsWith(')')) continue;
    let p = head.length - 1, d = 0;
    for (; p >= 0; p--) {
      if (head[p] === ')') d++;
      else if (head[p] === '(') { if (--d === 0) break; }
    }
    if (p < 0) continue;
    if (/(^|[^\w$])if\s*$/.test(head.slice(0, p))) conds.push(head.slice(p + 1, -1).trim());
  }
  return conds;
}


// ── Engine ──────────────────────────────────────────────────────────────────

test('the queue pairs on rating like every other game', () => {
  assert.match(engine, /closestByElo\(towerQueue/);
});

test('a stale finished room cannot shadow a live one', () => {
  assert.match(engine, /findRoomBySocket\(towerRooms/);
});

test('the result says whether the opponent was a bot', () => {
  // Without it the card claims a bot loss reset a streak that never moved.
  assert.match(engine, /vsBot: true/);
  assert.match(engine, /vsBot: !!\(winner\.isBot \|\| loser\.isBot\)/);
});

test('an unrated outcome reports null rather than an unchanged rating', () => {
  assert.match(engine, /newWinnerElo: null, newLoserElo: null/);
});

test('a free match counts toward the record but not the rating', () => {
  const body = engine.slice(engine.indexOf('Promise.resolve().then'));
  const elo = body.indexOf('applyEloUpdate');
  assert.ok(elo > 0, 'no rating update found');
  assert.ok(enclosingIfs(body, elo).some(c => /!isFree/.test(c)),
    'the rating must be gated on the stake');

  const win = body.indexOf("increment_win'");
  assert.ok(win > 0, 'no win counter found');
  assert.deepEqual(enclosingIfs(body, win).filter(c => /isFree/.test(c)), [],
    'a free match must still count as a win');
});

test('a free solo run cannot be lost and is not rated', () => {
  assert.match(engine, /const freeSolo\s+= !\(room\.entryFee > 0\)/);
  assert.match(engine, /const humanWon = alwaysWin \? true :/);
  assert.match(engine, /if \(supabase && !freeSolo\)/);
  // The personal best is the point of the mode, so it records regardless.
  const hs = engine.indexOf("updateHighscore(supabase, player.userId");
  assert.ok(hs > 0, 'no solo highscore update found');
  assert.deepEqual(enclosingIfs(engine, hs).filter(c => /freeSolo/.test(c)), [],
    'a personal best is the point of the mode — it must record either way');
});

test('the score is server-tracked, not taken from the client', () => {
  assert.match(engine, /const verified = room\.pingScores\[socketId\] \?\? 0/);
  assert.match(engine, /scoreBuckets/, 'the rate clamp must be in place');
});

test('a metronomic run is logged, not punished', () => {
  // A heuristic that seized a payout would be worse than the cheating.
  assert.match(engine, /SUSPICIOUS RUN/);
  const fn = engine.slice(engine.indexOf('function _checkRobotic'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.doesNotMatch(body, /settle|deduct|ban|forfeit/i,
    'the robotic check must not take any action on its own');
});

// ── Socket wiring ───────────────────────────────────────────────────────────

test('leaving mid-match forfeits — all three room lists know about tower', () => {
  // Miss one of these and a player can close the tab on a losing run for free.
  const n = (handlers.match(/\[getTowerRoomBySocket,\s+deleteTowerRoom,\s+'tower'\]/g) || []).length;
  assert.equal(n, 3, `tower is in ${n} of the 3 room-lookup lists`);
});

test('a friend can be invited to a tower match', () => {
  assert.match(handlers, /'blockBlast', 'carDash', 'tower'/, 'invite allowlist');
  assert.match(handlers, /case 'tower': \{/, 'direct-room switch');
});

test('the socket events exist', () => {
  for (const ev of ['join_tower_queue', 'leave_tower_queue', 'play_tower_vs_bot',
                    'tower_complete', 'tower_score_ping', 'tower_rematch_request']) {
    assert.match(handlers, new RegExp(`socket\\.on\\('${ev}'`), `missing ${ev}`);
  }
});

test('drop timings are advisory and bounded', () => {
  // They feed the robotic check only, and an unbounded array from a client is a
  // memory hazard.
  assert.match(handlers, /taps\.slice\(0, 4000\)/);
});

// ── Frontend surface ────────────────────────────────────────────────────────

test('the page exists and is routed', () => {
  assert.match(fe('App.jsx'), /path="\/game\/tower"/);
});

test('the game is reachable from every place a game is listed', () => {
  const places = {
    'pages/Home.jsx':             /route: '\/game\/tower'/,
    'pages/Games.jsx':            /route: '\/game\/tower'/,
    'components/LeftSidebar.jsx': /'\/game\/tower'/,
    'components/Navbar.jsx':      /to: '\/game\/tower'/,
    'pages/QuickMatch.jsx':       /queueKey: 'tower'/,
  };
  for (const [file, re] of Object.entries(places)) {
    assert.match(fe(...file.split('/')), re, `${file} does not list Tower`);
  }
});

test('challenge links and invites resolve tower to a route and a name', () => {
  for (const f of ['components/InviteToasts.jsx', 'pages/ChallengeJoin.jsx']) {
    const src = fe(...f.split('/'));
    assert.match(src, /tower:\s+'\/game\/tower'/, `${f} has no route for tower`);
  }
  assert.match(fe('components', 'ChallengeLinkBox.jsx'), /tower: 'Tower'/);
});

test('scores show up in the leaderboard, ticker and profile', () => {
  assert.match(be('routes', 'leaderboard.js'), /'carDash', 'tower'/,
    'tower must be a scored game or its leaderboard is always empty');
  assert.match(be('services', 'tickerService.js'), /tower:\s+\{ icon/);
  assert.match(fe('pages', 'Profile.jsx'), /tower:\s+\{ emoji/);
  assert.match(fe('pages', 'Leaderboard.jsx'), /id: 'tower'/);
});

test('Tower does not reuse another game\'s emoji', () => {
  // Both would light up together in the Quick Match reel.
  const pool = fe('pages', 'QuickMatch.jsx');
  const icons = [...pool.matchAll(/icon: '([^']+)'/g)].map(m => m[1]);
  assert.equal(new Set(icons).size, icons.length, `duplicate icon in the pool: ${icons}`);
});

test('the page pins the screen while playing', () => {
  // A tap that scrolled instead of dropping would cost a real match.
  assert.match(fe('pages', 'TowerGame.jsx'), /useGameScrollLock\(phase === 'countdown' \|\| phase === 'active'\)/);
});

test('the page forfeits on leaving, like the others', () => {
  const src = fe('pages', 'TowerGame.jsx');
  assert.match(src, /player_forfeit/);
  assert.match(src, /useResumeMatch/);
});

// ── Bot matches report the rating they actually applied ──────────────────────
//
// A paid bot match — coins or diamonds — really does move the rating, but the
// solo payload carried no number, so the result card had nothing to print and
// hid the ELO row entirely. That reads as "bot matches are unrated", which is
// not true, and it is the one item on this list that is not Tower-specific.

for (const [file, engineName] of [['towerEngine.js', 'Tower'], ['blockBlastEngine.js', 'Block Burst']]) {
  test(`${engineName} sends the new rating with a bot result`, () => {
    const src = be('services', file);
    assert.match(src, /newElo:\s+humanNewElo/, `${file} does not report the rating it applied`);
    // Declared outside the rated branch, so a FREE run still reports null and
    // the card correctly shows nothing.
    assert.match(src, /let humanNewElo = null;/);
  });
}

test('the pages pass that rating to the card', () => {
  assert.match(fe('pages', 'TowerGame.jsx'), /result\.isSolo \? \(isWinner \? result\.newElo/);
  const bb = fe('pages', 'BlockBlastGame.jsx');
  assert.match(bb, /newWinnerElo=\{result\.humanWon \? result\.newElo : undefined\}/);
  assert.match(bb, /eloBeforeRef=\{eloBeforeRef\}/);
});

// ── The rest of the polish pass ──────────────────────────────────────────────

test('the countdown is opaque', () => {
  // It was translucent, so the board slid past underneath during the count.
  //
  // Scoped to the overlay itself: the catch-up banner legitimately uses a
  // translucent black, and a file-wide search flagged that instead.
  const src = fe('pages', 'TowerGame.jsx');
  const at = src.indexOf("phase === 'countdown' && (");
  assert.ok(at > 0, 'countdown overlay not found');
  const overlay = src.slice(at, at + 400);
  assert.match(overlay, /className="absolute inset-0 z-30[^"]*bg-bg"/,
    'the countdown overlay must be fully opaque');
  assert.doesNotMatch(overlay, /bg-black\/\d/, 'no translucency on the countdown');
});

test('the play area cannot be text-selected', () => {
  // A long press popped the copy handles and ate the next tap.
  for (const [f, ...p] of [['components', 'TowerCanvas.jsx'], ['pages', 'TowerGame.jsx']]) {
    const src = fe(f, ...p);
    assert.match(src, /WebkitTouchCallout/, `${p} allows the long-press callout`);
    assert.match(src, /userSelect/i);
  }
});

test('a perfect drop is felt as well as heard', () => {
  const src = fe('pages', 'TowerGame.jsx');
  assert.match(src, /navigator\.vibrate\?\.\(/);
  assert.match(src, /try \{[\s\S]{0,80}vibrate/, 'vibrate throws on some platforms and must be guarded');
  assert.match(src, /playTowerPerfect/);
  assert.match(src, /onPlace=\{playTowerPlace\}/, 'an ordinary landing needs its own sound');
});

test('the two placement sounds are distinct but equally quiet', () => {
  const src = fe('utils', 'sound.js');
  const grab = (name) => {
    const at = src.indexOf(`export function ${name}()`);
    assert.ok(at > 0, `${name} missing`);
    return src.slice(at, src.indexOf('\n}', at));
  };
  const place = grab('playTowerPlace');
  const perfect = grab('playTowerPerfect');
  assert.notEqual(place, perfect, 'they must not be the same sound');
  const peak = (body) => Math.max(...[...body.matchAll(/gain:\s*([\d.]+)/g)].map(m => +m[1]));
  assert.ok(peak(place) < 0.2 && peak(perfect) < 0.2, 'both were asked to stay subtle');
  assert.ok(Math.abs(peak(place) - peak(perfect)) < 0.06,
    'they should differ in brightness, not in volume');
});

test('the falling offcut can pass behind the tower', () => {
  // It is a 3D slice off a real block: half of it is on the far side.
  const src = fe('components', 'TowerCanvas.jsx');
  assert.match(src, /order: sl\.side < 0 \? -1 : 1/);
  assert.match(src, /drawables\.sort/);
});

test('the tower has a base that fades into the dark', () => {
  assert.match(fe('components', 'TowerCanvas.jsx'), /PLINTH_DEPTH/);
});

test('the background motes are dim, few and slow', () => {
  const src = fe('components', 'TowerCanvas.jsx');
  const block = src.slice(src.indexOf('const motes'), src.indexOf('let camera'));
  const count = +block.match(/length:\s*(\d+)/)[1];
  const alpha = +block.match(/a:\s*([\d.]+)\s*\+/)[1];
  const speed = +block.match(/v:\s*([\d.]+)\s*\+/)[1];
  assert.ok(count <= 14, `${count} motes is still confetti`);
  assert.ok(alpha <= 0.08, `base alpha ${alpha} is too bright`);
  assert.ok(speed <= 0.002, `base speed ${speed} is too fast`);
});

test('the score is smaller on a desktop', () => {
  const src = fe('components', 'TowerCanvas.jsx');
  assert.match(src, /width < 640 \? 0\.155 : 0\.0/, 'desktop needs its own, smaller scale');
});

test('the catch-up window is 15 seconds and the taller tower wins', () => {
  // Items 15 and 16, asserted rather than assumed.
  assert.match(engine, /CATCHUP_MS = 15_000/);
  assert.match(engine, /const winner = s1 >= s2 \? p1 : p2/);
});
