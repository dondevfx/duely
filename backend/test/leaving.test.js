// The leave/forfeit contract.
//
// Regression origin: getWordleRoomBySocket returned the bare room while every
// other engine returns { roomId, room }. The forfeit and disconnect handlers
// destructure `const { room, roomId }`, so for Word VS `room` was undefined and
// the next line threw — leaving a Word VS match silently never forfeited, and
// the exception took the rest of the disconnect sweep with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { player, botPlayer } = require('./helpers/stubs');

const carDash    = require('../src/services/carDashEngine');
const blockBlast = require('../src/services/blockBlastEngine');
const wordle     = require('../src/services/wordleEngine');
const blackjack  = require('../src/services/blackjackEngine');
const coinFlip   = require('../src/services/coinFlipEngine');
const tower      = require('../src/services/towerEngine');

const ENGINES = [
  ['Rush Hour',   () => carDash.createDirectCarDashRoom(player('s1','u1'), player('s2','u2')),
                  carDash.getCarDashRoomBySocket,    carDash.deleteCarDashRoom],
  ['Block Burst', () => blockBlast.createDirectBlockBlastRoom(player('s1','u1'), player('s2','u2')),
                  blockBlast.getBlockBlastRoomBySocket, blockBlast.deleteBlockBlastRoom],
  ['Word VS',     () => wordle.createDirectWordleRoom(player('s1','u1'), player('s2','u2')),
                  wordle.getWordleRoomBySocket,      wordle.deleteWordleRoom],
  ['Coin Flip',   () => coinFlip.createDirectCoinFlipRoom?.(player('s1','u1'), player('s2','u2')),
                  coinFlip.getCoinFlipRoomBySocket,  coinFlip.deleteCoinFlipRoom],
  ['Blackjack',   () => blackjack.createDirectBlackjackRoom?.(player('s1','u1'), player('s2','u2')),
                  blackjack.getBlackjackRoomBySocket, blackjack.deleteBlackjackRoom],
  // Tower was absent from this list, which is how Word VS broke in the first
  // place: a new engine whose lookup returns a different shape is invisible
  // until someone leaves a real match and the forfeit throws.
  ['Tower',       () => tower.createDirectTowerRoom(player('s1','u1'), player('s2','u2')),
                  tower.getTowerRoomBySocket,        tower.deleteTowerRoom],
];

for (const [name, create, getBySocket, del] of ENGINES) {
  test(`${name}: the socket lookup returns the shape the leave handler expects`, () => {
    const made = create();
    assert.ok(made, `${name} has no direct-room helper — test needs updating`);

    const found = getBySocket('s1');
    assert.ok(found, `${name}: a player in a live room was not found by their socket`);

    // Exactly what handlers.js does when a player leaves. If the shape is wrong
    // this throws, which is precisely how the Word VS bug behaved in production.
    const { room, roomId } = found;
    assert.ok(room, `${name}: lookup must return { roomId, room }, got ${JSON.stringify(Object.keys(found)).slice(0, 60)}`);
    assert.ok(roomId, `${name}: lookup must include roomId`);
    assert.doesNotThrow(() => room.state, `${name}: reading room.state must not throw`);

    const leaver = room.players.find((p) => p.socketId === 's1');
    assert.ok(leaver, `${name}: the leaving player must be identifiable in room.players`);

    del(roomId);
  });

  test(`${name}: an unknown socket matches no room`, () => {
    assert.equal(getBySocket('nobody-at-all'), null, `${name}: a stranger must not resolve to a room`);
  });
}

test('a finished room is recognised whichever flag the engine uses', () => {
  // Engines disagree: most set state === 'finished', Word VS flips `settled`
  // and has no state field at all. The live-room guard has to understand both,
  // or a finished Word VS match locks the player out of starting anything else.
  const done = (room) => room.state === 'finished' || room.settled === true;

  const { roomId: cdId } = carDash.createDirectCarDashRoom(player('a1','ua'), player('a2','ub'));
  const cd = carDash.getCarDashRoom(cdId);
  cd.state = 'active';
  assert.equal(done(cd), false, 'an active Rush Hour room is not finished');
  cd.state = 'finished';
  assert.equal(done(cd), true, 'a finished Rush Hour room must read as finished');
  carDash.deleteCarDashRoom(cdId);

  const { roomId: wId } = wordle.createDirectWordleRoom(player('b1','uc'), player('b2','ud'));
  const wr = wordle.getWordleRoom(wId);
  assert.equal(Object.prototype.hasOwnProperty.call(wr, 'state'), false,
    'Word VS rooms still have no state field — the guard must not rely on one');
  assert.equal(done(wr), false, 'a live Word VS room is not finished');
  wr.settled = true;
  assert.equal(done(wr), true, 'a settled Word VS room must read as finished');
  wordle.deleteWordleRoom(wId);
});
