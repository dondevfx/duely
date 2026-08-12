// Rush Hour's end condition. A crash does not necessarily end the match: if the
// player who crashed finished AHEAD, the survivor keeps driving until they pass
// that score or crash below it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLedger, makeIo, player } = require('./helpers/stubs');

const carDash = require('../src/services/carDashEngine');

// 30 seconds in, so the anti-cheat score cap (elapsed * 380 + 500) is not the
// thing under test — at 5s it clamps every value below to the same number.
function liveMatch() {
  const { roomId } = carDash.createDirectCarDashRoom(player('s1', 'alice'), player('s2', 'bob'));
  const room = carDash.getCarDashRoom(roomId);
  room.state = 'active';
  room.startedAt = Date.now() - 30_000;
  return { roomId, room, io: makeIo(), supabase: makeLedger().supabase };
}

const winnerOf = (io) => io.resultsFor('car_dash_result')[0]?.d;

test('a crash while BEHIND does not end the match on the spot', async () => {
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 1500);   // bob leads
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 1000);
  assert.notEqual(room.state, 'finished',
    'the survivor already leads, so the match resolves on their next ping — not inside the crash');
  carDash.deleteCarDashRoom(roomId);
});

test('a crash while AHEAD lets the survivor keep playing and overtake', async () => {
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 1000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 3000);   // alice out, ahead

  assert.notEqual(room.state, 'finished',
    'the survivor must be given the chance to catch up');

  carDash.trackCarDashProgress(roomId, 's2', 6000, 3200);              // bob passes her
  await carDash.checkOvertake(io, supabase, roomId);

  const res = winnerOf(io);
  assert.ok(res, 'passing the crashed player\'s score must end the match');
  assert.equal(res.winnerUsername, 'bob');
  assert.equal(res.loserUsername, 'alice');
  carDash.deleteCarDashRoom(roomId);
});

test('a crash while AHEAD wins if the survivor crashes lower', async () => {
  const { roomId, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 1000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 3000);
  carDash.trackCarDashProgress(roomId, 's2', 6000, 2000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's2', 2000);

  const res = winnerOf(io);
  assert.ok(res, 'both players out must resolve the match');
  assert.equal(res.winnerUsername, 'alice', 'the higher score wins');
  assert.ok(res.winnerScore > res.loserScore);
  carDash.deleteCarDashRoom(roomId);
});

test('a leader who goes silent is finalised, and the opponent plays on', async () => {
  // The stall watchdog used to resolve the WHOLE match, which let a player who
  // was ahead background their tab and freeze the opponent wherever they were.
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 20_000, 1000);
  carDash.trackCarDashProgress(roomId, 's1', 20_000, 3000);

  room.times['s1'] = room.progress['s1'];        // what the watchdog does on a stall
  await carDash.checkOvertake(io, supabase, roomId);

  assert.notEqual(room.state, 'finished',
    'the opponent must not be frozen out when the leader stalls');

  carDash.trackCarDashProgress(roomId, 's2', 26_000, 3500);
  await carDash.checkOvertake(io, supabase, roomId);

  const res = winnerOf(io);
  assert.ok(res, 'the survivor overtaking must end the match');
  assert.equal(res.winnerUsername, 'bob', 'leaving must never beat playing');
  carDash.deleteCarDashRoom(roomId);
});

test('equal scores do not end the match early', async () => {
  // The tiebreak is survival time and the survivor is still adding to theirs,
  // so "more points wins" stays literally true.
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 2000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 2000);
  await carDash.checkOvertake(io, supabase, roomId);
  assert.notEqual(room.state, 'finished', 'a tie must not resolve as an overtake');
  carDash.deleteCarDashRoom(roomId);
});

// ── Beating a bot needs a real run ────────────────────────────────────────
// The bot used to be pinned behind the player unconditionally, so a bot match
// was a guaranteed win however briefly you survived — crash at two seconds and
// still take the pot.

test('the bot is pinned in exactly one place', () => {
  // Two pinning sites is how a floor gets applied on the crash path and skipped
  // on the stall path, which is the same bug in a different disguise.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  const pins = (src.match(/room\.times\[_botKey\(room\)\]\s*=/g) || []).length
             + (src.match(/r\.times\[_botKey\(r\)\]\s*=/g) || []).length;
  assert.equal(pins, 2,
    'expected exactly the two branches inside _resolveFromTimes (cleared / not cleared)');
  const fn = src.slice(src.indexOf('async function _resolveFromTimes'));
  assert.match(fn, /const cleared = room\.demoWin \|\| hT >= BOT_WIN_MIN_MS;/);
});

test('under 25 seconds the bot takes it', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  assert.match(src, /const BOT_WIN_MIN_MS = 25_000;/);
  const fn = src.slice(src.indexOf('const cleared = room.demoWin'));
  const elseBranch = fn.slice(fn.indexOf('} else {'), fn.indexOf('} else {') + 400);
  // Both must move, because score decides and time only breaks a tie — pinning
  // one would let a short run with a big combo still win.
  assert.match(elseBranch, /room\.times\[_botKey\(room\)\]\s*=\s*hT \+ /);
  assert.match(elseBranch, /room\.scores\[_botKey\(room\)\]\s*=\s*hS \+ /);
});

test('demo accounts still win regardless', () => {
  // The demo rig exists so the platform can be shown off without depending on
  // how well someone drives; the floor must not break it.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  assert.match(src, /room\.demoWin \|\| hT >= BOT_WIN_MIN_MS/,
    'demoWin must short-circuit the floor');
});

test('a stalled solo run faces the same floor', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  const watch = src.slice(src.indexOf('const watch = setInterval'), src.indexOf('}, WATCH_MS);'));
  assert.ok(!/_botKey\(r\)\]\s*=/.test(watch),
    'the watchdog must not pin the bot itself, or backgrounding the tab dodges the floor');
  assert.match(watch, /_resolveFromTimes/);
});
