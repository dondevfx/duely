// Win streaks on the result card, for PvP.
//
// The streak was recorded correctly in all seven games the whole time — the
// profile badge, the chat flame and the leaderboard were right. What was
// broken was telling the player: four of the seven never showed the
// "N Win Streak!" line, in four different ways.
//
//   Color Rush, Rush Hour   applyMatchStreaks ran AFTER the emit had left
//   Block Burst             emitted a hard-coded winnerStreak: 0
//   Tower                   sent the right value; the page never read it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eng = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
const page = (f) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The result payload built by the PvP settle path.
//
// Not the first emit in the file: most of these games emit the same event from
// their SOLO path too, which comes first and carries no streak. Reading the
// first match tested the wrong payload — the third time this session that a
// first-match scan has looked at the wrong branch.
function resolveBody(code) {
  const at = code.indexOf('async function _resolve(io');
  return at === -1 ? code : code.slice(at);
}

const ENGINES = {
  colorRushEngine:  'color_rush_result',
  carDashEngine:    'car_dash_result',
  blockBlastEngine: 'block_blast_result',
  towerEngine:      'tower_result',
  wordleEngine:     'wordle_result',
  coinFlipEngine:   'coin_flip_result',
  blackjackEngine:  'bj_result',
};

test('every game sends the streak with the result', () => {
  for (const [file, event] of Object.entries(ENGINES)) {
    const code = resolveBody(strip(eng(`${file}.js`)));
    const at = code.indexOf(`emit('${event}'`);
    assert.ok(at > 0, `${file} never emits ${event} from its settle path`);
    // The settle body, not a window after the emit: Word VS builds its payload
    // in a resultFor() helper defined just ABOVE the emit and passes it by
    // name, so everything after the emit is empty. The ordering test below is
    // what pins compute-before-send.
    assert.match(code, /winnerStreak/, `${file} does not send winnerStreak`);
    assert.ok(!/winnerStreak: 0[,\s]/.test(code),
      `${file} sends a hard-coded zero — the placeholder nobody replaced`);
  }
});

test('the streak is resolved before the result is sent', () => {
  // Computing it afterwards is why two games had nothing to show: the emit had
  // already left with whatever the local still held.
  for (const [file, event] of Object.entries(ENGINES)) {
    const code = resolveBody(strip(eng(`${file}.js`)));
    const applied = code.lastIndexOf('applyMatchStreaks(supabase');
    const emitted = code.indexOf(`emit('${event}'`);
    if (applied === -1 || emitted === -1) continue;
    assert.ok(applied < emitted,
      `${file} works the streak out after the result has already been sent`);
  }
});

test('the streak is counted once, not twice', () => {
  // applyMatchStreaks INCREMENTS. Moving the call above the emit and leaving
  // the old one in place would have counted every win twice — a much worse
  // bug than the one being fixed.
  for (const file of Object.keys(ENGINES)) {
    const code = strip(eng(`${file}.js`));
    const calls = (code.match(/applyMatchStreaks\(supabase/g) || []).length;
    assert.equal(calls, 1, `${file} calls applyMatchStreaks ${calls} times`);
  }
});

test('every page passes it to the card', () => {
  for (const f of ['ColorRushGame.jsx', 'CarDashGame.jsx', 'TowerGame.jsx',
                   'BlockBlastGame.jsx', 'WordleGame.jsx', 'CoinFlipGame.jsx', 'BlackjackGame.jsx']) {
    assert.match(page(f), /winnerStreak=\{/, `${f} drops the streak on the floor`);
  }
});

// ── Driven ────────────────────────────────────────────────────────────────

test('a real PvP Tower win sends the streak it just recorded', async () => {
  const engine = require('../src/services/towerEngine');
  const emitted = [];
  const io = { emit() {}, to: () => ({ emit: (ev, p) => emitted.push({ ev, p }) }) };

  let streakCalls = 0;
  const chain = (d) => new Proxy(Promise.resolve({ data: d, error: null }), {
    get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => chain(d)),
  });
  const supabase = {
    rpc: async (name) => {
      // update_win_streak is what applyMatchStreaks calls; the count proves it
      // ran exactly once.
      if (name === 'update_win_streak') { streakCalls++; return { data: 4, error: null }; }
      return { data: null, error: null };
    },
    from: () => ({
      insert: async () => ({ error: null }),
      select: () => chain([{ wins: 9 }]),
      update: () => chain([]),
    }),
  };

  const p1 = { socketId: 'w1', userId: 'winner', username: 'Ann', entryFee: 0, currency: 'coins' };
  const p2 = { socketId: 'l1', userId: 'loser',  username: 'Bob', entryFee: 0, currency: 'coins' };
  const { roomId } = engine.createDirectTowerRoom(p1, p2);
  const room = engine.getTowerRoom(roomId);
  room.state = 'active';
  room.scores = { w1: 12, l1: 5 };
  room.finished = { w1: true, l1: true };

  await engine._resolveFromScores(io, supabase, roomId);
  await new Promise(r => setTimeout(r, 40));

  const result = emitted.find(e => e.ev === 'tower_result');
  assert.ok(result, 'no result emitted');
  assert.equal(result.p.winnerStreak, 4, 'the streak did not reach the payload');
  assert.equal(streakCalls, 1, `the streak was applied ${streakCalls} times`);

  engine.deleteTowerRoom(roomId);
});

test('a drawn PvP match touches no streak', async () => {
  // Established when draws were added; asserted here so moving the call did
  // not quietly undo it.
  const engine = require('../src/services/towerEngine');
  const io = { emit() {}, to: () => ({ emit() {} }) };
  let streakCalls = 0;
  const chain = (d) => new Proxy(Promise.resolve({ data: d, error: null }), {
    get: (t, k) => (k in t ? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) : () => chain(d)),
  });
  const supabase = {
    rpc: async (name) => { if (name === 'update_win_streak') streakCalls++; return { data: null, error: null }; },
    from: () => ({ insert: async () => ({ error: null }), select: () => chain([]), update: () => chain([]) }),
  };

  const p1 = { socketId: 'd1', userId: 'a', username: 'A', entryFee: 0, currency: 'coins' };
  const p2 = { socketId: 'd2', userId: 'b', username: 'B', entryFee: 0, currency: 'coins' };
  const { roomId } = engine.createDirectTowerRoom(p1, p2);
  const room = engine.getTowerRoom(roomId);
  room.state = 'active';
  room.scores = { d1: 6, d2: 6 };
  room.finished = { d1: true, d2: true };

  await engine._resolveFromScores(io, supabase, roomId);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(streakCalls, 0, 'a draw moved a streak');

  engine.deleteTowerRoom(roomId);
});
