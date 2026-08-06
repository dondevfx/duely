// The catch-up window.
//
// When a player crashes while AHEAD, the survivor gets a fixed window to beat
// that score. Pass it and they win immediately; let it expire and they lose.
// Before this the survivor could drive on indefinitely, so a match had no
// defined end.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLedger, makeIo, player } = require('./helpers/stubs');

const carDash = require('../src/services/carDashEngine');

function liveMatch() {
  const { roomId } = carDash.createDirectCarDashRoom(player('s1', 'alice'), player('s2', 'bob'));
  const room = carDash.getCarDashRoom(roomId);
  room.state = 'active';
  room.startedAt = Date.now() - 30_000;      // clear of the score cap
  return { roomId, room, io: makeIo(), supabase: makeLedger().supabase };
}
const resultOf = (io) => io.resultsFor('car_dash_result')[0]?.d;
const catchupOf = (io) => io.resultsFor('car_dash_catchup')[0]?.d;

test('crashing while ahead starts the window and tells the survivor', async () => {
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 1000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 3000);

  const c = catchupOf(io);
  assert.ok(c, 'the survivor must be told they are on a clock');
  assert.equal(c.targetScore, 3000, 'and what score they have to beat');
  assert.ok(c.seconds > 0);
  assert.notEqual(room.state, 'finished', 'the match must stay live during the window');
  assert.ok(room.catchupTimer, 'a timer must be running');

  clearTimeout(room.catchupTimer);
  carDash.deleteCarDashRoom(roomId);
});

test('beating the score inside the window wins immediately', async () => {
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 1000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 3000);

  carDash.trackCarDashProgress(roomId, 's2', 6000, 3200);
  await carDash.checkOvertake(io, supabase, roomId);

  const res = resultOf(io);
  assert.ok(res, 'passing the target must end the match at once');
  assert.equal(res.winnerUsername, 'bob');
  assert.equal(room.catchupTimer, null, 'the window timer must be cleared on an overtake');
  carDash.deleteCarDashRoom(roomId);
});

test('the window expiring without an overtake loses', async (t) => {
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 1000);
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 3000);

  assert.ok(room.catchupTimer, 'window should be armed');
  // Fire the window immediately rather than waiting out the real duration.
  clearTimeout(room.catchupTimer);
  room.catchupTimer = null;
  room.times['s2'] = room.progress['s2'] ?? 4000;
  await carDash.checkOvertake(io, supabase, roomId);   // still behind: no early end

  // Now settle as the expiry path does.
  const engineResolve = require('../src/services/carDashEngine');
  await engineResolve.forceResolveCarDash(io, supabase, roomId);

  const res = resultOf(io);
  assert.ok(res, 'the window running out must resolve the match');
  assert.equal(res.winnerUsername, 'alice', 'the crashed player keeps their lead');
  assert.ok(res.winnerScore > res.loserScore);
  carDash.deleteCarDashRoom(roomId);
});

test('crashing while BEHIND starts no window — there is nothing to chase', async () => {
  const { roomId, room, io, supabase } = liveMatch();
  carDash.trackCarDashProgress(roomId, 's2', 4000, 5000);   // bob well ahead
  await carDash.handleCarDashCrash(io, supabase, roomId, 's1', 1000);

  assert.equal(catchupOf(io), undefined, 'no clock when the survivor already leads');
  assert.ok(!room.catchupTimer, 'no timer should be armed');
  if (room.catchupTimer) clearTimeout(room.catchupTimer);
  carDash.deleteCarDashRoom(roomId);
});

test('a solo match against a bot never arms a window', async () => {
  const { roomId } = carDash.createDirectCarDashRoom(
    player('h1', 'human'),
    { socketId: 'botsock', userId: 'bot', username: 'Bot', elo: 1000, isBot: true, entryFee: 0, currency: 'coins' },
  );
  const room = carDash.getCarDashRoom(roomId);
  room.state = 'active';
  room.startedAt = Date.now() - 30_000;
  const io = makeIo();
  const { supabase } = makeLedger();

  await carDash.handleCarDashCrash(io, supabase, roomId, 'h1', 500);
  assert.ok(!room.catchupTimer, 'bot matches resolve immediately, with no chase window');
  if (room.catchupTimer) clearTimeout(room.catchupTimer);
  carDash.deleteCarDashRoom(roomId);
});
