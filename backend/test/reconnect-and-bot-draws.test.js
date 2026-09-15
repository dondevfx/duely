// A phone that drops mid-match comes back to the same match, sees a result it
// missed, and a tie against a bot shows up in the history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rekeyRoomSocket, emitRoomResult, emitPlayerResult, missedResultFor } = require('../src/services/roomLookup');
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');

test('reconnecting moves every per-player map to the new socket id', () => {
  const room = {
    players: [{ socketId: 'old', userId: 'u1' }, { socketId: 'bot', userId: 'b' }],
    hands: { old: ['A', 'K'], bot: ['9', '7'] },
    stood: { old: false, bot: true },
    scores: new Map([['old', 12]]),
    roomId: 'r1', entryFee: 500, list: ['old'],
  };
  rekeyRoomSocket(room, 'old', 'new');
  assert.deepEqual(room.hands, { bot: ['9', '7'], new: ['A', 'K'] });
  assert.deepEqual(room.stood, { bot: true, new: false });
  assert.equal(room.scores.get('new'), 12);
  assert.equal(room.scores.has('old'), false);
  assert.equal(room.roomId, 'r1');
  assert.deepEqual(room.list, ['old']);                 // arrays are not maps; left alone
  assert.equal(room.players[0].socketId, 'old');         // players is updated by the caller
});

test('a result is kept for a player who missed it, per player where results differ', () => {
  const sent = [];
  const io = { to: (id) => ({ emit: (ev, p) => sent.push([id, ev, p]) }) };
  const room = {};
  emitRoomResult(io, room, 'r1', 'bj_result', { winnerId: 'u1' });
  assert.deepEqual(sent, [['r1', 'bj_result', { winnerId: 'u1' }]]);
  assert.deepEqual(missedResultFor(room, 'u1'), { event: 'bj_result', payload: { winnerId: 'u1' } });

  const w = {};
  emitPlayerResult(io, w, { socketId: 's1', userId: 'u1' }, 'wordle_result', { iWon: true });
  emitPlayerResult(io, w, { socketId: 's2', userId: 'u2' }, 'wordle_result', { iWon: false });
  assert.equal(missedResultFor(w, 'u2').payload.iWon, false);
  assert.equal(missedResultFor({}, 'u1'), null);
});

test('the resume handler rekeys, rejoins and replays a missed result', () => {
  const h = src('socket', 'handlers.js');
  const fn = h.slice(h.indexOf('const updateSocketFn = (newSocket) => {'), h.indexOf('pendingJobs.push({ forfeitFn, updateSocketFn'));
  assert.match(fn, /rekeyRoomSocket\(room, leaverSocketId, newSocket\.id\)/);
  assert.ok(fn.indexOf('rekeyRoomSocket') < fn.indexOf('leaver.socketId = newSocket.id'));
  assert.match(fn, /missedResultFor\(room, leaver\.userId\)/);
  assert.match(fn, /newSocket\.emit\(missed\.event, missed\.payload\)/);
});

test('every game stores its result for a returning player', () => {
  for (const [eng, ev] of [['blackjack', 'bj_result'], ['blockBlast', 'block_blast_result'], ['carDash', 'car_dash_result'],
    ['coinFlip', 'coin_flip_result'], ['colorRush', 'color_rush_result'], ['tower', 'tower_result']]) {
    const s = src('services', `${eng}Engine.js`);
    assert.doesNotMatch(s, new RegExp(`io\\.to\\(roomId\\)\\.emit\\('${ev}'`), eng);
    assert.match(s, new RegExp(`emitRoomResult\\(io, room, roomId, '${ev}'`), eng);
  }
  assert.match(src('services', 'wordleEngine.js'), /emitPlayerResult\(io, room, p1, 'wordle_result'/);
});

test('the Blackjack turn timer checks again for a player who was reconnecting', () => {
  const s = src('services', 'blackjackEngine.js');
  const fn = s.slice(s.indexOf('function _autoStandAll'), s.indexOf('function _checkAllDone'));
  assert.match(fn, /waitingOnReconnect = true; continue;/);
  assert.match(fn, /if \(waitingOnReconnect\) \{[\s\S]*setTimeout\(\(\) => _autoStandAll\(io, supabase, roomId\), 2000\)/);
});

test('a tie against a bot refunds the stake and writes a history row', async () => {
  const rows = [];
  const rpcs = [];
  const sb = {
    rpc: (name, args) => { rpcs.push([name, args]); return Promise.resolve({ data: 1, error: null }); },
    from: () => ({ insert: (r) => { rows.push(r); return Promise.resolve({ error: null }); } }),
  };
  const { refundBotDraw } = require('../src/services/walletService');
  const d = await refundBotDraw(sb, 'u1', 500, 'diamonds', { game: 'Blackjack' });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(d, { winnerPayout: 500 });
  assert.equal(rpcs[0][0], 'credit_diamonds');
  assert.equal(rows[0].type, 'match_draw');
  assert.equal(rows[0].crypto_amount, 500);
  assert.equal(rows[0].notes, 'Blackjack vs Bot');

  for (const eng of ['blackjack', 'blockBlast', 'carDash', 'colorRush', 'wordle']) {
    assert.match(src('services', `${eng}Engine.js`), /refundBotDraw\(supabase, /, eng);
  }
});

test('a quit bot game names its game in the history', () => {
  assert.match(src('socket', 'handlers.js'), /settleBotMatch\(supabase, leaver\.userId, fee, currency, false, \{ game: GAME_LABELS\[gameType\] \}\)/);
});
