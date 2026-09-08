// Each game's name, set in that game's own materials.
//
// Not custom letterforms — hand-drawn paths for eight names would be a great
// deal of SVG and would read as amateur beside the real artwork. It is the
// actual type, dressed in each game's palette and shapes.
//
// The thing worth protecting here is that the colours come FROM the games. A
// palette picked to look nice in this file drifts away from the game it is
// supposed to evoke the first time either changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');

const TITLE = read('components', 'GameTitle.jsx');
const CARD  = read('components', 'GameVideoCard.jsx');
const GAMES = read('data', 'games.js');

test('every game in the list has a treatment', () => {
  // A slug with no case falls through to the plain default, which is the one
  // outcome nobody would notice until they looked at that card.
  const slugs = [...GAMES.matchAll(/slug:\s*'([a-z-]+)'/g)].map(m => m[1]);
  assert.equal(slugs.length, 8);
  for (const slug of slugs) {
    assert.match(TITLE, new RegExp(`case '${slug}':`),
      `${slug} has no title treatment and would render as plain text`);
  }
});

test('an unknown game still renders its name', () => {
  // The default case is the safety net for a game added to the data before a
  // treatment is written for it.
  assert.match(TITLE, /default:\s*\n\s*return wrap\(<span[^>]*>\{title\}<\/span>\)/,
    'a game with no case must still show its title');
});

test("Block Burst uses the site palette, not the game neon", () => {
  // It used the ten colours the falling blocks drop in. Ten saturated hues
  // beside each other read as a toy next to the rest of the interface, which
  // is built from two blues and a cyan — so these come from tailwind.config
  // instead, and this fails if a colour is invented here that the site does
  // not use anywhere else.
  const theme = read('..', 'tailwind.config.js');
  const inTheme = new Set([...theme.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(m => m[1].toLowerCase()));
  const block = TITLE.slice(TITLE.indexOf('const BLOCK_COLORS'), TITLE.indexOf('// ── Word VS'));
  const used = [...block.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(m => m[1].toLowerCase());
  assert.ok(used.length >= 5, 'too few colours to tell the tiles apart');

  // Every one has to be a blue: same hue family as primary and accent. A green
  // or a magenta passing "is a hex code" is the thing being prevented.
  for (const c of used) {
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    assert.ok(b >= g && g >= r, `${c} is not a blue — the palette is primary, accent and their neighbours`);
  }
  // And the two the whole site is built from must be in there.
  assert.ok(inTheme.has('#1250b4') && used.includes('#1250b4'), 'primary is missing');
  assert.ok(inTheme.has('#00bfff') && used.includes('#00bfff'), 'accent is missing');
});

test('Word VS uses the real tile states', () => {
  const game = read('..', 'src', 'pages', 'WordleGame.jsx');
  for (const [name, hex] of [['correct', '#22c55e'], ['present', '#f59e0b']]) {
    assert.ok(game.includes(hex), `${hex} is no longer the ${name} colour in the game`);
    assert.ok(TITLE.includes(hex), `the title does not use the game's ${name} colour`);
  }
  // A board mid-guess, not a row of green — otherwise it reads as a win
  // screen rather than as the game.
  const states = TITLE.match(/const WORD_STATES = \[([^\]]*)\]/);
  assert.ok(states, 'the tile states are gone');
  assert.match(states[1], /'absent'/, 'every tile filled reads as a solved board');
  assert.match(states[1], /'present'/);
});

test('Color Rush uses its three targets', () => {
  const canvas = read('components', 'ColorRushCanvas.jsx');
  const rush = TITLE.slice(TITLE.indexOf('const RUSH_COLORS'), TITLE.indexOf('const SLUG_ALIASES'));
  const used = [...rush.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(m => m[1]);
  assert.equal(used.length, 3, 'the game asks you to hit three colours');
  for (const c of used) {
    assert.ok(canvas.includes(c), `${c} is not one of Color Rush's targets`);
  }
});

// ── It has to survive the card it sits on ──────────────────────────────────

test('everything is sized in em, so one card size fits all', () => {
  // The card is text-sm on a phone and text-xl on a desktop. A treatment in px
  // would be right at one of those and wrong at the other, and would need a
  // breakpoint of its own for every game.
  //
  // Catches Tailwind's arbitrary values too. w-[12px] contains no "width", so
  // a rule looking for CSS property names steps straight over it — which is
  // how the first version of this test missed exactly that swap.
  const px = TITLE.match(/\[\d+(?:\.\d+)?px\]|(?:width|height|fontSize|font-size)[^,;\n]*\b\d+px/g);
  assert.equal(px, null, `fixed pixel sizes will not scale with the card: ${px}`);
  assert.match(TITLE, /w-\[\d?\.?\d+em\]/, 'tiles must be sized relative to the type');
});

test('a two-word name stacks, second word under first', () => {
  // Not wrapping — stacking, always. A card is square and a title is two short
  // words: side by side it runs edge to edge and has to be set small to fit;
  // stacked it can be half again as large in the same space.
  assert.match(TITLE, /function Words/, 'words must be separate items, or it breaks mid-word');
  const fn = TITLE.slice(TITLE.indexOf('function Words'), TITLE.indexOf('export default'));
  assert.match(fn, /flex-col/, 'the words still sit on one line');
  assert.match(fn, /items-center/, 'a stacked pair has to be centred or it reads as ragged');
  assert.ok(!/flex-wrap/.test(fn), 'wrapping and stacking together is one of them not working');
});

// ── What a screen reader hears ─────────────────────────────────────────────

test('the name is announced once, not letter by letter', () => {
  // Split into per-letter spans, "Block Burst" is announced as eleven letters,
  // or with a pause at every tile. The decorated version is hidden and the
  // real name is carried once on the wrapper.
  assert.match(TITLE, /aria-label=\{title\}/, 'the real name is never announced');
  assert.match(TITLE, /aria-hidden="true"/, 'the decorated letters are announced as well');
  const wrapFn = TITLE.slice(TITLE.indexOf('const wrap ='), TITLE.indexOf('switch (key)'));
  const labelAt  = wrapFn.indexOf('aria-label={title}');
  const hiddenAt = wrapFn.indexOf('aria-hidden="true"');
  assert.ok(labelAt > 0 && hiddenAt > labelAt,
    'the hidden letters must sit INSIDE the labelled wrapper');
});

test('the card renders the treatment, not the bare title', () => {
  const h3 = CARD.match(/<h3[\s\S]*?<\/h3>/);
  assert.ok(h3, 'the title heading is gone');
  assert.match(h3[0], /<GameTitle slug=\{slug\} title=\{title\} \/>/,
    'the card is still printing the plain title');
  assert.match(CARD, /import GameTitle from '\.\/GameTitle'/);
});

// ── Everywhere a title shows ───────────────────────────────────────────────

test('the bet screen heading uses the treatment too', () => {
  // The shared lobby is the heading on Block Burst, Rush Hour, Color Rush,
  // Word VS and Tower. A treatment only on the home cards means the name looks
  // like one thing on the way in and another once you are there.
  const lobby = read('components', 'GameLobby.jsx');
  const h1 = lobby.match(/<h1[\s\S]*?<\/h1>/);
  assert.ok(h1, 'the lobby heading is gone');
  assert.match(h1[0], /<GameTitle slug=\{gameType\} title=\{title\} \/>/,
    'the bet screen still prints the plain title');
  assert.match(lobby, /import GameTitle from '\.\/GameTitle'/);
});

test('the two games with their own lobby use it as well', () => {
  // Coin Flip and Blackjack build their own bet screens rather than going
  // through GameLobby, so they are the two that get missed.
  for (const [file, slug, name] of [
    ['CoinFlipGame.jsx',  'coin-flip', 'Coin Flip'],
    ['BlackjackGame.jsx', 'blackjack', 'Blackjack'],
  ]) {
    const src = read('..', 'src', 'pages', file);
    assert.match(src, new RegExp(`<GameTitle slug="${slug}" title="${name}" />`),
      `${file} still prints its title as plain text`);
    assert.match(src, /import GameTitle from '\.\.\/components\/GameTitle'/, `${file} import`);
  }
});

test('a queue key finds the same treatment as a slug', () => {
  // The cards pass a slug, the bet screens pass a queue key, and for two games
  // those disagree: carDash against car-dash, colorRush against color-rush.
  // Unnormalised, those two bet screens fall through to the plain default —
  // and the only way to notice is to look at exactly those two screens.
  const map = TITLE.match(/const SLUG_ALIASES = \{([\s\S]*?)\};/);
  assert.ok(map, 'nothing normalises the two spellings');
  assert.match(map[1], /carDash:\s*'car-dash'/);
  assert.match(map[1], /colorRush:\s*'color-rush'/);
  assert.match(TITLE, /const key = SLUG_ALIASES\[slug\] \|\| slug/,
    'the alias map is declared but never applied');
  assert.match(TITLE, /switch \(key\)/, 'the switch must run on the normalised key');
});

test('the queue keys the bet screens actually pass are all covered', () => {
  // Read from the pages rather than assumed: these are the exact strings
  // GameLobby is handed.
  const keys = ['block-blast', 'carDash', 'colorRush', 'scrabble', 'tower'];
  const map = TITLE.match(/const SLUG_ALIASES = \{([\s\S]*?)\};/)[1];
  for (const k of keys) {
    const covered = new RegExp(`case '${k}':`).test(TITLE) || new RegExp(`${k}:`).test(map);
    assert.ok(covered, `${k} is passed by a bet screen but has no case and no alias`);
  }
});

// ── The coin is the game's coin ────────────────────────────────────────────

test('Coin Flip uses the coin the game actually flips', () => {
  // It was a drawn gold disc, which was a second coin that looked nothing like
  // the one on the bet screen or the result card. CoinFaceIcon is that coin.
  assert.match(TITLE, /import CoinFaceIcon from '\.\/CoinFaceIcon'/,
    'the title draws its own coin instead of using the game\'s');
  assert.match(TITLE, /<CoinFaceIcon side="heads"/);
  assert.ok(!/GOLD_(LIGHT|MID|DARK)/.test(TITLE), 'the hand-drawn gold disc is still here');
});

test('the coin is sized as a lowercase letter, not an icon', () => {
  // It stands in for the "o" in Coin. At cap height it reads as an icon parked
  // in the middle of a word.
  const size = TITLE.match(/<CoinFaceIcon side="heads" size="([\d.]+)em"/);
  assert.ok(size, 'the coin has no size');
  assert.ok(parseFloat(size[1]) <= 0.65,
    `${size[1]}em is cap height — a lowercase o is around half the em`);
});

// ── Where the title sits on the card ───────────────────────────────────────

test('the title is centred at the foot of the clip, and larger', () => {
  const h3 = CARD.match(/<h3[\s\S]*?>/)[0];
  assert.match(h3, /text-center/, 'the title is still left-aligned');
  assert.match(h3, /text-base md:text-2xl/, 'the title is still at the old size');
  const scrim = CARD.slice(CARD.indexOf('absolute inset-x-0 bottom-0'));
  assert.match(scrim.slice(0, 300), /text-center/, 'the scrim does not centre its contents');
});

test('the bet screens show the title without a game icon beside it', () => {
  // The clip and the treatment already say which game this is; the icon was a
  // third statement of the same thing, at a size that competed with the name.
  const lobby = read('components', 'GameLobby.jsx');
  const h1 = lobby.match(/<h1[\s\S]*?<\/h1>/)[0];
  assert.ok(!/<GameIcon/.test(h1), 'the shared bet screen still shows a game icon');
  for (const f of ['CoinFlipGame.jsx', 'BlackjackGame.jsx']) {
    const src = read('..', 'src', 'pages', f);
    const own = src.match(/<h1[^>]*>[\s\S]*?<\/h1>/);
    assert.ok(own, `${f} has no heading`);
    assert.ok(!/<GameIcon/.test(own[0]), `${f} still shows a game icon in its heading`);
  }
});
