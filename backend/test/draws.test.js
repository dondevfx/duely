// An equal score is a draw.
//
// It was not, in any of the four score-based games. Color Rush and Rush Hour
// fell through to survival time — and if the times matched too, to player 1.
// Block Burst and Tower were worse: `s1 >= s2 ? p1 : p2` handed every tie to
// whoever the room happened to list first. A player who tied reported losing,
// and they were right.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const GAMES = {
  colorRushEngine:  { event: 'color_rush_result',  timed: true  },
  carDashEngine:    { event: 'car_dash_result',    timed: true  },
  blockBlastEngine: { event: 'block_blast_result', timed: false },
  towerEngine:      { event: 'tower_result',       timed: false },
};

test('an equal score is a draw in every score game', () => {
  for (const [file] of Object.entries(GAMES)) {
    const code = strip(read(`${file}.js`));
    assert.match(code, /const isDraw = s1 === s2;/, `${file} does not recognise a tie`);
  }
});

test('no tiebreak decides a tied score', () => {
  // The two timed games broke ties on survival time. Time is still reported —
  // it is worth seeing — but it must not pick a winner.
  for (const file of ['colorRushEngine', 'carDashEngine']) {
    const code = strip(read(`${file}.js`));
    assert.ok(!/s1 !== s2 \? s1 > s2 : t1 >= t2/.test(code),
      `${file} still breaks a tied score on time`);
    assert.match(code, /const p1Wins = s1 > s2;/);
  }
  // And the two score-only games must stop handing ties to player 1.
  for (const file of ['blockBlastEngine', 'towerEngine']) {
    const code = strip(read(`${file}.js`));
    const at = code.indexOf('const isDraw = s1 === s2;');
    assert.ok(at > 0, `${file} does not recognise a tie`);
    assert.ok(code.slice(at, at + 400).includes('{ isDraw }'),
      `${file} works out the tie and then does not pass it on`);
  }
});

test('a drawn match refunds both stakes', () => {
  // The fee is taken at match start, so a draw has to hand it back — a match
  // nobody won is a match the house takes nothing from.
  for (const file of Object.keys(GAMES)) {
    const code = strip(read(`${file}.js`));
    assert.match(code, /settleDrawMatchDiamonds\(supabase/, `${file} has no diamond refund`);
    assert.match(code, /settleDrawMatch\(supabase/, `${file} has no coin refund`);
    assert.match(code, /require\('\.\/walletService'\)/);
    assert.ok(/settleDrawMatch[,\s}]/.test(code.split('\n').filter(l => l.includes('walletService')).join('\n')),
      `${file} uses the draw settler without importing it`);
  }
});

test('a draw moves no rating, no record and no streak', () => {
  // There is no winner to gain and no loser to drop. Leaving these in would
  // record a win and a loss for a match that had neither.
  for (const file of Object.keys(GAMES)) {
    const code = strip(read(`${file}.js`));
    assert.match(code, /if \(!isDraw\) \{ try \{ await supabase\.rpc\('increment_win'/,
      `${file} counts a win on a draw`);
    assert.match(code, /if \(!isDraw\) \{ try \{ await supabase\.rpc\('increment_loss'/,
      `${file} counts a loss on a draw`);
    assert.ok(/isDraw\)?\s*$|isFree \|\| isDraw|ranked && !isDraw/m.test(code),
      `${file} still rates a draw`);
    assert.ok(!/^\s*try \{ await applyMatchStreaks/m.test(code),
      `${file} moves a streak on a draw`);
  }
});

test('a drawn match is recorded with no winner', () => {
  // Otherwise the leaderboards and the admin figures count a win that did not
  // happen.
  for (const file of Object.keys(GAMES)) {
    const code = strip(read(`${file}.js`));
    assert.match(code, /winner_id:\s*\(isDraw \|\| winner\.isBot\) \? null : winner\.userId/,
      `${file} records a winner for a drawn match`);
  }
});

test('the client is told, and every page passes it on', () => {
  for (const [file, { event }] of Object.entries(GAMES)) {
    const code = strip(read(`${file}.js`));
    // Inside _resolve, not the first emit in the file.
    //
    // Every one of these games also emits the same event from its SOLO path,
    // which comes first and cannot be a draw — checking the first match tested
    // the wrong emit. Worse, when I patched by first-match I inserted isDraw
    // into that solo payload in two engines, where the name is not even in
    // scope: a ReferenceError the moment anyone finished a solo run.
    const body = code.slice(code.indexOf('async function _resolve(io'));
    const at = body.indexOf(`emit('${event}', {`);
    assert.ok(at > 0, `${file} never emits ${event} from _resolve`);
    assert.ok(body.slice(at, at + 200).includes('isDraw'),
      `${file} does not send isDraw with the result`);
    // And the solo payload must NOT carry it.
    const solo = code.slice(0, code.indexOf('async function _resolve(io'));
    const soloAt = solo.indexOf(`emit('${event}', {`);
    if (soloAt > 0) {
      const soloPayload = solo.slice(soloAt, soloAt + 200);
      assert.ok(!/^\s*isDraw,$/m.test(soloPayload),
        `${file} puts isDraw in its solo payload, where it is out of scope`);
    }
  }
  const fe = (p) => fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', p), 'utf8');
  for (const page of ['ColorRushGame.jsx', 'CarDashGame.jsx', 'TowerGame.jsx']) {
    assert.match(fe(page), /isDraw=\{!!result\.isDraw\}/, `${page} drops isDraw`);
  }
  // Block Burst had its own `draw` flag on the timeout path first, so it
  // accepts either — and the engine now sends both names from that path.
  assert.match(fe('BlockBlastGame.jsx'), /isDraw=\{!!\(result\.isDraw \|\| result\.draw\)\}/);
  assert.match(read('blockBlastEngine.js'), /\{ isDraw: true, draw: true, reason: 'timeout' \}/);
});

// ── Driven, not read ──────────────────────────────────────────────────────

test('a real tied Tower match settles as a draw', async () => {
  // The checks above read the source. This one runs it: two players, the same
  // score, and every consequence observed rather than asserted about.
  const engine = require('../src/services/towerEngine');

  const emitted = [];
  const io = {
    emit() {},
    to: () => ({ emit: (ev, payload) => emitted.push({ ev, payload }) }),
  };

  const rpcs = [];
  const inserted = [];
  const chain = (data) => new Proxy(Promise.resolve({ data, error: null }), {
    get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => chain(data)),
  });
  const supabase = {
    rpc: async (name, args) => { rpcs.push({ name, args }); return { data: null, error: null }; },
    from: (table) => ({
      insert: async (row) => { inserted.push({ table, row }); return { error: null }; },
      select: () => chain([]),
      update: () => chain([]),
    }),
  };

  const p1 = { socketId: 's1', userId: 'u1', username: 'Ann', entryFee: 0, currency: 'coins' };
  const p2 = { socketId: 's2', userId: 'u2', username: 'Bob', entryFee: 0, currency: 'coins' };
  const { roomId } = engine.createDirectTowerRoom(p1, p2);
  const room = engine.getTowerRoom(roomId);
  room.state = 'active';
  room.scores = { s1: 7, s2: 7 };
  room.finished = { s1: true, s2: true };

  await engine._resolveFromScores(io, supabase, roomId);
  await new Promise(r => setTimeout(r, 40));

  const result = emitted.find(e => e.ev === 'tower_result');
  assert.ok(result, 'no result was emitted');
  assert.equal(result.payload.isDraw, true, 'a 7-7 match was not reported as a draw');

  // No win, no loss.
  const counted = rpcs.filter(r => r.name === 'increment_win' || r.name === 'increment_loss');
  assert.deepEqual(counted, [], `a draw recorded ${counted.map(c => c.name).join(', ')}`);

  // And no winner in the match record.
  const match = inserted.find(i => i.table === 'matches');
  if (match) assert.equal(match.row.winner_id, null, 'a drawn match recorded a winner');

  engine.deleteTowerRoom(roomId);
});

test('a real Tower match that is NOT tied still has a winner', async () => {
  // The other half: the draw must not swallow ordinary results.
  const engine = require('../src/services/towerEngine');
  const emitted = [];
  const io = { emit() {}, to: () => ({ emit: (ev, payload) => emitted.push({ ev, payload }) }) };
  const rpcs = [];
  const chain = (data) => new Proxy(Promise.resolve({ data, error: null }), {
    get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => chain(data)),
  });
  const supabase = {
    rpc: async (name, args) => { rpcs.push({ name, args }); return { data: null, error: null }; },
    from: () => ({ insert: async () => ({ error: null }), select: () => chain([]), update: () => chain([]) }),
  };

  const p1 = { socketId: 'a1', userId: 'w', username: 'Win', entryFee: 0, currency: 'coins' };
  const p2 = { socketId: 'a2', userId: 'l', username: 'Lose', entryFee: 0, currency: 'coins' };
  const { roomId } = engine.createDirectTowerRoom(p1, p2);
  const room = engine.getTowerRoom(roomId);
  room.state = 'active';
  room.scores = { a1: 9, a2: 4 };
  room.finished = { a1: true, a2: true };

  await engine._resolveFromScores(io, supabase, roomId);
  await new Promise(r => setTimeout(r, 40));

  const result = emitted.find(e => e.ev === 'tower_result');
  assert.equal(result.payload.isDraw, false);
  assert.equal(result.payload.winnerId, 'w');
  assert.ok(rpcs.some(r => r.name === 'increment_win'), 'the winner was not credited a win');
  assert.ok(rpcs.some(r => r.name === 'increment_loss'), 'the loser was not credited a loss');

  engine.deleteTowerRoom(roomId);
});
