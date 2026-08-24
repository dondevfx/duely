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
  assert.match(CARD, /objectPosition:\s*clipPosition/,
    'clipPosition must reach the actual CSS object-position, wherever it comes from');
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

test('every clip starts loading immediately, not on scroll-into-view', () => {
  // Used to be gated behind an IntersectionObserver — right for a long page,
  // wrong for Home and Games, which both show all seven cards in one compact
  // grid. That gate was the reported bug: the icon sat there until a card
  // scrolled into view before its clip even started fetching. All seven
  // clips together are under 1.5MB, cheap enough to just load.
  // Checks actual usage, not the bare word — a comment explaining that the
  // gate used to exist legitimately mentions the class name too.
  assert.ok(!/new IntersectionObserver/.test(CARD),
    'a scroll-into-view gate must not come back — it reintroduces the exact delay this fixed');
  assert.match(CARD, /preload="auto"/,
    '"metadata" only fetches duration/dimensions and defers real frame data — auto is what makes the clip actually arrive promptly');
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
  // not the substring "<img" — a first version of this test matched that same
  // text inside a comment a few lines above the real tag, which put the slice
  // boundary before {icon} and passed for the wrong reason.
  const imgTagAt = CARD.search(/<img\s*\n/);
  assert.notEqual(imgTagAt, -1, 'the poster <img> element is gone');
  const base = CARD.slice(0, imgTagAt);
  assert.match(base, /\{icon\}/, 'the icon layer must render unconditionally, ahead of the poster and video');
});

test('the old duplicated GameCard component is gone', () => {
  assert.ok(!fs.existsSync(FE('components', 'GameCard.jsx')),
    'GameCard.jsx should be deleted, not left behind unused alongside GameVideoCard');
});

test('every listed game has a poster image on disk', () => {
  // The gap this closes: with no poster, nothing bridges the icon and the
  // moment the video actually paints a frame, which on a real network is
  // long enough to see as a flash. A poster is a few KB and decodes almost
  // immediately, so it covers that gap — but only for games that have one.
  // Catches a new game shipping with a clip and no poster to go with it.
  const slugs = [...GAMES_DATA.matchAll(/slug:\s*'([a-z-]+)'/g)].map(m => m[1]);
  const missing = slugs.filter(s => !fs.existsSync(FE('..', 'public', 'game-clips', `${s}.jpg`)));
  assert.deepEqual(missing, [], `no poster on disk for: ${missing.join(', ')}`);
});

// ── The crop-debug slider ───────────────────────────────────────────────────
//
// Exists because a crop verified correct by every tool available in this
// environment — extracted frames, simulated canvas crops, the deployed CSS
// value read straight off production — still came back wrong on a real
// phone, twice. canvas drawImage does not reproduce what object-fit:cover
// actually paints, so nothing built on it can be trusted for this. The
// fastest real fix is a live slider on the real device, not another guess.

test('the crop-debug slider is off unless explicitly asked for', () => {
  assert.match(CARD, /cropdebug.*===\s*'1'/,
    'this must require an explicit query param — it must not be on by default');
});

test('the debug slider drives the same clipPosition the real crop uses', () => {
  // If it wrote to a separate variable, dialing in a number on the slider
  // would not actually match what ships without it.
  const fn = CARD.slice(CARD.indexOf('function GameVideoCard'));
  const debugAt = fn.indexOf('useCropDebug');
  assert.notEqual(debugAt, -1, 'useCropDebug is gone');
  assert.match(fn.slice(debugAt, debugAt + 200), /clipPosition\s*=\s*`\$\{debugX\}%/,
    'the debug value must overwrite clipPosition itself, not a separate unused variable');
});
