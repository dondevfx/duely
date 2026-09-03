// The bet screen on load, and the component that was supposed to stop text
// being cut off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fe = (...p) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const FITTEXT = fe('components', 'FitText.jsx');
const LOBBY   = fe('components', 'GameLobby.jsx');
const JOIN    = fe('components', 'JoinRoomModal.jsx');
const UIICON  = fe('components', 'UiIcon.jsx');

// ── FitText ───────────────────────────────────────────────────────────────

test('scaled text is anchored to the left edge, not its own centre', () => {
  // A transform scales about the element's OWN natural box, and the natural
  // box is the oversized one — that is the only case where scaling happens.
  // Shrinking 83px of text about its own centre inside a 53px container
  // leaves it centred on 83px, which sits 15px right of the container, so the
  // end fell outside and the container's overflow-hidden cut it off. That is
  // how "Champion" became "Champio" AFTER being shrunk to fit.
  //
  // From the left it lands right by construction: the scale is exactly
  // avail/need, so the scaled width equals the container width.
  assert.match(FITTEXT, /origin-left/);
  assert.ok(!/origin-center/.test(FITTEXT),
    'centre-origin scaling puts the text outside the box it was measured against');
  assert.match(FITTEXT, /Math\.max\(min, avail \/ need\)/,
    'the exact-fit scale is what makes left-anchoring correct');
});

// ── The bet screen ────────────────────────────────────────────────────────

// Every betting screen. GameLobby covers five games; Coin Flip and Blackjack
// build their own lobbies and need the identical control, which is why the
// toggle lives in its own file rather than inside GameLobby.
const BET_SCREENS = [
  ['components', 'GameLobby.jsx'],
  ['pages', 'CoinFlipGame.jsx'],
  ['pages', 'BlackjackGame.jsx'],
];

test('the extra ways to play are collapsed on load, on every betting screen', () => {
  for (const parts of BET_SCREENS) {
    const code = strip(fe(...parts));
    assert.match(code, /const \[moreOpen, setMoreOpen\] = useState\(false\)/,
      `${parts[1]} must open collapsed — this is about what it looks like when it LOADS`);
    assert.match(code, /<MoreWaysToggle open=\{moreOpen\} onToggle=\{\(\) => setMoreOpen\(o => !o\)\} \/>/,
      `${parts[1]} does not use the shared toggle`);
    assert.match(code, /\{moreOpen && \(/, `${parts[1]} does not gate the panel on it`);
  }
});

test('the toggle is a small chevron on a short full-width bar', () => {
  const mw = fe('components', 'MoreWays.jsx');
  // Comments stripped for the negative checks: the notes explaining why
  // preserveAspectRatio and w-1/3 were removed name both, and a test that
  // reads prose passes when someone deletes the code and keeps the note.
  const code = strip(mw);
  // The bar spans the card because it is a lid on the group below. The mark
  // on it does not: stretched edge to edge the chevron read as a line drawn
  // across the card rather than an arrow sitting on it.
  assert.match(mw, /w-full flex items-center justify-center px-4 py-2 rounded-lg/);
  assert.match(mw, /className="w-6 h-2\.5 transition-transform/);
  assert.ok(!/preserveAspectRatio="none"/.test(code), 'the chevron must not stretch with the bar');
  assert.ok(!/w-1\/3/.test(code), 'the bar spans the card');
  // rotateX, not rotate. A flat rotate spins the chevron through the
  // horizontal, passing edge-on, which reads as sideways travel; rotateX tips
  // it over the top, which is the motion the control describes.
  assert.match(mw, /transform: up \? 'rotateX\(180deg\)' : 'none'/);
  assert.ok(!/[^X]rotate\(180deg\)/.test(code), 'a flat rotate flips it sideways');
  assert.match(mw, /<WideChevron up=\{open\} \/>/);
  // No shaft: a chevron already says which way it goes.
  assert.equal((code.match(/<path/g) || []).length, 1);
  // Still reachable without sight of the arrow.
  assert.match(mw, /aria-expanded=\{open\}/);
  assert.match(mw, /aria-label=\{open \? 'Fewer ways to play' : 'More ways to play'\}/);
});

test('Coin Flip fits on a 360px screen with the panel open', () => {
  // Measured in the browser at 360x780: 723px of content against 724px of
  // space with diamonds selected, which is the tallest this screen gets — it
  // carries a heads/tails picker on top of everything the others have. Every
  // saving is padding, a gap, or one type step on a phone; nothing is removed
  // and nothing changes above sm.
  const cf = strip(fe('pages', 'CoinFlipGame.jsx'));
  for (const cls of [
    'text-3xl sm:text-6xl',        // title
    'py-2 sm:py-3 rounded-xl',     // heads/tails
    'p-1.5 sm:p-3',                // the picker card
    'gap-1.5 sm:gap-3',            // the action column
    'gap-1.5 sm:gap-2',            // inside the panel
  ]) {
    assert.ok(cf.includes(cls), `Coin Flip is missing "${cls}"`);
  }
  // The shared small button is shorter on a phone too — four of them stack
  // here once the panel is open.
  assert.match(fe('components', 'GameLobby.jsx'), /py-3 sm:py-4 rounded-xl text-base font-bold/);
});

test('nothing on Coin Flip can outgrow its row', () => {
  // Two labels side by side on a 360px phone. SMALL_BTN is flex-1, which on
  // its own does not stop a flex child growing past its basis — min-w-0 is
  // what lets it shrink instead of pushing the row wider than the card.
  for (const page of ['CoinFlipGame.jsx', 'BlackjackGame.jsx']) {
    const code = strip(fe('pages', page));
    const row = code.slice(code.indexOf('Play vs Bot') - 400, code.indexOf('Join Game') + 200);
    assert.equal((row.match(/\$\{SMALL_BTN\} min-w-0/g) || []).length, 2,
      `${page}: both buttons in the two-across row need min-w-0`);
  }
});

test('nothing is removed, only folded away', () => {
  const code = strip(LOBBY);
  const panel = code.slice(code.indexOf('{moreOpen && ('));
  for (const label of ['botLabel || \'Play vs Bot\'', 'Join Game', 'Bet vs Bot']) {
    assert.ok(panel.includes(label), `${label} must still be reachable`);
  }
  // Invite (was "Challenge a Friend") stays OUT of the panel: it is a way of
  // starting a real match, not a curiosity, so it keeps its place next to
  // Play (was "Find Opponent").
  const before = code.slice(0, code.indexOf('{moreOpen && ('));
  assert.match(before, /Invite/);
});

// ── Emoji ─────────────────────────────────────────────────────────────────

test('no emoji on the lobby buttons', () => {
  for (const [file, src] of [['GameLobby', LOBBY], ['CreateRoomModal', fe('components', 'CreateRoomModal.jsx')]]) {
    assert.ok(!/🎮 Challenge a Friend/.test(src), `${file} still has the controller emoji`);
  }
  for (const page of ['BlockBlastGame', 'CarDashGame', 'ColorRushGame', 'TowerGame', 'WordleGame']) {
    const src = fe('pages', `${page}.jsx`);
    assert.ok(!/botLabel="🎮/.test(src), `${page} still has the controller emoji on its solo button`);
  }
});

test('the join dialog is headed by a drawn icon', () => {
  // 🔗 is a paperclip on some platforms, a chain on others, and never the
  // brand's blue.
  assert.ok(!/🔗 Join a Game/.test(JOIN));
  assert.match(JOIN, /<JoinCodeIcon size=\{20\} \/> Join a Game/);
  assert.match(JOIN, /import \{ JoinCodeIcon \} from '\.\/UiIcon'/);
  assert.match(UIICON, /export function JoinCodeIcon/);
});

// ── The dev affordance stays out of production ────────────────────────────

test('the preview session is DEV-only', () => {
  // The signed-in half of the lobby cannot be looked at without an account,
  // which makes the layout hardest to get right also the hardest to see. It
  // must not be a way into a signed-in view of a real build.
  assert.match(LOBBY, /import\.meta\.env\.DEV\s*\n?\s*&& typeof window/,
    'the DEV guard must come first, so the bundler drops the whole expression');
  assert.match(LOBBY, /previewauth/);
  const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(dist)) {
    const bundles = fs.readdirSync(path.join(dist, 'assets')).filter(f => f.endsWith('.js'));
    for (const b of bundles) {
      const js = fs.readFileSync(path.join(dist, 'assets', b), 'utf8');
      assert.ok(!js.includes('previewauth'),
        `${b} ships the preview session escape hatch`);
    }
  }
});
