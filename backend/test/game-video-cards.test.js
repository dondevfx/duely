// The square game cards, and the video clips they show.
//
// Home.jsx and Games.jsx used to each keep their own copy of the game list —
// title, icon, route, description — with wording that had already drifted
// apart between the two. They now both read from one shared data/games.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');

const GAMES_DATA = read('data', 'games.js');
const CARD       = read('components', 'GameVideoCard.jsx');
const HOME       = read('pages', 'Home.jsx');
const GAMES_PAGE = read('pages', 'Games.jsx');

test('every listed game has a slug, a route and a title', () => {
  const entries = [...GAMES_DATA.matchAll(/slug:\s*'([a-z-]+)'/g)].map(m => m[1]);
  assert.equal(entries.length, 7, 'all seven games must be listed');
  for (const slug of entries) {
    assert.match(GAMES_DATA, new RegExp(`slug:\\s*'${slug}'[\\s\\S]{0,150}?route:\\s*'/game/`),
      `${slug} has no route near its slug`);
  }
});

test('the description field is gone from the shared game list', () => {
  // The whole point of this change: a video takes over the job the
  // description text used to do, so the text goes away rather than sitting
  // unused in the data.
  assert.ok(!/description:/.test(GAMES_DATA),
    'a description field left in data/games.js is dead weight nothing reads');
});

test('both pages read the shared list rather than keeping their own', () => {
  for (const [name, src] of [['Home.jsx', HOME], ['Games.jsx', GAMES_PAGE]]) {
    assert.match(src, /from ['"]\.\.\/data\/games['"]/, `${name} must import GAMES`);
    // And must not have grown a second, competing list of its own.
    assert.ok(!/title:\s*'Quick Match'/.test(src),
      `${name} appears to define its own game list again`);
  }
});

test('the card is a square at every breakpoint, not just desktop', () => {
  assert.match(CARD, /aspect-square/);
  // No sm:/md:/lg: variant overriding it back to a non-square shape.
  assert.ok(!/[a-z]+:aspect-(?!square)/.test(CARD),
    'a breakpoint-specific aspect override would make mobile and desktop disagree on the shape');
});

test('the clip is looked up by slug, not hardcoded per game', () => {
  assert.match(CARD, /`\/game-clips\/\$\{slug\}\.mp4`/);
  assert.match(CARD, /`\/game-clips\/\$\{slug\}\.jpg`/);
});

test('a clip can be told which edge is safe to crop, per game', () => {
  // A square card cropping a non-square recording always loses something off
  // two opposite edges — there is no universal safe side, only what happens
  // to be near the edge of a given clip. clipPosition lets one game override
  // the default center crop without affecting any other.
  assert.match(GAMES_DATA, /clipPosition:/, 'no game currently overrides the crop — is that still true?');
  assert.match(CARD, /objectPosition:\s*clipPosition/,
    'the override must reach the actual CSS object-position, not just exist in the data');
});

test('the poster and the video crop the same way', () => {
  // If only one of them reads clipPosition, the still frame jumps to a
  // different crop the instant playback takes over.
  //
  // Anchored on the real ELEMENTS (attribute follows on the next line), not
  // the bare substring "<img" / "<video" — a first version of this test
  // matched those same words inside a comment above each real tag, which put
  // the slice before either element and passed with clipPosition removed.
  const imgAt   = CARD.search(/<img\s*\n/);
  const videoAt = CARD.search(/<video\s*\n/);
  assert.notEqual(imgAt, -1, 'the poster <img> element is gone');
  assert.notEqual(videoAt, -1, 'the <video> element is gone');

  const imgBlock   = CARD.slice(imgAt, CARD.indexOf('/>', imgAt));
  const videoBlock = CARD.slice(videoAt, CARD.indexOf('/>', videoAt));
  assert.match(imgBlock,   /clipPosition/, 'the poster must honour clipPosition too');
  assert.match(videoBlock, /clipPosition/, 'the video must honour clipPosition too');
});

test('iOS cannot hijack the clip into fullscreen', () => {
  // Without playsInline specifically, Safari on iOS takes an autoplaying
  // video fullscreen the instant it starts instead of playing inside the card.
  assert.match(CARD, /playsInline/);
});

test('the clip is muted, so autoplay is not silently blocked', () => {
  // Browsers refuse to autoplay video with sound. Muted is not a preference
  // here — it is the only way the clip plays automatically at all.
  assert.match(CARD, /\bmuted\b/);
});

test('a video only loads once its card is actually on screen', () => {
  // Seven autoplaying clips loading at once — especially on a phone on
  // cellular — is the kind of thing that quietly makes the whole page slow.
  assert.match(CARD, /IntersectionObserver/);
});

test('prefers-reduced-motion is honoured, not just declared', () => {
  assert.match(CARD, /prefers-reduced-motion/);
  // It has to actually gate playback, not just appear as a comment.
  const fn = CARD.slice(CARD.indexOf('reducedMotion'));
  assert.match(fn, /!reducedMotion/, 'the setting must actually stop playback somewhere');
});

test('a missing clip or poster degrades to the icon, not a blank square', () => {
  // The base layer is unconditional — rendered before either asset has had a
  // chance to load or fail, which is what makes a game with no clip recorded
  // yet look intentional rather than broken.
  //
  // Anchored on the real <img> ELEMENT (attribute follows on the next line),
  // not the substring "<img" — a first version of this test matched that
  // same text inside a comment a few lines above the real tag, which put the
  // slice boundary before {icon} and passed for the wrong reason.
  const imgTagAt = CARD.search(/<img\s*\n/);
  assert.notEqual(imgTagAt, -1, 'the poster <img> element is gone');
  const base = CARD.slice(0, imgTagAt);
  assert.match(base, /\{icon\}/, 'the icon layer must render unconditionally, ahead of the poster and video');
});

test('the old duplicated GameCard component is gone', () => {
  assert.ok(!fs.existsSync(FE('components', 'GameCard.jsx')),
    'GameCard.jsx should be deleted, not left behind unused alongside GameVideoCard');
});
