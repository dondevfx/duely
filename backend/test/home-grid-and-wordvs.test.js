// The Home grid at every width, duplicate SVG ids, and Word VS's bot match.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fe = (...p) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const HOME   = strip(fe('pages', 'Home.jsx'));
const WORDLE = strip(fe('pages', 'WordleGame.jsx'));
const BLOCK  = strip(fe('pages', 'BlockBlastGame.jsx'));

// ── Home ──────────────────────────────────────────────────────────────────

test('the game grid is two columns, and three once there is room', () => {
  // Two everywhere was the previous ask; three on a desktop is the current
  // one. The constant across both is that the count never produces cards
  // smaller than a phone's — which is what the old responsive counts did.
  assert.match(HOME, /className="grid grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4"/);
  assert.ok(!/grid-cols-2 sm:grid-cols-3/.test(HOME), 'the old responsive counts are back');
  assert.ok(!/grid-cols-2 (md|lg):grid-cols-3/.test(HOME),
    'three columns before xl measured 175-189px against a phone at 169px, because the ' +
    'left nav takes 240px from md and world chat another 320px from lg');
});

test('the page is one column, so How Duely Works sits with the games', () => {
  assert.ok(!/flex-col lg:flex-row/.test(HOME), 'a side column puts How It Works beside the grid again');
  assert.ok(!/lg:w-72/.test(HOME), 'the fixed rail is gone');
});

test('How Duely Works is the ninth cell of the grid', () => {
  // Eight games plus the card is exactly 3x3, so a wide screen ends on a full
  // row instead of two games and a gap.
  const grid = HOME.slice(HOME.indexOf('grid grid-cols-2 xl:grid-cols-3'));
  const games = grid.indexOf('GAMES.map');
  const card  = grid.indexOf('<HowDuelyWorks />');
  assert.ok(games > 0 && card > games, 'the card must come after the games, inside the grid');
  const comp = HOME.slice(HOME.indexOf('function HowDuelyWorks()'), HOME.indexOf('function DailySpinWidget'));
  assert.match(comp, /col-span-2 xl:col-span-1/, 'full width on a phone, one cell on a desktop');
  assert.match(comp, /xl:aspect-square/, 'a shorter card in the corner reads as a failed load');
});

test('the grid widens when it goes to three columns', () => {
  assert.match(HOME, /max-w-3xl xl:max-w-5xl/);
});

test('gradient ids are unique per instance', () => {
  // An id is document-wide. DiamondIcon declared "dia_pav" and "dia_crown" as
  // fixed strings, so a page with eleven diamonds declared each id eleven
  // times and every url(#dia_pav) resolved to whichever mounted FIRST — all
  // eleven painted from one icon's defs. Harmless while they are identical,
  // and not harmless at all when the first unmounts: the rest lose their fill.
  for (const [file, ids] of [
    [['components', 'DiamondIcon.jsx'], ['dia_crown', 'dia_pav']],
    [['components', 'GameIcon.jsx'],    ['cf_face']],
    [['components', 'SpinWheel.jsx'],   ['hubGrad']],
  ]) {
    const src = fe(...file);
    assert.match(src, /useId/, `${file[1]} must derive its ids per instance`);
    for (const id of ids) {
      assert.ok(!new RegExp(`id="${id}"`).test(src),
        `${file[1]} still declares a fixed id="${id}"`);
    }
  }
  // The wheel's eight segment gradients were the same problem eight times over.
  assert.match(fe('components', 'SpinWheel.jsx'), /id=\{`\$\{uid\}seg\$\{i\}`\}/);
});

test('the id is defined in the component that draws it', () => {
  // Declaring it in the parent builds cleanly and throws at render — a
  // constant in GameIcon is not in scope inside CoinFlip, which is the
  // function that owns the <defs>.
  //
  // Scoped to CoinFlip's own body, not merely "somewhere after it" — GameIcon
  // is defined LATER in the file, so an ordering check cannot tell the two
  // apart and passes when the declaration is moved to the wrong one. Caught by
  // mutating exactly that.
  const src = fe('components', 'GameIcon.jsx');
  const start = src.indexOf('function CoinFlip()');
  assert.ok(start > 0, 'CoinFlip is gone');
  const end = src.indexOf(String.fromCharCode(10) + 'function ', start + 1);
  const body = src.slice(start, end === -1 ? src.length : end);
  assert.match(body, /const faceId = `cf_face_\$\{useId\(\)\}`;/,
    'faceId must be declared inside CoinFlip — the function that owns the <defs>');
});

// ── Word VS ───────────────────────────────────────────────────────────────

test('Bet vs Bot starts a real bot match, not a solo session', () => {
  // It emitted wordle_solo_start, which opens a session with NO opponent — so
  // the screen said Solo, showed nobody to play against, and the diamonds went
  // into a bet with no second side. The server has had play_scrabble_vs_bot
  // all along: a bot player, a real room, settlement through the engine.
  assert.match(WORDLE, /socket\.emit\('play_scrabble_vs_bot', \{ entryFee, currency: betCurrency \}\)/);
  assert.match(WORDLE, /onBot=\{playVsBotPaid\}/);
  assert.ok(!/onBot=\{startSoloPaid\}/.test(WORDLE));
  // And it must not be labelled solo, or the HUD hides the opponent column.
  const fn = WORDLE.slice(WORDLE.indexOf('function playVsBotPaid'), WORDLE.indexOf('function leaveQueue'));
  assert.match(fn, /lastModeRef\.current = 'bot'/);
  assert.ok(!/lastModeRef\.current = 'solo'/.test(fn));
});

test('free play is still genuinely solo', () => {
  // startSolo has no opponent and is labelled Solo Mode rather than pretending
  // to have one. Only the paid mode changed.
  assert.match(WORDLE, /onBotFree=\{startSolo\}/);
  assert.match(WORDLE, /botLabel="Solo Mode"/);
  const fn = WORDLE.slice(WORDLE.indexOf('function startSolo()'), WORDLE.indexOf('function playVsBotPaid'));
  assert.match(fn, /lastModeRef\.current = 'solo'/);
});

test('the HUD row is padded on both sides, clear of the help button', () => {
  // The button is absolute at left-3 with w-9, so it occupies 12px to 48px.
  // The row reserved exactly 48px on the left and nothing on the right, which
  // put the centre column 24px right of true centre and left zero clearance
  // between the button and the avatar beside it. Measured before: off by 24,
  // gap 0. After: off by 0, gap 8.
  for (const [name, src] of [['WordleGame', WORDLE], ['BlockBlastGame', BLOCK]]) {
    assert.match(src, /flex items-center justify-between w-full max-w-lg gap-2 px-14/,
      `${name} HUD row must pad both sides`);
    assert.ok(!/max-w-lg gap-2 pl-12/.test(src), `${name} still pads only the left`);
  }
});
