// The phone's main navigation.
//
// Phones reached everything through a hamburger: a tap to open a full-screen
// menu, a tap to choose, and the four places people actually go were two taps
// deep and invisible until you opened it. Those four are a fixed bar now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fe = (...p) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');

const NAV    = fe('components', 'BottomNav.jsx');
const NAVBAR = fe('components', 'Navbar.jsx');
const APP    = fe('App.jsx');
const SIDE   = fe('components', 'LeftSidebar.jsx');

test('the bar carries the four destinations, in order', () => {
  const items = [...NAV.matchAll(/to: '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(items, ['/', '/rewards', '/leaderboard', '/wallet']);
});

test('it is phones only', () => {
  // From md up the left sidebar is permanently visible and already does this.
  // Two navigations on screen at once is one of them being ignored.
  assert.match(NAV, /md:hidden/);
});

test('nothing is stranded by removing the hamburger', () => {
  // The drawer held four nav entries, the game list, and an account section.
  // The four are the bar. The games are the home screen. The account is the
  // avatar in the top bar, which is where a phone expects it — and sign out
  // lives on the profile page.
  assert.ok(!/aria-label="Menu"/.test(NAVBAR), 'the hamburger is still there');
  assert.ok(!/mobileMenuOpen/.test(NAVBAR), 'the drawer state outlived the drawer');
  assert.match(NAVBAR, /aria-label=\{profile \? 'Your profile' : 'Sign in'\}/,
    'nothing in the top bar reaches the account any more');
  assert.match(NAVBAR, /to=\{profile \? '\/profile' : '\/login'\}/);
});

test('the drawer left nothing behind', () => {
  // Lists nothing renders are one more thing to keep in step for no reason,
  // and they were the reason three separate tests asserted an ordering the
  // navbar no longer has any way to show.
  for (const gone of ['NAV_LINKS', 'GAME_LINKS', 'playerCounts']) {
    assert.ok(!new RegExp(gone).test(NAVBAR), `${gone} is dead code now`);
  }
});

test('the bar sits below the scroll area, not over the end of it', () => {
  // Page padding would leave the last row under a translucent bar on any page
  // that forgot to add it. Shortening the scroll container cannot be forgotten.
  assert.match(APP, /bottom-14 md:bottom-0/,
    'main must stop where the bar starts, on phones only');
  assert.match(APP, /<BottomNav \/>/, 'the bar is never mounted');
});

test('it clears the home indicator', () => {
  // Without the inset the labels sit under the gesture bar on any modern
  // iPhone — which is exactly where a bottom bar goes.
  assert.match(NAV, /env\(safe-area-inset-bottom/);
});

test('the taps are big enough to hit without looking', () => {
  assert.match(NAV, /h-14/, 'a bottom bar shorter than 44px is a row of small targets');
  assert.match(NAV, /flex-1/, 'the items must share the width evenly');
  assert.match(NAV, /touchAction: 'manipulation'/, 'the double-tap-zoom delay must be off');
});

test('the active destination is obvious', () => {
  // A bar that looks the same everywhere tells you nothing about where you are.
  assert.match(NAV, /isActive \? 'text-primary'/);
});

test('it is a nav, and it says which one', () => {
  assert.match(NAV, /<nav[\s\S]*?aria-label="Main"/);
});

// ── Tipping ────────────────────────────────────────────────────────────────

test('Tip is not a menu entry any more', () => {
  // Tipping is something you do TO a person, so it belongs on the person. As a
  // nav item it opened a page asking you to type a username you had just been
  // looking at.
  for (const [name, src] of [['sidebar', SIDE], ['navbar', NAVBAR], ['bottom bar', NAV]]) {
    assert.ok(!/ui: 'tip'/.test(src), `${name} still lists Tip as a destination`);
  }
});

test('tipping is still reachable from a profile', () => {
  // Removing the entry must not remove the feature.
  const chat = fe('components', 'ChatSidebar.jsx');
  assert.match(chat, /handleTip/, 'the profile popup can no longer tip');
});

// ── The rewards icon ───────────────────────────────────────────────────────

test('rewards is a present, not a dartboard', () => {
  // Concentric rings around a bullseye read as targets or accuracy. Rewards
  // here are a daily gift and a spin.
  const icons = fe('components', 'UiIcon.jsx');
  const fn = icons.slice(icons.indexOf('rewards: () => ('), icons.indexOf('profile: () => ('));
  assert.match(fn, /<rect/, 'a present needs a box');
  assert.ok(!/<circle/.test(fn), 'the dartboard rings are still there');
  assert.match(fn, /M12 6\.8v13\.4/, 'the ribbon down the front is missing');
});
