// Three things about the phone layout.
//
// The bottom bar, the account avatar, and what happens when the bet screen's
// "more ways to play" arrow is pressed. All three are things you only notice
// on a phone, which is where they were wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');

const NAV    = read('components', 'Navbar.jsx');
const BOTTOM = read('components', 'BottomNav.jsx');
const LOBBY  = read('components', 'GameLobby.jsx');
const APP    = read('App.jsx');

// ── The bottom bar ─────────────────────────────────────────────────────────

test('the bottom bar never covers a game', () => {
  // It is fixed at the bottom of the viewport at z-40, so on a game screen it
  // sits on top of what is being played — over Block Burst's board, over the
  // tap target in Color Rush — and on a bet screen it covers the buttons the
  // screen exists for.
  assert.match(BOTTOM, /useLocation/, 'the bar cannot know where it is');
  assert.match(BOTTOM, /return null/, 'nothing ever hides it');
  // The pattern lives in showsBottomNav now, which App.jsx reads too.
  const guard = BOTTOM.slice(BOTTOM.indexOf('export function showsBottomNav'),
                             BOTTOM.indexOf('export default'));
  assert.ok(guard.includes(String.raw`/^\/game`), 'the guard must match the /game/ prefix');
  const body = BOTTOM.slice(BOTTOM.indexOf('export default function BottomNav'));
  assert.ok(body.indexOf('return null') > 0 && body.indexOf('return null') < body.indexOf('return ('),
    'the guard must come before the render');
});

test('the guard is a prefix, so a new game is covered the day it ships', () => {
  // Every game route lives under /game/. Matching a list of slugs means the
  // next one added is uncovered until somebody notices on a phone.
  const slugs = [...APP.matchAll(/path="\/game\/([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(slugs.length >= 8, `only found ${slugs.length} game routes`);
  const guard = BOTTOM.slice(BOTTOM.indexOf('export function showsBottomNav'),
                             BOTTOM.indexOf('export default'));
  for (const slug of slugs) {
    assert.ok(!guard.includes(slug),
      `the guard names '${slug}' — a list goes stale, the prefix does not`);
  }
  // And the prefix must not swallow the games INDEX, which is a normal page.
  // The pattern is lifted OUT of the source and run. The first version built
  // a RegExp from a hardcoded string, so it only ever tested the literal
  // written here — it passed just the same when the guard in the component was
  // loosened to one that hides the bar on /games too.
  const src = BOTTOM.match(/return !(\/.+?\/)\.test\(pathname\);/);
  assert.ok(src, 'no pathname guard found to test');
  const re = new RegExp(src[1].slice(1, -1));
  assert.ok(re.test('/game/block-blast'), 'a game route must match');
  assert.ok(re.test('/game/tower'), 'and every other one');
  assert.ok(!re.test('/games'), 'the games list is not a game and must keep its bar');
  assert.ok(!re.test('/'), 'home must keep its bar');
});

// ── The account avatar ─────────────────────────────────────────────────────

test('the account sits in the top right on a phone', () => {
  // A phone puts the account in the right-hand corner. It was on the left,
  // where the hamburger used to be — which is where a MENU lives, not a
  // person.
  const mobileAvatar = NAV.indexOf('aria-label="Your profile"');
  assert.ok(mobileAvatar > 0, 'the phone account link is gone');
  const logo = NAV.indexOf('{/* Logo');
  assert.ok(logo > 0 && mobileAvatar > logo,
    'the avatar still renders before the logo, which puts it on the left');
});

test('signed out, the corner is not two ways to the same place', () => {
  // Signed out the corner already holds Login and Sign up. An avatar-shaped
  // third route to the same screen rendered between the balance slot and those
  // buttons — measured at x=202 of a 375px viewport, which is not a corner.
  const block = NAV.slice(NAV.indexOf('{/* The account, top right.'),
                          NAV.indexOf('{/* Right — avatar'));
  assert.match(block, /\{profile && \(/, 'the phone avatar renders when signed out');
  assert.ok(!/to=\{profile \? '\/profile' : '\/login'\}/.test(block),
    'it still falls back to a sign-in link instead of not rendering');
});

// ── Opening "more ways to play" ────────────────────────────────────────────

test('opening the panel brings it into view, on every bet screen', () => {
  // The toggle sits near the bottom of the screen, so on a phone the options
  // it reveals unfold BELOW the fold: the arrow flips, the layout grows, and
  // nothing appears to have happened.
  //
  // One hook, not three copies. There are three bet screens — the shared
  // GameLobby, and Coin Flip and Blackjack which build their own — and the
  // first version of this fix went into GameLobby alone, so the screen that
  // prompted it was the one screen still broken.
  const MORE = read('components', 'MoreWays.jsx');
  assert.match(MORE, /export function useRevealOnOpen/, 'the behaviour is not shared');

  const hook = MORE.slice(MORE.indexOf('export function useRevealOnOpen'));
  assert.match(hook, /^\s*ref\.current\?\.scrollIntoView\(\{/m,
    'nothing scrolls, or the call is disabled in place');
  assert.match(hook, /block: 'end'/,
    "block:'start' would push the stake off the top; the panel is the last thing on screen");
  assert.match(hook, /requestAnimationFrame/,
    'without a frame the panel has no height yet and the scroll lands short');
  assert.match(hook, /if \(!open\) return/, 'closing it must not scroll too');
  assert.match(hook, /prefers-reduced-motion/,
    'a smooth scroll is motion, and some people have asked for none');

  // And every screen with a toggle uses it.
  for (const [label, src] of [
    ['GameLobby',  LOBBY],
    ['Coin Flip',  read('..', 'src', 'pages', 'CoinFlipGame.jsx')],
    ['Blackjack',  read('..', 'src', 'pages', 'BlackjackGame.jsx')],
  ]) {
    assert.match(src, /MoreWaysToggle/, `${label} has no toggle`);
    assert.match(src, /useRevealOnOpen\(moreOpen\)/, `${label} does not reveal its panel`);
    assert.match(src, /ref=\{moreRef\}/, `${label} never attaches the ref`);
  }
});

test('the panel is still only offered to a signed-in player', () => {
  // Not part of the change, but the reason the scroll could not be clicked
  // through in a browser without a session — worth pinning so a later edit
  // does not quietly expose bot and private-room buttons to a logged-out
  // visitor and call it a fix for this test being hard to run.
  assert.match(LOBBY, /\{session && \(onBot \|\| onBotFree \|\| onCreatePrivate\) && \(/,
    'the secondary options are no longer gated on having a session');
});

test('the scroll area does not reserve space for a bar that is not there', () => {
  // main is `bottom-14` on phones to hold the bar's height out of the scroll
  // area. On a game route the bar does not render, and reserving it anyway
  // made every game page — all of which ask for min-h-[calc(100dvh-3.5rem)] —
  // 56px taller than the box it sits in. Measured on a 390x844 phone after the
  // fix: scrollHeight equals clientHeight, so the bet screen no longer
  // overflows at all.
  //
  // Both decisions read the SAME function. Deciding separately is how they
  // came to disagree.
  assert.match(APP, /import BottomNav, \{ showsBottomNav \}/,
    'App decides the inset without asking the bar');
  assert.match(APP, /showsBottomNav\(location\.pathname\) \? 'bottom-14' : 'bottom-0'/,
    'the scroll area still reserves the bar height everywhere');
  assert.match(BOTTOM, /export function showsBottomNav/, 'there is no shared answer');
  assert.match(BOTTOM, /if \(!showsBottomNav\(pathname\)\) return null;/,
    'the bar itself must use the same function it exports');
});
