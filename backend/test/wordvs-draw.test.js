// A drawn, staked Word VS match.
//
// Every settlement branch was gated on `winner && loser`, and a draw sets both
// to null — so a drawn staked match skipped settlement entirely. The stakes
// were taken at match start and never came back: the house kept the whole pot,
// neither player was unlocked, and the escrow stayed open. Word VS was the
// only game with a draw path and no settleDrawMatch call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'wordleEngine.js'), 'utf8');
const engine = require('../src/services/wordleEngine');

// Two players who both FAIL, with the same number of greens in their best row,
// which is what the tiebreak calls a draw.
function drawnRoom(fee, currency) {
  const p1 = { socketId: 'p1', userId: 'u1', username: 'Ann', entryFee: fee, currency };
  const p2 = { socketId: 'p2', userId: 'u2', username: 'Bob', entryFee: fee, currency };
  const { roomId } = engine.createDirectWordleRoom(p1, p2);
  const room = engine.getWordleRoom(roomId);
  room.entryFee = fee;
  room.currency = currency;
  room.feesDeducted = true;
  room.startedAt = Date.now();
  const row = (word) => engine.evaluateGuess(room.word, word);
  for (const sid of ['p1', 'p2']) {
    room.pstate[sid].guesses = [row('AAAAA')];
    room.pstate[sid].finished = true;
    room.pstate[sid].solved = false;
    room.pstate[sid].finishedAt = Date.now();
  }
  return { room, roomId, p1, p2 };
}

function recorder() {
  const credited = [];
  const rpcs = [];
  const chain = (d) => new Proxy(Promise.resolve({ data: d, error: null }), {
    get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => chain(d)),
  });
  const supabase = {
    rpc: async (name, args) => {
      rpcs.push({ name, args });
      if (name === 'credit_coins' || name === 'credit_diamonds') credited.push({ name, ...args });
      return { data: null, error: null };
    },
    from: () => ({ insert: async () => ({ error: null }), select: () => chain([]), update: () => chain([]) }),
  };
  return { supabase, credited, rpcs };
}

const io = { emit() {}, to: () => ({ emit() {} }) };

test('a drawn coin match hands both stakes back', async () => {
  const { roomId, room } = drawnRoom(5, 'coins');
  const { supabase, credited } = recorder();

  await engine._settleWordle(io, supabase, room, null);
  await new Promise(r => setTimeout(r, 40));

  const refunds = credited.filter(c => c.name === 'credit_coins');
  assert.equal(refunds.length, 2, `expected two refunds, saw ${refunds.length}`);
  assert.deepEqual(refunds.map(r => r.user_id).sort(), ['u1', 'u2']);
  for (const r of refunds) assert.equal(r.amount, 5, 'a draw must refund the full stake, not 95% of it');

  engine.deleteWordleRoom(roomId);
});

test('a drawn diamond match hands both stakes back', async () => {
  const { roomId, room } = drawnRoom(500, 'diamonds');
  const { supabase, credited } = recorder();

  await engine._settleWordle(io, supabase, room, null);
  await new Promise(r => setTimeout(r, 40));

  const refunds = credited.filter(c => c.name === 'credit_diamonds');
  assert.equal(refunds.length, 2, `expected two refunds, saw ${refunds.length}`);
  for (const r of refunds) assert.equal(r.amount, 500);

  engine.deleteWordleRoom(roomId);
});

test('a drawn match takes no rake and records no result', async () => {
  // No winner means no rake, no rakeback, no win and no loss. The draw
  // settlers take nothing, and the bookkeeping is already gated on
  // winner && loser.
  const { roomId, room } = drawnRoom(5, 'coins');
  const { supabase, rpcs } = recorder();

  await engine._settleWordle(io, supabase, room, null);
  await new Promise(r => setTimeout(r, 40));

  for (const banned of ['credit_fee_balance', 'add_rakeback_instant', 'increment_win', 'increment_loss', 'update_win_streak']) {
    assert.ok(!rpcs.some(r => r.name === banned), `a draw called ${banned}`);
  }

  engine.deleteWordleRoom(roomId);
});

test('a decided match is untouched by the draw branch', async () => {
  // The fix must not swallow ordinary results: a solved match still pays the
  // winner and still takes the rake.
  const { roomId, room } = drawnRoom(5, 'coins');
  room.pstate.p1.solved = true;   // Ann solved it
  const { supabase, rpcs, credited } = recorder();

  // settleMatch only credits the fee balance when there is an admin to credit
  // it to, so the rake is invisible without this — the assertion below would
  // pass against a build that had stopped taking it.
  const prevAdmin = process.env.ADMIN_USER_ID;
  process.env.ADMIN_USER_ID = 'admin-1';
  try {
    await engine._settleWordle(io, supabase, room, 'p1');
    await new Promise(r => setTimeout(r, 40));
  } finally {
    if (prevAdmin === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = prevAdmin;
  }

  const paid = credited.filter(c => c.name === 'credit_coins');
  assert.equal(paid.length, 1, 'a decided match pays one player');
  assert.equal(paid[0].user_id, 'u1');
  assert.equal(paid[0].amount, 9.5, '95% of a 10-coin pot');
  assert.ok(rpcs.some(r => r.name === 'credit_fee_balance'), 'the rake was not taken');

  engine.deleteWordleRoom(roomId);
});

test('the draw branch settles off p1 and p2, not winner and loser', () => {
  // On a draw those are the only references to the players that exist —
  // reaching for winner.userId is exactly how this went unsettled.
  const branch = SRC.slice(SRC.indexOf('} else if (fee > 0 && supabase && isDraw) {'),
                           SRC.indexOf('} else if (fee > 0 && supabase && winner && loser) {'));
  assert.ok(branch.length > 0, 'the draw branch is gone');
  assert.match(branch, /settleDrawMatchDiamonds\(supabase, p1\.userId, p2\.userId, fee\)/);
  assert.match(branch, /settleDrawMatch\(supabase, p1\.userId, p2\.userId, fee\)/);
  assert.ok(!/winner\.userId|loser\.userId/.test(branch),
    'the draw branch reads winner/loser, which are null on a draw');
});

test('a failed refund still unlocks both players', () => {
  // Otherwise a settlement error costs them the stake AND locks them out of
  // starting another match.
  const branch = SRC.slice(SRC.indexOf('} else if (fee > 0 && supabase && isDraw) {'),
                           SRC.indexOf('} else if (fee > 0 && supabase && winner && loser) {'));
  assert.match(branch, /catch \(e\) \{[\s\S]*unlockUser\(p1\.userId\); unlockUser\(p2\.userId\);/);
});
