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
  assert.match(overlay, /className="absolute inset-0 z-30[^"]*bg-bg[ "]/,
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

test('the two placement sounds are distinct', () => {
  // Levels are asserted by 'the placement sounds are actually audible on a
  // phone' below — this one only cares that they are not the same sound.
  const src = fe('utils', 'sound.js');
  const grab = (name) => {
    const at = src.indexOf(`export function ${name}()`);
    assert.ok(at > 0, `${name} missing`);
    return src.slice(at, src.indexOf('\n}', at));
  };
  assert.notEqual(grab('playTowerPlace'), grab('playTowerPerfect'));
});


test('the tower has a base that fades into the dark', () => {
  assert.match(fe('components', 'TowerCanvas.jsx'), /PLINTH_DEPTH/);
});

test('the background motes are dim, few and slow', () => {
  const src = fe('components', 'TowerCanvas.jsx');
  const block = src.slice(src.indexOf('const newMote'), src.indexOf('let camera'));
  const count = +block.match(/length:\s*(\d+)/)[1];
  const alpha = +block.match(/a:\s*([\d.]+)\s*\+/)[1];
  const speed = +block.match(/v:\s*([\d.]+)\s*\+/)[1];
  // Some were asked back after being cut too far, but they must stay a depth
  // cue rather than weather.
  // More of them were asked for, spawning lower down the screen. Still dim and
  // slow enough to stay a depth cue rather than weather.
  assert.ok(count >= 20 && count <= 45, `${count} motes`);
  assert.ok(alpha <= 0.14, `base alpha ${alpha} is too bright`);
  assert.ok(speed <= 0.0012, `base speed ${speed} is too fast`);
  const birth = +src.match(/MOTE_BIRTH = ([\d.]+)/)[1];
  assert.ok(birth >= 0.8, `motes start ${birth} down the screen — asked for lower`);
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

// ── The second pass ──────────────────────────────────────────────────────────

test('a forfeited Tower match is reported as Tower', () => {
  // This block was copied from Block Burst and every identifier renamed except
  // one: the forfeit was still being settled under 'blockBlast', so a Tower
  // walkout was recorded against the wrong game.
  const at = handlers.indexOf('deleteTowerRoom, ');
  assert.ok(at > 0, 'no Tower forfeit call found');
  assert.doesNotMatch(handlers, /deleteTowerRoom,\s*'(?!tower')/,
    'a Tower room must never be settled under another game name');
  assert.match(handlers, /deleteTowerRoom, 'tower'/);
});

test('no other Block Burst identifier survived the copy', () => {
  // The whole handler block was duplicated, so anything left behind is a bug of
  // exactly this shape.
  const start = handlers.indexOf("socket.on('join_tower_queue'");
  const end = handlers.indexOf("socket.on('tower_rematch_request'");
  assert.ok(start > 0 && end > start);
  const block = handlers.slice(start, end);
  assert.doesNotMatch(block, /blockBlast|block_blast|BlockBlast/i,
    'a Block Burst reference is still inside the Tower handlers');
});

test('a PvP win streak reaches the result card', () => {
  // It was emitted as a hard-coded 0 and applied afterwards in the background,
  // so the streak was recorded correctly and never once displayed.
  // Scoped to _resolve: there are two tower_result emits and the solo one comes
  // first in the file, so an unscoped search compared the wrong pair.
  const fn = engine.slice(engine.indexOf('async function _resolve(io'));
  const applied = fn.indexOf('applyMatchStreaks');
  const emit = fn.indexOf("emit('tower_result'");
  assert.ok(applied > 0, 'streaks are never applied in the PvP resolve');
  assert.ok(applied < emit, 'streaks must be resolved before the result is emitted');
  assert.match(engine, /winnerStreak,\n\s+isFirstWin,/,
    'the real values must be sent, not zeroes');
});

test('streaks stay PvP-only', () => {
  assert.match(engine, /!winner\.isBot && !loser\.isBot/);
});

test('Solo Endless does not show a bot opponent', () => {
  // It is played through the bot plumbing, but there is nobody to race.
  const src = fe('pages', 'TowerGame.jsx');
  assert.match(src, /const \[soloEndless, setSoloEndless\]/);
  assert.match(src, /\{opponent && !soloEndless &&/, 'the score panel must be hidden');
  assert.match(src, /setSoloEndless\(!!vsBot && !\(fee > 0\)\)/);
});

test('the countdown matches the other games', () => {
  const src = fe('pages', 'TowerGame.jsx');
  const at = src.indexOf("phase === 'countdown' && (");
  const overlay = src.slice(at, at + 700);
  assert.match(overlay, /text-8xl font-black text-primary/, 'same size and weight');
  assert.match(overlay, /Get ready\.\.\./, 'same wording as every other game');
  assert.doesNotMatch(overlay, /press space|Tap or press/i, 'no bespoke instruction line');
});

test('the placement sounds are actually audible on a phone', () => {
  // The first version was built on a 132Hz body, which a handset speaker cannot
  // reproduce — it was effectively silent, which read as "no sound effects".
  const src = fe('utils', 'sound.js');
  for (const name of ['playTowerPlace', 'playTowerPerfect']) {
    const at = src.indexOf(`export function ${name}()`);
    const body = src.slice(at, src.indexOf('\n}', at));
    const freqs = [...body.matchAll(/tone\((\d+)/g)].map(m => +m[1]);
    const gains = [...body.matchAll(/gain:\s*([\d.]+)/g)].map(m => +m[1]);
    assert.ok(Math.min(...freqs) >= 170, `${name} still has a ${Math.min(...freqs)}Hz body`);
    assert.ok(Math.max(...gains) >= 0.15, `${name} peaks at ${Math.max(...gains)} — too quiet to hear`);
    assert.ok(Math.max(...gains) <= 0.25, `${name} is louder than "subtle"`);
  }
});

test('a falling offcut cannot be seen through the tower', () => {
  // Third attempt at this. Interleaving by height embedded the slice in the
  // block below; drawing it on top with a fading alpha made it literally
  // see-through. It is now painted BEFORE the tower at full opacity, so the
  // tower simply covers it.
  //
  // Anchored on code, not on the section comments — the helper strips those.
  const src = fe('components', 'TowerCanvas.jsx');
  const offcuts = src.indexOf('for (const sl of s.slices)');
  const tower   = src.indexOf('for (let i = firstVisible;');
  assert.ok(offcuts > 0, 'offcut draw loop not found');
  assert.ok(tower > 0, 'tower draw loop not found');
  assert.ok(offcuts < tower, 'offcuts must be drawn before the tower, so it occludes them');
  assert.doesNotMatch(src, /ctx\.rotate\(sl\.spin/, 'the tilt drew attention to the overlap');
  assert.match(src.slice(offcuts, tower), /sl\.level, 1\)/, 'an offcut must be fully opaque');
});

test('the plinth is solid and the darkness is a scrim', () => {
  // Fading the plinth with alpha let every block behind show through, so the
  // base came out as a lattice of overlapping diamonds instead of a tower.
  const src = fe('components', 'TowerCanvas.jsx');
  const at = src.indexOf('for (let L = -1; L >= -PLINTH_DEPTH; L--)');
  assert.ok(at > 0, 'plinth loop not found');
  const plinth = src.slice(at, at + 400);
  assert.match(plinth, /index: L \}, L, 1\)/, 'plinth blocks must be fully opaque');
  assert.match(src, /createLinearGradient/, 'the fade into the dark should be a scrim');
  assert.match(src, /addColorStop\(1, 'rgba\(0,0,0,1\)'\)/, 'and reach full black');
});

test('the burst outline is thicker', () => {
  assert.match(fe('components', 'TowerCanvas.jsx'), /ctx\.lineWidth = 5/);
});

test('Tower uses the tower emoji, and nobody else uses it', () => {
  assert.match(fe('pages', 'QuickMatch.jsx'), /icon: '🗼', queueKey: 'tower'/);
  // Still has to be unique, or two games light up together in the reel.
  const icons = [...fe('pages', 'QuickMatch.jsx').matchAll(/icon: '([^']+)'/g)].map(m => m[1]);
  assert.equal(new Set(icons).size, icons.length, `duplicate icon: ${icons}`);
});

test('the plinth is drawn bottom-up, like the tower', () => {
  // It ran from L = -1 downward, so each deeper block painted over the one
  // above it — and because a block's top face is drawn last, every deeper block
  // stamped its own lid across its neighbour. The base came out as a stack of
  // visible rhombus outlines rather than a solid column.
  const src = fe('components', 'TowerCanvas.jsx');
  assert.match(src, /for \(let L = plinthBottom; L <= -1; L\+\+\)/,
    'the plinth must paint deepest-first so nearer blocks cover it');
});

test('the darkness starts low enough not to dull live blocks', () => {
  const src = fe('components', 'TowerCanvas.jsx');
  const top = +src.match(/const scrimTop = height \* ([\d.]+)/)[1];
  assert.ok(top >= 0.75, `the scrim starts at ${top} of the screen — too high`);
});
