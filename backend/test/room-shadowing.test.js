// Play Again puts a socket in a new room while the previous one is still in the
// map — Rush Hour holds a settled room for 5s, the others live until a sweep.
// The per-socket lookup used to return whichever room the Map yielded first, so
// the dead one could shadow the live match: the game would not start, or would
// not end when you died, because every handler was resolving against a room that
// was already over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findRoomBySocket } = require('../src/services/roomLookup');

const room = (id, players, extra = {}) => [id, { roomId: id, players, ...extra }];
const me = [{ socketId: 's1' }, { socketId: 's2' }];

test('a live room is returned', () => {
  const rooms = new Map([room('a', me)]);
  assert.equal(findRoomBySocket(rooms, 's1').roomId, 'a');
});

test('the live room wins even when the dead one is found first', () => {
  // Insertion order matters: the finished room is first, which is exactly the
  // ordering Play Again produces.
  const rooms = new Map([
    room('old', me, { state: 'finished' }),
    room('new', me),
  ]);
  assert.equal(findRoomBySocket(rooms, 's1').roomId, 'new',
    'the stale room must not shadow the match the player is actually in');
});

test('Word VS marks finished with `settled`, not `state`', () => {
  const rooms = new Map([
    room('old', me, { settled: true }),
    room('new', me),
  ]);
  assert.equal(findRoomBySocket(rooms, 's1').roomId, 'new',
    'checking only state would treat a finished Word VS room as live');
});

test('a finished room is still findable when it is the only one', () => {
  // The cleanup paths need it — they delete by the id this returns.
  const rooms = new Map([room('old', me, { state: 'finished' })]);
  assert.equal(findRoomBySocket(rooms, 's1').roomId, 'old');
});

test('several dead rooms do not hide the live one', () => {
  const rooms = new Map([
    room('d1', me, { state: 'finished' }),
    room('d2', me, { settled: true }),
    room('live', me),
  ]);
  assert.equal(findRoomBySocket(rooms, 's1').roomId, 'live');
});

test('a socket in no room gets null', () => {
  const rooms = new Map([room('a', [{ socketId: 'other' }])]);
  assert.equal(findRoomBySocket(rooms, 's1'), null);
});

test('a malformed room does not throw', () => {
  const rooms = new Map([['bad', {}], ['ok', { players: me }]]);
  assert.equal(findRoomBySocket(rooms, 's1').roomId, 'ok');
});

test('every engine routes its lookup through the shared helper', () => {
  // Six copies of this loop existed and all six had the bug. Any engine that
  // reintroduces its own version gets the shadowing back silently.
  const dir = path.join(__dirname, '..', 'src', 'services');
  const engines = ['carDashEngine.js', 'blockBlastEngine.js', 'blackjackEngine.js',
                   'coinFlipEngine.js', 'wordleEngine.js', 'matchmaking.js'];
  for (const f of engines) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(/require\('\.\/roomLookup'\)/.test(src), `${f} must import the shared lookup`);
    const fn = src.slice(src.search(/function get\w*RoomBySocket/));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/findRoomBySocket\(/.test(body), `${f} must delegate to findRoomBySocket`);
    assert.ok(!/for \(const \[roomId, room\]/.test(body),
      `${f} still has its own scan loop, which reintroduces the shadowing`);
  }
});
