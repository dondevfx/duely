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
