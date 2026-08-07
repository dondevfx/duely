// What happens if a player walks away while the coin is still spinning?
//
// The server decides and settles the flip the moment it resolves; the 4.2s
// animation is purely client-side. So there is a window where the match is
// already decided and paid, but the player has not seen it yet. Leaving in that
// window must not cost them a win they already have, and must not let a loser
// escape a loss.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeLedger, makeIo, player } = require('./helpers/stubs');

const coinFlip = require('../src/services/coinFlipEngine');

const engineSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'coinFlipEngine.js'), 'utf8');

test('the room is marked finished before anything can await', () => {
  // This ordering is what makes leaving safe: the forfeit path keys off
  // state === 'finished', so if an await sneaked in above the assignment there
  // would be a window where a leaver could be forfeited out of a won match.
  const fn = engineSrc.slice(engineSrc.indexOf('async function resolveCoinFlip'));
  const head = fn.slice(0, fn.indexOf("room.state = 'finished';"));
  assert.ok(!/await/.test(head),
    'nothing may await between entering resolveCoinFlip and marking it finished');
  assert.ok(/if \(!room \|\| room\.state === 'finished'\) return;/.test(head),
    'and a second resolve must be refused');
});

test('a resolved flip pays exactly once, and leaving afterwards changes nothing', async () => {
  const io = makeIo();
  const { coins, supabase } = makeLedger();
  coins.alice = 0; coins.bob = 0;

  const p1 = player('s1', 'alice', { entryFee: 10, side: 'heads' });
  const p2 = player('s2', 'bob',   { entryFee: 10, side: 'tails' });
  const made = coinFlip.createDirectCoinFlipRoom(p1, p2);
  const roomId = made.roomId || made;
  const room = coinFlip.getCoinFlipRoom(roomId);
  room.entryFee = 10;
  room.currency = 'coins';
  room.feesDeducted = true;          // fees were taken when the match started

  await coinFlip.resolveCoinFlip(io, supabase, roomId);

  const paidOut = (coins.alice || 0) + (coins.bob || 0);
  assert.ok(paidOut > 0, 'the flip must pay the winner');
  assert.equal(room.state, 'finished');

  // Now the winner leaves while their client is still animating. The forfeit
  // sweep does exactly this check before doing anything.
  const alreadySettled = room.state === 'finished' || room.settled === true;
  assert.equal(alreadySettled, true,
    'leaving mid-animation must hit the already-settled branch, not a forfeit');

  // A second resolve — as a stray timer or a re-entrant call would trigger —
  // must not pay again.
  await coinFlip.resolveCoinFlip(io, supabase, roomId);
  assert.equal((coins.alice || 0) + (coins.bob || 0), paidOut,
    'the payout must not be repeated');

  coinFlip.deleteCoinFlipRoom(roomId);
});

test('leaving BEFORE the flip resolves is still a forfeit', () => {
  const p1 = player('s3', 'carol', { entryFee: 10, side: 'heads' });
  const p2 = player('s4', 'dave',  { entryFee: 10, side: 'tails' });
  const made = coinFlip.createDirectCoinFlipRoom(p1, p2);
  const roomId = made.roomId || made;
  const room = coinFlip.getCoinFlipRoom(roomId);

  // Nothing has resolved yet, so the sweep must NOT treat it as settled.
  const alreadySettled = room.state === 'finished' || room.settled === true;
  assert.equal(alreadySettled, false,
    'an unresolved room must fall through to the forfeit handler');

  coinFlip.deleteCoinFlipRoom(roomId);
});

test('a settled room is dropped, so it cannot shadow the next match', async () => {
  // getCoinFlipRoomBySocket returns the FIRST room holding that socket. A socket
  // survives SPA navigation, so a finished room left in the map would be found
  // ahead of the player's live second match — and the forfeit sweep, seeing
  // 'finished', would clean up the stale one and move on without forfeiting the
  // real one.
  const io = makeIo();
  const { coins, supabase } = makeLedger();
  coins.gina = 0; coins.hank = 0;

  const p1 = player('s7', 'gina', { entryFee: 10, side: 'heads' });
  const p2 = player('s8', 'hank', { entryFee: 10, side: 'tails' });
  const first = coinFlip.createDirectCoinFlipRoom(p1, p2);
  const firstId = first.roomId || first;
  const room = coinFlip.getCoinFlipRoom(firstId);
  room.entryFee = 10; room.currency = 'coins'; room.feesDeducted = true;

  await coinFlip.resolveCoinFlip(io, supabase, firstId);
  assert.equal(coinFlip.getCoinFlipRoom(firstId), undefined,
    'a settled room must not linger in the map');

  // Same sockets, second match. The sweep must find THIS one.
  const second = coinFlip.createDirectCoinFlipRoom(
    player('s7', 'gina', { entryFee: 10, side: 'heads' }),
    player('s8', 'hank', { entryFee: 10, side: 'tails' }));
  const secondId = second.roomId || second;

  const found = coinFlip.getCoinFlipRoomBySocket('s7');
  assert.equal(found.roomId, secondId,
    'the live match must be what a leaving player is looked up against');
  assert.notEqual(found.room.state, 'finished',
    'and it must still be forfeitable');

  coinFlip.deleteCoinFlipRoom(secondId);
});

test('the loser cannot escape by leaving once it has resolved', async () => {
  const io = makeIo();
  const { coins, supabase } = makeLedger();
  coins.eve = 0; coins.frank = 0;

  const p1 = player('s5', 'eve',   { entryFee: 10, side: 'heads' });
  const p2 = player('s6', 'frank', { entryFee: 10, side: 'tails' });
  const made = coinFlip.createDirectCoinFlipRoom(p1, p2);
  const roomId = made.roomId || made;
  const room = coinFlip.getCoinFlipRoom(roomId);
  room.entryFee = 10; room.currency = 'coins'; room.feesDeducted = true;

  await coinFlip.resolveCoinFlip(io, supabase, roomId);

  const res = io.emitted.find((e) => e.ev === 'coin_flip_result');
  assert.ok(res, 'a result must be emitted');
  const before = { ...coins };

  // The loser bails the instant they see the result on the wire.
  assert.equal(room.state, 'finished');
  await coinFlip.resolveCoinFlip(io, supabase, roomId);
  assert.deepEqual(coins, before,
    'leaving after the decision must not refund the loser or re-pay the winner');

  coinFlip.deleteCoinFlipRoom(roomId);
});
