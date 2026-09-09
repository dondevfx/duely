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

test('the bar carries five destinations, in order', () => {
  // Five, and that is the ceiling. On the narrowest phone in use each target
  // is still about 65px across, comfortably past the 44px a fingertip needs;
  // a sixth would take it under.
  //
  // Profile is here AND on the avatar in the top bar. That duplication is
  // deliberate: the avatar is a 30px target in a corner, and this is where
  // people look for their own things.
  const items = [...NAV.matchAll(/\{ ui: '([a-z]+)',\s+label: '([^']+)',\s+to: '([^']+)' \}/g)]
    .map(m => ({ ui: m[1], label: m[2], to: m[3] }));
  assert.deepEqual(items.map(i => i.ui),
    ['home', 'rewards', 'leaderboard', 'wallet', 'profile'],
    'the bar changed shape');
  assert.deepEqual(items.map(i => i.to),
    ['/', '/rewards', '/leaderboard', '/wallet', '/profile']);
  assert.ok(items.length <= 5, 'a sixth target takes each one under a fingertip');
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
  // Signed in, the account is the avatar in the top-right corner. Signed out
  // there is nothing to reach — that corner holds Login and Sign up already.
  assert.match(NAVBAR, /aria-label="Your profile"/,
    'nothing in the top bar reaches the account any more');
  assert.match(NAVBAR, /to="\/profile"/);
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
  // Only where the bar actually renders. It is unconditional no longer: on a
  // game route the bar is hidden, and reserving its 56px anyway made every
  // game page — all asking for min-h-[calc(100dvh-3.5rem)] — taller than the
  // box it sits in, which is what clipped the bet screen at both ends.
  assert.match(APP, /barShows \? 'bottom-14' : 'bottom-0'\} md:bottom-0/,
    'main must stop where the bar starts, on phones, and only when there is one');
  assert.match(APP, /const barShows = useShowsBottomNav\(location\.pathname\)/,
    'the inset must ask the same hook the bar does');
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

// ── One account control, not two ───────────────────────────────────────────

test('the phone shows the account once, in the top right', () => {
  // Two avatars: the phone's and the desktop's. Both visible at once is two
  // pictures of the same person in one bar, and one of them is ignored.
  //
  // It started in the slot the hamburger vacated, on the LEFT — which is where
  // a menu lives, not a person. A phone puts the account in the right-hand
  // corner, so that is where it went.
  const right = NAVBAR.slice(NAVBAR.indexOf('{/* Right — avatar'));
  assert.match(right, /<Link to="\/profile" className="hidden md:flex/,
    'the desktop avatar still shows on phones');
  const phone = NAVBAR.slice(NAVBAR.indexOf('{/* The account, top right.'),
                             NAVBAR.indexOf('{/* Right — avatar'));
  assert.match(phone, /md:hidden/, 'the phone avatar shows on desktop too');
  assert.match(phone, /aria-label="Your profile"/, 'nothing on a phone reaches the account');
  // After the logo, or it renders on the left again.
  assert.ok(NAVBAR.indexOf('{/* The account, top right.') > NAVBAR.indexOf('{/* Logo'),
    'the phone avatar is back before the logo, which puts it on the left');
});

test('the avatar is passed the props Avatar actually takes', () => {
  // It takes avatarUrl and a className. Passed url and size — which is what
  // the first version did — it renders the fallback initial at the default
  // size and silently never shows anyone's picture.
  const phone = NAVBAR.slice(NAVBAR.indexOf('{/* The account, top right.'),
                             NAVBAR.indexOf('{/* Right — avatar'));
  const tag = phone.slice(phone.indexOf('<Avatar'), phone.indexOf('/>', phone.indexOf('<Avatar')));
  assert.match(tag, /avatarUrl=\{profile\.avatar_url\}/, 'the picture never loads');
  assert.match(tag, /className=/, 'no size — Avatar has no size prop');
  assert.ok(!/\bsize=\{/.test(tag), 'size is not a prop Avatar reads');
  assert.ok(!/\burl=\{/.test(tag), 'the prop is avatarUrl, not url');
});
