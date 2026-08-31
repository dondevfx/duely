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
  assert.match(engine, /if \(alwaysWin\)\s+humanWon = true;/);
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
  // Home.jsx and Games.jsx used to keep their own separate copies of this
  // list, which had already drifted apart in wording before both were merged
  // into one shared data/games.js that both pages read from.
  const places = {
    'data/games.js':              /route:\s+'\/game\/tower'/,
    'components/LeftSidebar.jsx': /'\/game\/tower'/,
    'components/Navbar.jsx':      /to: '\/game\/tower'/,
    'pages/QuickMatch.jsx':       /queueKey: 'tower'/,
  };
  for (const [file, re] of Object.entries(places)) {
    assert.match(fe(...file.split('/')), re, `${file} does not list Tower`);
  }

  // And both pages must actually be reading from the shared list rather than
  // having quietly grown a new copy of their own.
  for (const page of ['pages/Home.jsx', 'pages/Games.jsx']) {
    assert.match(fe(...page.split('/')), /from ['"]\.\.\/data\/games['"]/,
      `${page} must import GAMES from data/games.js, not list games itself`);
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
  // Matched independently rather than as one adjacent pair — the pair broke
  // the moment a new scored game was inserted between them, which is a test
  // failing on where a name sits in a list rather than on anything real.
  const lb = be('routes', 'leaderboard.js');
  const scored = lb.slice(lb.indexOf('const SCORE_GAMES'), lb.indexOf('\n', lb.indexOf('const SCORE_GAMES')));
  for (const g of ['carDash', 'tower']) {
    assert.ok(scored.includes(`'${g}'`), `${g} must be a scored game or its leaderboard is always empty`);
  }
  assert.match(be('services', 'tickerService.js'), /tower:\s+\{ key: 'tower'/);
  assert.match(fe('pages', 'Profile.jsx'), /tower:\s+\{ name: 'Tower'/);
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
  // "Like the others" is now literal: all six share useLeaveGuard rather than
  // each emitting player_forfeit themselves. Which cases that covers — and the
  // app-switch case it must NOT cover — is asserted in leave-guard.test.js.
  const src = fe('pages', 'TowerGame.jsx');
  assert.match(src, /useLeaveGuard\(/);
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
    assert.match(src, /let humanNewElo = null(, eloBefore = null)?;/);
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
  // \r?\n, not \n: git checks these files out with CRLF on Windows, so a
  // bare \n silently fails to match code that is perfectly correct.
  assert.match(engine, /winnerStreak,\r?\n\s+isFirstWin,/,
    'the real values must be sent, not zeroes');
});

test('streaks stay PvP-only', () => {
  assert.match(engine, /!winner\.isBot && !loser\.isBot/);
});

test('Solo Endless does not show a bot opponent, but a demo match does', () => {
  // Solo Endless is played through the bot plumbing and there is nobody to
  // race, so the opponent panel is hidden.
  //
  // A DEMO match is also free and also against a bot, and it must NOT be
  // hidden: looking like an ordinary PvP match is the whole point of the demo,
  // and the old condition swallowed it, turning it into a solo run. The
  // opponent's own isBot flag separates the two — only the openly-named Duely
  // Bot carries it, a disguised one does not.
  const src = fe('pages', 'TowerGame.jsx');
  assert.match(src, /const \[soloEndless, setSoloEndless\]/);
  assert.match(src, /\{opponent && !soloEndless &&/, 'the score panel must be hidden');
  assert.match(src, /setSoloEndless\(!!vsBot && !\(fee > 0\) && !!opp\?\.isBot\)/);
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
  // Drawing it on top with a fading alpha made it literally see-through, so the
  // tower showed straight through the falling piece. Which SIDE of the tower it
  // is drawn on is covered by 'an offcut falls on the side it was cut from';
  // this only cares that it is solid.
  const src = fe('components', 'TowerCanvas.jsx');
  const at = src.indexOf('const drawSlice =');
  assert.ok(at > 0, 'drawSlice not found');
  const fn = src.slice(at, src.indexOf('};', at));
  assert.match(fn, /sl\.level, 1\)/, 'an offcut must be fully opaque');
  assert.doesNotMatch(src, /ctx\.rotate\(sl\.spin/, 'the tilt drew attention to the overlap');
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

test('Tower has its own drawn icon, and no other game shares it', () => {
  // The emoji became a drawn icon, so the thing to check moved from the lists
  // to the one component that now holds every icon.
  const icons = fe('components', 'GameIcon.jsx');
  assert.match(icons, /function Tower\(\)/, 'Tower needs an icon');
  assert.match(icons, /tower:\s+Tower,/, 'and it has to be wired to the tower key');
  // Every game maps to a DIFFERENT drawing, or two games share a face.
  const map = icons.slice(icons.indexOf('const ICONS = {'), icons.indexOf('};', icons.indexOf('const ICONS = {')));
  const arts = [...map.matchAll(/:\s*(\w+),/g)].map(m => m[1]);
  assert.ok(arts.length >= 7, `expected every game in the icon map, found ${arts.length}`);
  assert.equal(new Set(arts).size, arts.length, `two games share an icon: ${arts}`);
  assert.match(fe('pages', 'QuickMatch.jsx'), /queueKey: 'tower'/);
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

test('a diamond bet against the bot is decided by the stated target', () => {
  // The player is told "get 15 to win", so 15 has to be what decides it.
  assert.match(engine, /const DIAMOND_BOT_MIN_SCORE = 15/);
  assert.match(engine, /humanWon = verified >= DIAMOND_BOT_MIN_SCORE/);
});

test('the target applies to diamonds only, and never to a free run', () => {
  // Coins vs bot and Solo Endless must keep their own rules.
  assert.match(engine, /const diamondBot = !freeSolo && room\.currency === 'diamonds'/);
  // A free run is decided before the currency is ever consulted.
  const at = engine.indexOf('if (alwaysWin)');
  const chain = engine.slice(at, at + 260);
  assert.ok(chain.indexOf('alwaysWin') < chain.indexOf('diamondBot'),
    'a free run must be resolved before the diamond rule');
  assert.match(chain, /else\s+humanWon = verified > botScore;/,
    'coins vs bot must still be decided on score against the bot');
});

test('the outcome and the shown scores never contradict each other', () => {
  // Superseded the old one-directional check: the bot score is now nudged on
  // both sides, so neither a win nor a loss can be reported next to a score line
  // that says the opposite.
  assert.match(engine, /if \(humanWon && botScore >= verified\)/);
  assert.match(engine, /if \(!humanWon && botScore <= verified\)/);
});

test('the diamond-bot floor is no longer advertised on the betting screen', () => {
  // Removed on request. NOTE: DIAMOND_BOT_MIN_SCORE is still what decides a
  // diamond bot match, so the rule now applies without being stated anywhere
  // the player can read it. If the rule is ever dropped from the engine, this
  // test and the constant go together.
  assert.doesNotMatch(fe('pages', 'TowerGame.jsx'), /at least 15 blocks to win/);
});

test('the searching screen is the one every other game uses', () => {
  const tower = fe('pages', 'TowerGame.jsx');
  const cardash = fe('pages', 'CarDashGame.jsx');
  for (const marker of ['Searching...', 'border-4 border-primary border-t-transparent rounded-full animate-spin']) {
    assert.ok(tower.includes(marker), `Tower's queue screen is missing: ${marker}`);
    assert.ok(cardash.includes(marker), `template changed: ${marker}`);
  }
  assert.doesNotMatch(tower, /Finding an opponent…/, 'the bespoke wording should be gone');
});

test('the block is visible at the top right when it spawns', () => {
  // It always spawned top-right, but at TRAVEL 1.9 that point was off the side
  // of a phone screen — so the first thing a player saw was it already sliding
  // in from the edge, which read as starting from the wrong place.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'towerCore.js'), 'utf8');
  const { createRun, makeView, isoProject } = new Function(
    `${src.replace(/export /g, '')}; return { createRun, makeView, isoProject };`)();

  for (const [W, H] of [[390, 760], [420, 860], [1280, 800]]) {
    const run = createRun();
    const v = makeView(W, H, 0);
    const centre = isoProject(0, 0, 1, v);
    const spawn = isoProject(0, run.state.moving.pos, 1, v);
    assert.ok(spawn.px > centre.px, `${W}x${H}: spawns left of centre`);
    assert.ok(spawn.py < centre.py, `${W}x${H}: spawns below centre`);
    assert.ok(spawn.px > 0 && spawn.px < W, `${W}x${H}: spawn x=${spawn.px.toFixed(0)} is off screen`);
    assert.ok(spawn.py > 0 && spawn.py < H, `${W}x${H}: spawn y=${spawn.py.toFixed(0)} is off screen`);
  }
});

test('the canvas tells the core whether input is live', () => {
  // Otherwise the slider travels behind the countdown overlay.
  assert.match(fe('components', 'TowerCanvas.jsx'), /run\.step\(dt, runningRef\.current\)/);
});

test('an offcut falls on the side it was cut from', () => {
  // +x and +y both point toward the viewer, so a piece taken off the near side
  // belongs in front of the tower and a far-side piece behind it. Drawing them
  // all on one side is wrong for half of them either way.
  const src = fe('components', 'TowerCanvas.jsx');
  const back  = src.indexOf('if ((sl.side || 1) < 0) drawSlice(sl)');
  const tower = src.indexOf('for (let i = firstVisible;');
  const front = src.indexOf('if ((sl.side || 1) >= 0) drawSlice(sl)');
  assert.ok(back > 0 && tower > 0 && front > 0, 'draw calls not found');
  assert.ok(back < tower, 'far-side offcuts must be drawn before the tower');
  assert.ok(front > tower, 'near-side offcuts must be drawn after the tower');
});

test('clearing the diamond target IS the win, not a second condition', () => {
  // First written as an extra requirement on top of out-scoring the bot, which
  // meant a 46-block run could lose to a bot placed at 48 — three times over the
  // stated bar, and shown a defeat. A rule the player is told has to be the rule
  // that decides it.
  assert.match(engine, /else if \(diamondBot\)\s+humanWon = verified >= DIAMOND_BOT_MIN_SCORE;/);
  // And it must not ALSO require beating the bot.
  const at = engine.indexOf('else if (diamondBot)');
  const line = engine.slice(at, engine.indexOf('\n', at));
  assert.doesNotMatch(line, /botScore/, 'the bot score must not gate a diamond win');
});

test('the shown bot score agrees with the outcome either way', () => {
  assert.match(engine, /if \(humanWon && botScore >= verified\)/);
  assert.match(engine, /if \(!humanWon && botScore <= verified\)/);
});

test('a bot match rates against the current rating, not a cached one', () => {
  // calculateNewRatings returns an ABSOLUTE value. Derived from the elo cached
  // on the socket at queue time, it produces a swing that is not the gain or
  // loss at all — a socket holding 1020 against a profile of 1000 writes
  // 1020 - 17 = 1003, which the card reports as +3 on a defeat.
  // Tower had a bespoke copy of this read. It has since been generalised into
  // eloService.freshRatings and adopted by all six engines — the same flaw was
  // left in the other five and resurfaced as a +4 win in Rush Hour, which is
  // the argument for one implementation rather than six.
  const solo = engine.slice(engine.indexOf('if (room.isSolo)'));
  assert.match(solo, /await freshRatings\(supabase, player, BOT\)/,
    'the current rating must be read before it is changed');
  assert.match(solo, /await freshRatings\(supabase, BOT, player\)/);
  const at = solo.indexOf('freshRatings');
  assert.doesNotMatch(solo.slice(at, at + 200), /player\.elo/,
    'the cached socket rating must not feed the calculation');
});

test('the card is told which number to subtract from', () => {
  assert.match(engine, /eloBefore,/);
  assert.match(fe('pages', 'TowerGame.jsx'), /eloBeforeRef\.current = Number\(data\.eloBefore\)/);
});

test('fast repeated tapping cannot trigger the copy bubble', () => {
  // CSS alone does not cover this. user-select and touch-callout suppress a LONG
  // press, but a fast repeated tap is a different gesture: iOS reads it as a
  // double-tap, which selects, raises the magnifier and offers Copy — and that
  // swallows the next tap mid-run.
  // Whitespace-normalised: the source aligns these calls, and the test should
  // not dictate formatting. Plain string matching rather than a regex, because
  // escaping a brace through a template literal turns it into a quantifier that
  // silently matches nothing.
  const src = fe('components', 'TowerCanvas.jsx').replace(/[ 	]+/g, ' ');
  for (const ev of ['touchstart', 'touchmove', 'touchend']) {
    assert.ok(src.includes(`addEventListener('${ev}', eat, { passive: false })`),
      `${ev} must be suppressed, and non-passively or preventDefault is ignored`);
  }
  assert.match(src, /addEventListener\('selectstart', eat\)/);
  assert.match(src, /addEventListener\('contextmenu', eat\)/);
});

test('a selection that slips through is cleared on the next drop', () => {
  // Once a selection exists iOS keeps the bubble alive across later taps, so it
  // has to be removed rather than only prevented.
  const src = fe('components', 'TowerCanvas.jsx');
  const fn = src.slice(src.indexOf('const drop = ()'), src.indexOf('const onPointer'));
  assert.match(fn, /removeAllRanges\(\)/);
});

test('the touch handlers do not drop a block themselves', () => {
  // pointerdown already covers touch; dropping from both would place two blocks
  // for one tap.
  const src = fe('components', 'TowerCanvas.jsx');
  const at = src.indexOf('const eat = (e)');
  assert.ok(at > 0, 'suppressor not found');
  assert.doesNotMatch(src.slice(at, src.indexOf('\n', at)), /drop\(\)/);
});

test('every touch listener is removed on cleanup', () => {
  const src = fe('components', 'TowerCanvas.jsx');
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'selectstart', 'contextmenu']) {
    assert.ok(src.includes(`removeEventListener('${ev}', eat)`), `${ev} leaks`);
  }
});
