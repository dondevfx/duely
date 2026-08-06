// End conditions for Block Burst and Word VS.
//
// Blackjack is deliberately untouched — it already ends cleanly on its own 20s
// turn timer, and there is a check at the bottom that it stays that way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeLedger, makeIo, player } = require('./helpers/stubs');

const blockBlast = require('../src/services/blockBlastEngine');
const wordle     = require('../src/services/wordleEngine');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');

// ── Block Burst ────────────────────────────────────────────────────────────

test('Block Burst gives the chaser 15 seconds, not 30', () => {
  const s = src('blockBlastEngine.js');
  assert.ok(/const CATCHUP_MS = 15_000;/.test(s), 'the window must be 15s');
  assert.ok(!/}, 30000\);/.test(s), 'the old 30s timer must be gone');
  assert.ok(/seconds: CATCHUP_MS \/ 1000/.test(s),
    'the client must be told the same number the server enforces');
});

test('Block Burst and Rush Hour agree on the window length', () => {
  const bb = src('blockBlastEngine.js').match(/const CATCHUP_MS = ([\d_]+);/)[1];
  const cd = src('carDashEngine.js').match(/const CATCHUP_MS = ([\d_]+);/)[1];
  assert.equal(bb, cd, 'the two games must not teach different rules');
});

test('Block Burst ends the moment the chaser passes the target', async () => {
  const io = makeIo();
  const { supabase } = makeLedger();
  const { roomId } = blockBlast.createDirectBlockBlastRoom(player('a1', 'ua'), player('a2', 'ub'));
  const room = blockBlast.getBlockBlastRoom(roomId);
  room.state = 'active';

  // a1 finishes on 1000; a2 is behind and gets the window
  room.stuck.add('a1');
  room.scores['a1'] = 1000;
  room.catchupTarget = 1000;
  room.stuckTimer = setTimeout(() => {}, 60_000);
  room.pingScores['a2'] = 400;

  await blockBlast.checkBlockBlastOvertake(io, supabase, roomId);
  assert.equal(room.state, 'active', 'still behind — the match must continue');

  room.pingScores['a2'] = 1200;                       // passes the target
  await blockBlast.checkBlockBlastOvertake(io, supabase, roomId);
  assert.equal(room.stuckTimer, null, 'the window timer must be cleared on an overtake');
  assert.equal(room.state, 'finished', 'passing the target must end the match');

  blockBlast.deleteBlockBlastRoom(roomId);
});

// ── Word VS ────────────────────────────────────────────────────────────────

test('Word VS gives 90 seconds once a player is out of guesses', () => {
  const s = src('wordleEngine.js');
  assert.ok(/const FAIL_TIMER_MS = 90 \* 1000;/.test(s), 'the window must be 90s');
  assert.ok(/timeLimit: FAIL_TIMER_MS \/ 1000/.test(s),
    'the client must be shown the same number the server enforces, not a hardcoded 60');
  assert.ok(!/timeLimit: 60/.test(s), 'the old hardcoded 60 must be gone');
});

test('Word VS cannot hang when both players idle', () => {
  const s = src('wordleEngine.js');
  assert.ok(/IDLE_LIMIT_MS/.test(s), 'there must be an inactivity cap');
  assert.ok(/function _armIdle/.test(s), 'and something that arms it');
  // It has to be reset by real play, or a slow thinker gets cut off.
  const guessBody = s.slice(s.indexOf('async function handleWordleGuess'));
  assert.ok(/_armIdle\(/.test(guessBody.slice(0, 3000)),
    'an accepted guess must push the inactivity cap back');
});

test('Word VS arms the idle cap when the match starts', () => {
  const s = src('wordleEngine.js');
  const startBody = s.slice(s.indexOf('function startWordleGame'), s.indexOf('function startWordleGame') + 1200);
  assert.ok(/_armIdle\(/.test(startBody), 'the cap must be armed at kickoff');
});

test('Word VS clears its timers when the match settles', () => {
  const s = src('wordleEngine.js');
  const settle = s.slice(s.indexOf('async function _settleWordle'),
                         s.indexOf('async function _settleWordle') + 600);
  assert.ok(/failTimer\)/.test(settle) && /idleTimer\)/.test(settle),
    'both timers must be cleared on settle so none fires into a finished room');
});

// ── Blackjack, left alone ──────────────────────────────────────────────────

test('Blackjack still ends on its own turn timer and gained no catch-up window', () => {
  const s = src('blackjackEngine.js');
  assert.ok(/room\.timer = setTimeout\(/.test(s), 'the 20s turn timer must remain');
  assert.ok(/}, 20000\);/.test(s), 'and still be 20 seconds');
  assert.ok(!/CATCHUP_MS/.test(s), 'Blackjack was explicitly not to get a catch-up window');
});
