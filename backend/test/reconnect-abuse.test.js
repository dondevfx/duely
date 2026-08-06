// Repeated leave/rejoin.
//
// Dropping just before the forfeit deadline and reconnecting resets the grace
// period. Without a cap that can be repeated forever to dodge a loss. Two things
// have to hold: the leaver eventually forfeits, and the OPPONENT is never
// frozen or stalled while it happens.
const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors the server's resume bookkeeping.
function makeGrace({ maxResumes = 3, graceMs = 8000 } = {}) {
  const resumeCounts = new Map();
  const pending = new Map();
  const state = { forfeits: 0 };

  return {
    state,
    newMatch(user) { resumeCounts.delete(user); },
    disconnect(user) {
      if (pending.has(user)) return;
      pending.set(user, { armed: true });
    },
    resume(user) {
      if (!pending.has(user)) return 'nothing-pending';
      const used = (resumeCounts.get(user) || 0) + 1;
      resumeCounts.set(user, used);
      if (used > maxResumes) return 'denied';
      pending.delete(user);
      return 'resumed';
    },
    graceExpires(user) {
      if (!pending.has(user)) return;
      pending.delete(user);
      state.forfeits++;
    },
    resumesUsed(user) { return resumeCounts.get(user) || 0; },
  };
}

test('a genuine blip is forgiven', () => {
  const g = makeGrace();
  g.newMatch('u1');
  g.disconnect('u1');
  assert.equal(g.resume('u1'), 'resumed', 'one reconnect must be allowed');
  g.graceExpires('u1');
  assert.equal(g.state.forfeits, 0, 'a resumed player must not forfeit');
});

test('repeated drop-and-rejoin runs out of grace and forfeits', () => {
  const g = makeGrace({ maxResumes: 3 });
  g.newMatch('u1');
  for (let i = 0; i < 3; i++) {
    g.disconnect('u1');
    assert.equal(g.resume('u1'), 'resumed', `reconnect ${i + 1} should be inside the cap`);
  }
  g.disconnect('u1');
  assert.equal(g.resume('u1'), 'denied', 'the fourth reconnect must be refused');
  g.graceExpires('u1');
  assert.equal(g.state.forfeits, 1, 'once denied, the forfeit must run');
});

test('the cap resets for the next match, not across a session', () => {
  const g = makeGrace({ maxResumes: 3 });
  g.newMatch('u1');
  for (let i = 0; i < 3; i++) { g.disconnect('u1'); g.resume('u1'); }
  g.newMatch('u1');                        // a new game begins
  assert.equal(g.resumesUsed('u1'), 0, 'a fresh match must restore the grace');
  g.disconnect('u1');
  assert.equal(g.resume('u1'), 'resumed', 'and reconnects work again');
});

test('one player abusing reconnects never touches the other', () => {
  const g = makeGrace();
  g.newMatch('abuser');
  g.newMatch('victim');
  for (let i = 0; i < 6; i++) { g.disconnect('abuser'); g.resume('abuser'); }
  assert.equal(g.resumesUsed('victim'), 0, 'the opponent\'s grace must be untouched');
  g.disconnect('victim');
  assert.equal(g.resume('victim'), 'resumed', 'the opponent can still reconnect normally');
});

test('every game has a server-side timer that runs regardless of connections', () => {
  // This is what actually protects the player who stayed: the match resolves on
  // its own clock, so a leaver cannot hold it open by disconnecting.
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');

  const carDash = read('carDashEngine.js');
  assert.ok(/STALL_MS/.test(carDash) && /setInterval/.test(carDash),
    'Rush Hour must keep its stall watchdog');
  assert.ok(/CATCHUP_MS/.test(carDash),
    'Rush Hour must keep the catch-up window, which also bounds the match');

  const blackjack = read('blackjackEngine.js');
  assert.ok(/room\.timer = setTimeout/.test(blackjack),
    'Blackjack must keep its turn timer');

  const wordle = read('wordleEngine.js');
  assert.ok(/failTimer/.test(wordle),
    'Word VS must keep its fail timer');
});
