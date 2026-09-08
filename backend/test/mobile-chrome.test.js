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

test('the bar is on the bet screen and not on the game', () => {
  // A game ROUTE is two different screens. The bet screen wants the bar; the
  // game itself would have it sitting on top of the board. The path cannot
  // tell them apart — both are /game/<slug> — so the screen says so.
  assert.match(BOTTOM, /export function useShowBottomBar/,
    'a bet screen has no way to ask for the bar');
  assert.match(BOTTOM, /export function useShowsBottomNav/, 'nothing decides');

  const decide = BOTTOM.slice(BOTTOM.indexOf('export function useShowsBottomNav'),
                              BOTTOM.indexOf('export default'));
  assert.ok(decide.includes(String.raw`/^\/game`),
    'the default must still be off for a game route');
  assert.match(decide, /asked \|\| 0\) > 0/,
    'a screen asking for the bar is what turns it back on');

  // Default OFF, not on. A game that forgets to opt out would otherwise have a
  // bar over its board, which is the worse of the two failures.
  const returns = decide.match(/return [^;]+;/g) || [];
  assert.match(returns[0], /return true/, 'a non-game path keeps its bar');
  assert.match(returns[1], /asked/, 'a game path must ask');
});

test('every bet screen asks for the bar, and only while it is showing', () => {
  for (const [label, src, cond] of [
    ['GameLobby',  LOBBY, /useShowBottomBar\(true\)/],
    ['Coin Flip',  read('..', 'src', 'pages', 'CoinFlipGame.jsx'),  /useShowBottomBar\(phase === 'lobby'\)/],
    ['Blackjack',  read('..', 'src', 'pages', 'BlackjackGame.jsx'), /useShowBottomBar\(phase === 'lobby'\)/],
  ]) {
    assert.match(src, cond, `${label} does not ask for the bar on its bet screen`);
  }
  // GameLobby only ever renders as the bet screen, so it can ask flatly. The
  // other two share a file with the game and must ask on the phase, or the bar
  // follows them into it.
  const cf = read('..', 'src', 'pages', 'CoinFlipGame.jsx');
  assert.ok(!/useShowBottomBar\(true\)/.test(cf),
    'Coin Flip asks unconditionally, so the bar stays up during the flip');
});

test('the request is counted, not a boolean', () => {
  // Two screens mounting across a transition: the second asks before the first
  // unmounts. A boolean would be left off by the departing screen; a count is
  // still positive.
  const provider = BOTTOM.slice(BOTTOM.indexOf('export function BottomBarProvider'),
                                BOTTOM.indexOf('export function useShowBottomBar'));
  assert.match(provider, /useState\(0\)/, 'the request is a boolean');
  const hook = BOTTOM.slice(BOTTOM.indexOf('export function useShowBottomBar'),
                            BOTTOM.indexOf('export function useShowsBottomNav'));
  assert.match(hook, /setAsked\(n => n \+ 1\)/, 'mounting must add a request');
  assert.match(hook, /setAsked\(n => n - 1\)/, 'unmounting must drop it again');
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
  assert.match(APP, /import BottomNav, \{ BottomBarProvider, useShowsBottomNav \}/,
    'App decides the inset without asking the bar');
  assert.match(APP, /barShows \? 'bottom-14' : 'bottom-0'/,
    'the scroll area still reserves the bar height everywhere');
  assert.match(APP, /const barShows = useShowsBottomNav\(location\.pathname\)/,
    'the inset must ask the same hook the bar does');
  assert.match(APP, /<BottomBarProvider>/, 'nothing provides the shared answer');
  assert.match(BOTTOM, /export function useShowsBottomNav/, 'there is no shared answer');
  assert.match(BOTTOM, /if \(!showsNav\) return null;/,
    'the bar itself must use the same hook it exports');
});
