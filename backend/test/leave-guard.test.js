// Leaving a game, from the client's side.
//
// There are four ways out and they do not all look the same to the browser:
// refresh fires beforeunload, closing a tab fires pagehide, in-app navigation
// fires NOTHING (the socket stays connected, so unmount is the only signal),
// and quitting outright leaves it to the server's disconnect grace.
//
// Each game had its own copy of this, which is how they drifted. They share one
// hook now, so "all games behave the same" is structural rather than a promise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');

const GAMES = ['TowerGame', 'CarDashGame', 'BlockBlastGame', 'WordleGame', 'BlackjackGame', 'CoinFlipGame'];

test('every game forfeits through the shared guard', () => {
  for (const g of GAMES) {
    const src = read('pages', `${g}.jsx`);
    assert.match(src, /useLeaveGuard\(/, `${g} does not forfeit on leave`);
  }
});

test('no game keeps its own copy of the leave handling', () => {
  // Six hand-rolled copies is how one of them ends up missing a case — and how
  // all six ended up missing the persisted check.
  //
  // The property is that the forfeit EMIT lives in one place. Games may still
  // listen to pagehide for their own reasons (Rush Hour restores the scroll
  // lock on it), so forbidding the event outright would be wrong; what must not
  // come back is a second place that decides when to forfeit.
  for (const g of GAMES) {
    const src = read('pages', `${g}.jsx`);
    assert.ok(!/emit\(\s*'player_forfeit'/.test(src),
      `${g} emits player_forfeit itself — that decision belongs to useLeaveGuard alone`);
    assert.ok(!/addEventListener\('beforeunload'/.test(src),
      `${g} still wires its own beforeunload — it will drift from the others`);
  }
});

// ── The case that must NOT forfeit ─────────────────────────────────────────
//
// pagehide fires when a page enters the back/forward cache — switching apps on
// iOS, or a back navigation. Nothing checked `persisted`, so backgrounding
// Safari mid-match forfeited a live game. Taking a phone call lost the stake.

test('going into the background is not treated as leaving', () => {
  const src = read('hooks', 'useLeaveGuard.js');
  assert.match(src, /persisted/,
    'without checking persisted, an app switch on iOS forfeits a live match');

  // Specifically: the forfeit must be gated on it, not merely mentioned.
  const handler = src.slice(src.indexOf('onPageHide'));
  assert.match(handler, /if\s*\(\s*!\s*e\.persisted\s*\)/,
    'the forfeit must run only when the page is genuinely going away');
});

test('switching tabs is not treated as leaving either', () => {
  // The match is still running and the clock is server-side, so a tab switch
  // is a player looking away, not a player leaving.
  const src = read('hooks', 'useLeaveGuard.js');
  assert.ok(!/addEventListener\('visibilitychange'/.test(src),
    'listening to visibilitychange would forfeit on a tab switch');
});

// ── The case that MUST forfeit ─────────────────────────────────────────────

test('in-app navigation forfeits on unmount', () => {
  const src = read('hooks', 'useLeaveGuard.js');
  const cleanup = src.slice(src.indexOf('return () => {'));
  assert.match(cleanup, /forfeit\(\)/,
    'clicking a link inside the site fires no browser event — unmount is the only notice the server gets');
});

test('a real unload still forfeits', () => {
  const src = read('hooks', 'useLeaveGuard.js');
  assert.match(src, /addEventListener\('beforeunload', forfeit\)/, 'refresh must forfeit');
  assert.match(src, /addEventListener\('pagehide', onPageHide\)/, 'closing the tab must forfeit');
});

// ── Why the socket is held in a ref ────────────────────────────────────────

test('the guard cannot fire a forfeit mid-match', () => {
  // Tower keyed this effect on [socket]. If the socket identity ever changes
  // during a match, the cleanup runs — forfeiting a game the player is still
  // playing. A ref plus an empty dependency list makes that impossible.
  const src = read('hooks', 'useLeaveGuard.js');
  assert.match(src, /useRef\(/, 'the socket must be held in a ref');
  const effect = src.slice(src.indexOf('useEffect('));
  assert.match(effect, /\}, \[\]\);/,
    'the effect must have an empty dependency list, or its cleanup fires mid-match');
});
