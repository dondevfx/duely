// The app shell's fixed sidebars and <main>'s offsets have to agree.
//
// They did not. LeftSidebar is w-60 (240px) and main was md:left-56 (224px), so
// 16px of every page sat underneath the sidebar. Usually invisible — the
// sidebar is opaque and z-30, so it painted over the strip — which is what made
// this survive so long. It showed up wherever page content was ALSO z-30:
// main comes after aside in the DOM, so a z-30 tie is won by the page, and the
// strip appeared on top of the sidebar.
//
// That is one cause behind three separate reports: the games' bottom-left help
// button (z-30) sitting on the sidebar edge, Tower's countdown overlay (z-30)
// spilling black over the sidebar, and the button looking clipped.
//
// Arithmetic, not eyeballing: Tailwind's scale is 0.25rem per step at 16px, so
// left-56 = 14rem = 224px and w-60 = 15rem = 240px.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');

const APP  = read('App.jsx');
const LEFT = read('components', 'LeftSidebar.jsx');
const CHAT = read('components', 'ChatSidebar.jsx');

const REM_PX  = 16;
const toPx    = (step) => (Number(step) / 4) * REM_PX;

function mainClasses() {
  const at = APP.indexOf('<main className={`');
  assert.notEqual(at, -1, 'the <main> shell is gone');
  return APP.slice(at, APP.indexOf('`}', at));
}

function widthOf(src, name) {
  const m = src.match(/<aside className=\{?[`"]([^`"]*)/);
  assert.ok(m, `${name} has no aside className`);
  const w = m[1].match(/\bw-(\d+)\b/);
  assert.ok(w, `${name} has no w-N width`);
  return { step: w[1], px: toPx(w[1]) };
}

test('main clears the left sidebar exactly', () => {
  const sidebar = widthOf(LEFT, 'LeftSidebar');
  const offset  = mainClasses().match(/\bmd:left-(\d+)\b/);
  assert.ok(offset, 'main has no md:left-N offset');
  assert.equal(toPx(offset[1]), sidebar.px,
    `main starts at ${toPx(offset[1])}px against a ${sidebar.px}px sidebar — ` +
    `the difference sits underneath it, and any z-30 content shows through`);
});

test('main clears the chat sidebar exactly', () => {
  const chat   = widthOf(CHAT, 'ChatSidebar');
  const offset = mainClasses().match(/\blg:right-(\d+)\b/);
  assert.ok(offset, 'main has no lg:right-N offset');
  assert.equal(toPx(offset[1]), chat.px,
    `main ends ${toPx(offset[1])}px from the right against a ${chat.px}px chat panel`);
});

test('the sidebars are still fixed and full height', () => {
  // The offsets above only mean anything if the sidebars are out of flow.
  for (const [src, name] of [[LEFT, 'LeftSidebar'], [CHAT, 'ChatSidebar']]) {
    const cls = src.match(/<aside className=\{?[`"]([^`"]*)/);
    assert.ok(cls, `${name} has no aside className`);
    assert.match(cls[1], /\bfixed\b/,
      `${name} must be fixed, or main should not be offset for it at all`);
  }
});
