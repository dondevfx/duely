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

test('the extra ways to play are collapsed on load', () => {
  const code = strip(LOBBY);
  assert.match(code, /const \[moreOpen, setMoreOpen\] = useState\(false\)/,
    'the page must open collapsed — this is about what it looks like when it LOADS');
  assert.match(code, /moreOpen \? 'Fewer Options' : 'More Ways to Play'/);
  assert.match(code, /aria-expanded=\{moreOpen\}/);
});

test('nothing is removed, only folded away', () => {
  const code = strip(LOBBY);
  const panel = code.slice(code.indexOf('{moreOpen && ('));
  for (const label of ['botLabel || \'Play vs Bot\'', 'Join Game', 'Bet vs Bot']) {
    assert.ok(panel.includes(label), `${label} must still be reachable`);
  }
  // Challenge a Friend stays OUT of the panel: it is a way of starting a real
  // match, not a curiosity, so it keeps its place next to Find Opponent.
  const before = code.slice(0, code.indexOf('{moreOpen && ('));
  assert.match(before, /Challenge a Friend/);
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
