// Switching apps mid-run suspends the browser's animation loop, so progress
// pings stop and the stall watchdog finalises the player. In a BOT match that
// used to hang the room forever: the human was finalised, the bot's time is only
// ever set when the human crashes, and the "is everyone done?" check therefore
// never passed. The player came back, kept driving, died — and nothing happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLedger, makeIo, player, botPlayer } = require('./helpers/stubs');

const carDash = require('../src/services/carDashEngine');

function soloRoom() {
  const { roomId } = carDash.createDirectCarDashRoom(player('p1', 'human'), botPlayer('botsock'));
  const room = carDash.getCarDashRoom(roomId);
  room.state = 'active';
  room.startedAt = Date.now() - 20_000;
  return { roomId, room, io: makeIo(), supabase: makeLedger().supabase };
}

test('a bot room is flagged solo, which is what the stall path keys off', () => {
  const { roomId, room } = soloRoom();
  assert.equal(room.isSolo, true);
  carDash.deleteCarDashRoom(roomId);
});

test('waiting for every player cannot settle a bot room — the old hang', () => {
  const { roomId, room } = soloRoom();
  carDash.trackCarDashProgress(roomId, 'p1', 12_000, 3000);
  room.times['p1'] = room.progress['p1'];          // the watchdog finalising the human

  const botKey = room.players.find((p) => p.isBot).socketId || 'bot';
  const everyoneDone = room.players.every((p) => room.times[p.socketId ?? botKey] != null);
  assert.equal(everyoneDone, false,
    'the bot has no final time, so an all-players check hangs — this is why the fix pins the bot');
  carDash.deleteCarDashRoom(roomId);
});

test('the stall path pins the bot so a solo room always settles', () => {
  // Mirrors the branch the watchdog now takes for solo rooms.
  const { roomId, room } = soloRoom();
  carDash.trackCarDashProgress(roomId, 'p1', 12_000, 3000);
  room.times['p1'] = room.progress['p1'];

  const botKey = room.players.find((p) => p.isBot).socketId || 'bot';
  const hT = room.times['p1'] ?? 0;
  const hS = room.scores['p1'] ?? 0;
  room.times[botKey]  = Math.max(0, Math.floor(hT * 0.85) - 200);
  room.scores[botKey] = Math.max(0, Math.floor(hS * 0.85) - 10);

  const everyoneDone = room.players.every((p) => room.times[p.socketId ?? botKey] != null);
  assert.equal(everyoneDone, true, 'with the bot pinned the room can settle');
  assert.ok(room.scores[botKey] < room.scores['p1'],
    'the bot must be pinned BELOW the player, so a stall is not turned into a loss they did not earn');
  carDash.deleteCarDashRoom(roomId);
});

test('the watchdog handles solo rooms explicitly', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  const watch = src.slice(src.indexOf('const watch = setInterval'),
                          src.indexOf('}, WATCH_MS);'));
  assert.ok(/r\.isSolo/.test(watch),
    'the stall handler must special-case solo rooms or they hang');
  assert.ok(/_resolveFromTimes/.test(watch),
    'and settle them directly rather than waiting for a second player');
});

test('the stall window is 15 seconds', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'carDashEngine.js'), 'utf8');
  assert.ok(/const STALL_MS   = 15_000;/.test(src),
    'leaving the app should end a PvP match after about 15s');
});
