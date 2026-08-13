// Losing to a bot printed "Your win streak has been reset" on the result card.
//
// It never was reset — applyMatchStreaks no-ops the moment either side is a bot,
// which is the whole point of streaks being a PvP record. So the card announced
// a punishment that had not happened, on the one mode where nothing is at stake
// competitively.
//
// The card could not tell: no result payload said whether the opponent was a
// bot. Every engine now reports `vsBot`, and the message is gated on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = (raw) => raw
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const engine = (f) => strip(fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', f), 'utf8'));

const ENGINES = [
  'blackjackEngine.js', 'coinFlipEngine.js',
  'blockBlastEngine.js', 'carDashEngine.js', 'wordleEngine.js',
];

for (const f of ENGINES) {
  test(`${f} reports whether the opponent was a bot`, () => {
    assert.match(engine(f), /\bvsBot\b/,
      `${f} must report vsBot, or the card cannot tell a bot match from PvP`);
  });
}

test('streaks really are PvP-only, which is what makes the message wrong', () => {
  // If this ever stopped being true, hiding the message would become the bug.
  const elo = engine('eloService.js');
  const fn = elo.slice(elo.indexOf('function applyMatchStreaks'));
  assert.match(fn.slice(0, 600), /isBot/,
    'applyMatchStreaks must still no-op when either side is a bot');
});

test('the result card gates the reset message on vsBot', () => {
  const jsx = strip(fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'ResultScreen.jsx'), 'utf8'));
  const at = jsx.indexOf('Your win streak has been reset');
  assert.ok(at > 0, 'message not found');
  // The guard sits immediately above the message in the same JSX expression.
  const guard = jsx.slice(jsx.lastIndexOf('{', at - 120), at);
  assert.match(guard, /!vsBot/, 'the reset message must not show on a bot match');
});

test('every game page passes the flag through', () => {
  const dir = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages');
  for (const f of ['BlackjackGame.jsx', 'CoinFlipGame.jsx', 'BlockBlastGame.jsx',
                   'CarDashGame.jsx', 'WordleGame.jsx']) {
    const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    // Count result cards, and make sure each is preceded by a vsBot or solo prop
    // — solo already suppresses the message on its own.
    let cards = 0, flagged = 0;
    for (let i = src.indexOf('<ResultScreen'); i !== -1; i = src.indexOf('<ResultScreen', i + 1)) {
      cards++;
      const props = src.slice(i, i + 700);
      if (/\bvsBot\b/.test(props) || /\bsolo\b/.test(props)) flagged++;
    }
    assert.ok(cards > 0, `${f}: no result card found`);
    assert.equal(flagged, cards, `${f}: a result card neither passes vsBot nor is solo`);
  }
});
