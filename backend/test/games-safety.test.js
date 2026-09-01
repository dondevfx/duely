// Every game, the same guarantees.
//
// Eight games were built over time and each one added its own queue, its own
// room, its own settle path. The failure mode is never that a game is broken —
// it is that the SEVENTH game is missing the one line the other six have, and
// nothing says so until real money moves. These are parity checks: they compare
// the games against each other rather than against a fixed list, so a ninth
// game inherits them for free.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = (...p) => path.join(__dirname, '..', 'src', ...p);
const be = (...p) => fs.readFileSync(SRC(...p), 'utf8');
const HANDLERS = be('socket', 'handlers.js');

// Engines running a real-time score race, where a player who stops playing
// could otherwise hold the room open. Blackjack (20s auto-stand), Word VS
// (90s idle) and Coin Flip (resolves on a timer) end on their own clocks.
const RACE_ENGINES = ['blockBlast', 'tower', 'carDash', 'colorRush'];
const ALL_ENGINES = [...RACE_ENGINES, 'wordle', 'blackjack', 'coinFlip'];

// ── Leaving ─────────────────────────────────────────────────────────────────

test('every queue is emptied on all three ways of leaving', () => {
  // Color Rush was in none of them. A player who left its lobby while queued
  // stayed queued, and was matched later as a no-show the opponent had to sit
  // through — the ghost-match bug the other games were already fixed for.
  const removers = [...HANDLERS.matchAll(/removeFrom(\w+)Queue\b/g)].map((m) => m[1]);
  const games = [...new Set(removers)];
  assert.ok(games.length >= 7, `expected every game's queue, found ${games}`);

  const block = (marker, end) => {
    const at = HANDLERS.indexOf(marker);
    assert.ok(at > 0, `could not find ${marker}`);
    return HANDLERS.slice(at, HANDLERS.indexOf(end, at));
  };
  const paths = {
    leave_all_queues: block("socket.on('leave_all_queues'", '});'),
    'player_forfeit (not in a room)': block('if (!forfeited) {', 'io.emit('),
    disconnect: block('// Remove from all queues', '// Broadcast queue entry'),
  };
  const missing = [];
  for (const [name, body] of Object.entries(paths)) {
    for (const g of games) {
      if (!body.includes(`removeFrom${g}Queue`)) missing.push(`${name} does not clear ${g}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('every game can be forfeited from, on disconnect and on navigating away', () => {
  // Both lists must name the same games, or a game is one where walking out
  // settles and the other where it hangs.
  const lists = [...HANDLERS.matchAll(/const roomLookups = \[([\s\S]*?)\];/g)]
    .map((m) => [...m[1].matchAll(/'([\w-]+)'\]/g)].map((x) => x[1]).sort());
  assert.equal(lists.length, 2, 'expected the forfeit and the disconnect lookups');
  assert.deepEqual(lists[0], lists[1], 'the two forfeit paths cover different games');
  for (const g of ['blockBlast', 'scrabble', 'coin_flip', 'blackjack', 'carDash', 'colorRush', 'tower']) {
    assert.ok(lists[0].includes(g), `${g} cannot be forfeited from`);
  }
});

// ── A match always ends ─────────────────────────────────────────────────────

test('no score race can be held open by a player who simply stops playing', () => {
  // Block Burst and Tower had no watchdog at all. Joining a paid PvP match and
  // never placing a piece kept the room active forever: the opponent could play
  // as long as they liked and never win, and their only way out was to forfeit
  // and lose the stake. Refusing to play must never hold someone else's coins.
  for (const name of RACE_ENGINES) {
    const src = be('services', `${name}Engine.js`);
    assert.match(src, /const STALL_MS\s*=/, `${name} has no stall watchdog`);
    assert.match(src, /setInterval\(/, `${name} never runs its watchdog`);
    // And an absolute ceiling, for a stall the ping check cannot see.
    assert.match(src, /MAX_(MATCH|RUN)_MS/, `${name} has no upper bound on a match`);
  }
});

test('a stalled player ends their own run, never the whole match', () => {
  // Resolving the match on a stall was an exploit in Rush Hour: whoever was
  // ahead could background the tab and freeze the opponent where they stood.
  // A stall is treated exactly like dying — the opponent plays on with the
  // normal catch-up window.
  for (const name of RACE_ENGINES) {
    const src = be('services', `${name}Engine.js`);
    assert.match(src, /const CATCHUP_MS = 15_000;/, `${name} has no 15s catch-up`);
  }
});

test('the catch-up window is armed from the survivor, not the leaver', () => {
  const bb = be('services', 'blockBlastEngine.js');
  const tw = be('services', 'towerEngine.js');
  // The new watchdogs go through the normal end-of-run path rather than
  // settling directly, or they reintroduce the freeze-the-opponent bug.
  assert.match(bb, /handleBlockBlastStuck\(io, supabase, roomId, p\.socketId/);
  assert.match(tw, /handleTowerComplete\(io, supabase, roomId, p\.socketId/);
  // Unless everyone still in has gone quiet, in which case there is nobody to
  // play on for and a catch-up would be armed for an absent player.
  for (const src of [bb, tw]) {
    assert.match(src, /stalled\.length === live\.length/,
      'both-stalled must settle rather than arm a catch-up nobody is there for');
  }
});

// ── Money ───────────────────────────────────────────────────────────────────

test('no engine pays out a stake it never took', () => {
  // Tower was the one game whose settle was not gated on the fee actually
  // having been deducted — handlers.js has always set the flag on its rooms,
  // and the engine never read it.
  // Matched on the behaviour, not one spelling of it — Word VS words the same
  // guard differently and a literal match reported it as missing.
  const missing = [];
  for (const name of ALL_ENGINES) {
    const src = be('services', `${name}Engine.js`);
    const guarded = /!room\.feesDeducted/.test(src) && /CRITICAL[^\n]*feesDeducted/.test(src);
    if (!guarded) missing.push(name);
  }
  assert.deepEqual(missing, [], `these settle without checking the fee was taken: ${missing.join(', ')}`);
});

test('a failed fee deduction cancels the match rather than starting it', () => {
  // Otherwise a match runs, and settles, on money that was never taken.
  const calls = [...HANDLERS.matchAll(/await deductMatchFees\(/g)].map((m) => m.index);
  assert.ok(calls.length >= 7, `expected every game's deduction, found ${calls.length}`);
  const bad = [];
  for (const at of calls) {
    const after = HANDLERS.slice(at, at + 1400);
    const line = HANDLERS.slice(0, at).split('\n').length;
    if (!/catch \(e\)/.test(after)) bad.push(`line ${line}: deduction is not wrapped`);
    else if (!/match_cancelled/.test(after)) bad.push(`line ${line}: players are not told`);
    else if (!/\n\s*return;/.test(after)) bad.push(`line ${line}: falls through and starts anyway`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('the score a match settles on is the server value, never the claimed one', () => {
  for (const name of RACE_ENGINES) {
    const src = be('services', `${name}Engine.js`);
    assert.ok(/scoreBuckets|SCORE_RATE_CAP/.test(src), `${name} does not rate-limit claimed scores`);
    assert.match(src, /function _isPlayer\(room, socketId\)/,
      `${name} does not check the sender belongs to the room it names`);
  }
});

// ── Matchmaking ─────────────────────────────────────────────────────────────

test('every game can be played privately as well as from the queue', () => {
  // Rush Hour once minted a challenge code and then did nothing, because this
  // switch had no case for it.
  const at = HANDLERS.indexOf('let roomId;\n    switch (gameType)');
  assert.ok(at > 0, 'could not find the private-room switch');
  const sw = HANDLERS.slice(at, HANDLERS.indexOf('default: break;', at));
  for (const g of ['blockBlast', 'tower', 'scrabble', 'coin-flip', 'carDash', 'colorRush', 'blackjack']) {
    assert.ok(sw.includes(`case '${g}':`), `no private-room case for ${g}`);
  }
  // And each must mark the fee taken, or the guard above blocks its payout.
  const cases = sw.split(/case '/).slice(1);
  const unmarked = cases.filter((c) => !/feesDeducted = true/.test(c)).map((c) => c.slice(0, c.indexOf("'")));
  assert.deepEqual(unmarked, [], `these private matches would settle unpaid: ${unmarked}`);
});

// ── Disguised players ───────────────────────────────────────────────────────

test('a fake name never arrives without a face to go with it', () => {
  // Demo accounts play under a random name, and the bots that fill a casual
  // queue are given one too. Both were sent with profileColor null, so every
  // disguised opponent drew the same default blue circle while real players
  // vary — which is how you spot a fake one at a glance.
  const demo = be('services', 'demoAccounts.js');
  assert.match(demo, /function disguisedFace\(name\)/);
  // Takes the viewer too, so two demo accounts matched together can be shown
  // to each other as themselves — see demo-and-limits.test.js.
  assert.match(demo, /function shownAs\(p, viewer\)/);
  // From the palette a real player actually picks from, not an invented colour.
  assert.match(demo, /const PROFILE_COLORS = \[/);
  assert.match(demo, /'#1250B4', '#00BFFF'/);

  // Bots get name and face together, so the two cannot drift apart again.
  const bot = be('services', 'botService.js');
  assert.match(bot, /function disguiseBot\(bot\)/);
  assert.match(bot, /bot\.username = randomFunnyName\(\);\s*\n\s*Object\.assign\(bot, disguisedFace\(bot\.username\)\);/);
  assert.doesNotMatch(HANDLERS, /bot\.username = randomFunnyName\(\)/,
    'a bot is still being named without being given a face');
});

test('every disguised payload sends the disguised face, not the real one', () => {
  // A fake name beside the account's real photograph is a worse disguise than
  // none, and it leaks the real player.
  assert.doesNotMatch(HANDLERS, /isDemo \? randomFunnyName\(\)/,
    'a payload still builds a name on its own');
  const shown = [...HANDLERS.matchAll(/const (\w+) = shownAs\([^)]*\);/g)].map((m) => m[1]);
  assert.ok(shown.length >= 12, `expected every queue path, found ${shown.length}`);

  const bad = [];
  for (const v of shown) {
    // Wherever the shown NAME is used, the shown face must be used with it.
    // Escaped twice on purpose: inside a template literal `\w` is just "w".
    const re = new RegExp(`username: ${v}\\.username,[^}]*?avatarUrl: ([\\w.]+),\\s*profileColor: ([\\w.]+)`, 'g');
    let m, seen = 0;
    while ((m = re.exec(HANDLERS))) {
      seen++;
      if (m[1] !== `${v}.avatarUrl` || m[2] !== `${v}.profileColor`) {
        bad.push(`${v}: name is disguised but the face is ${m[1]}`);
      }
    }
    if (seen === 0) bad.push(`${v}: computed but never used`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('the disguised colour is stable and from the real palette', () => {
  // Stable, or an opponent changes colour between the countdown and the result
  // card and reads as two different people.
  const src = be('services', 'demoAccounts.js');
  const geom = new Function(`${src.replace(/module\.exports[\s\S]*$/, '')}; return { disguisedFace, shownAs, PROFILE_COLORS };`)();
  const a = geom.disguisedFace('ThighMaster69');
  assert.deepEqual(a, geom.disguisedFace('ThighMaster69'), 'the colour changes between calls');
  assert.ok(geom.PROFILE_COLORS.includes(a.profileColor));
  assert.equal(a.avatarUrl, null, 'a disguise must not carry a picture');

  // And it must actually spread across the palette rather than collapsing onto
  // one colour, which is the bug in a different shape.
  const used = new Set(geom.PROFILE_COLORS.map((_, i) => geom.disguisedFace(`Player${i}Name`).profileColor));
  assert.ok(used.size >= 5, `only ${used.size} colours in use — they will still look alike`);

  // A real player is passed through untouched.
  const real = geom.shownAs({ username: 'jack', avatarUrl: 'u', profileColor: '#22c55e' });
  assert.deepEqual(real, { username: 'jack', avatarUrl: 'u', profileColor: '#22c55e' });
});

// ── The bet slider ──────────────────────────────────────────────────────────

test('the slider is grabbed by a bigger box than the bar it draws', () => {
  // The bar was its own hit area, so a tap a few pixels above or below it, or
  // in the 12px gutters the thumb overhangs into, landed on nothing — and on a
  // phone that is most of the taps aimed at either end of the range.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'BetSlider.jsx'), 'utf8');

  assert.match(src, /const hitRef\s+= useRef\(null\)/, 'there is no separate grab area');
  // Bigger on all four sides, and the height given back so nothing moves.
  assert.match(src, /ref=\{hitRef\}[\s\S]{0,200}?-my-3 py-3 px-3/);
  // Every pointer event listens on the grab area, not the bar.
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    // Escaped twice: inside a template literal `\.` is just a dot.
    assert.match(src, new RegExp(`hit\\.addEventListener\\('${ev}'`), `${ev} is not on the grab area`);
    assert.match(src, new RegExp(`hit\\.removeEventListener\\('${ev}'`), `${ev} is not cleaned up`);
  }
  assert.doesNotMatch(src, /track\.(add|remove)EventListener/, 'the bar is still listening');
  assert.match(src, /hit\.setPointerCapture/, 'capture must follow the listener');

  // But positions are still measured against the VISIBLE bar. Measuring the
  // grab area instead would offset every stop by half a step, so the thumb
  // would land beside the tap rather than under it.
  // Searched FORWARD from rawFromX: applySliderDOM is defined above it and also
  // starts "function apply", so an unanchored search sliced an empty string and
  // the assertion below passed against nothing.
  const at = src.indexOf('function rawFromX');
  const fn = src.slice(at, src.indexOf('function apply', at));
  assert.ok(fn.length > 50, 'could not isolate rawFromX');
  assert.match(fn, /track\.getBoundingClientRect\(\)/);
  assert.doesNotMatch(fn, /hit\.getBoundingClientRect\(\)/);
});

// ── Starting the match at the top of the screen ─────────────────────────────

test('every game locks the queue screen as well as the countdown', () => {
  // The lock used to arm at the countdown, so the queue screen was free to
  // scroll — and whatever you scrolled to was still there when the board
  // arrived.
  const FE2 = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
  const pages = ['BlockBlastGame', 'TowerGame', 'WordleGame', 'BlackjackGame',
                 'CoinFlipGame', 'CarDashGame', 'ColorRushGame'];
  const bad = [];
  for (const p of pages) {
    const src = fs.readFileSync(FE2('pages', `${p}.jsx`), 'utf8');
    const call = src.match(/useGameScrollLock\(([^;]*)\);/);
    if (!call) { bad.push(`${p}: no scroll lock at all`); continue; }
    if (!/phase === 'queue'/.test(call[1])) bad.push(`${p}: the queue screen is not locked`);
    // And the phase must be passed as the pin key, or the lock stays armed
    // across queue -> countdown -> play and never re-pins.
    if (!/,\s*(phase|`)/.test(call[1])) bad.push(`${p}: nothing tells it to re-pin on a phase change`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('the lock re-pins on a phase change, not only when it arms', () => {
  // This is the actual bug: `active` stays true the whole way from queue to
  // play, so an effect keyed on it alone fires once, at the START of the queue.
  // Scroll after that and the board opens exactly where you left it.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'hooks', 'useGameScrollLock.js'), 'utf8');
  assert.match(src, /export function useGameScrollLock\(active, pinOn\)/);
  assert.match(src, /\}, \[active, pinOn\]\);/, 'the re-pin must depend on the phase too');
  assert.match(src, /\}, \[active\]\);/, 'the lock itself still keys on active alone');
  // Separate effects: re-running the lock would drop the overflow style for a
  // frame and let the page jump.
  assert.ok(src.indexOf('}, [active, pinOn]);') < src.indexOf('}, [active]);'),
    'the re-pin should be its own effect, before the lock');
});
