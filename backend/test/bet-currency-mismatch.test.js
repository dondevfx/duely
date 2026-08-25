// A player reported seeing "Bet vs Bot — 1 💎" — a diamond amount below the
// lowest real tier (500), which should be impossible.
//
// It was a display bug, not a money bug: play_coin_flip_vs_bot is one of the
// STAKED handlers stake-tiers.test.js checks, and its server-side guard would
// have rejected entryFee: 1 as an invalid diamond tier before anything moved.
// Nobody could actually have played that match. But the number on screen was
// real and wrong, which is its own bug worth fixing.
//
// The cause: entryFee is page-local state, seeded once on mount from
// location.state — a value that can belong to whatever currency the PREVIOUS
// page was showing, not necessarily this one. betCurrency comes from
// CurrencyContext, shared across every game, so it can already differ from
// what entryFee was seeded for by the time this page mounts, or change again
// later from a source this page never asked for. GameLobby.jsx's own bot
// button already guards this with an effect that corrects entryFee itself
// whenever betCurrency changes — not just where the bet slider points, which
// clamps silently and does not touch the underlying value. CoinFlipGame.jsx
// and BlackjackGame.jsx render an identical "Bet vs Bot" button separately
// (not through GameLobby), and neither had a copy of that guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

test('GameLobby corrects entryFee itself when the currency changes, not just the slider', () => {
  const src = strip(read('components', 'GameLobby.jsx'));
  assert.match(src, /if \(!fees\.includes\(entryFee\)\) setEntryFee\(fees\[0\]\)/,
    'the reference implementation this fix copies must still exist and still do this');
});

for (const [file, label] of [
  ['CoinFlipGame.jsx', 'Coin Flip'],
  ['BlackjackGame.jsx', 'Blackjack'],
]) {
  test(`${label} corrects a stale entryFee when betCurrency changes`, () => {
    // Both pages render their own "Bet vs Bot" button rather than going
    // through GameLobby, so each needs its own copy of the guard — a fix in
    // one file cannot protect the other.
    const src = strip(read('pages', file));
    assert.match(src, /if \(!fees\.includes\(entryFee\)\) setEntryFee\(fees\[0\]\)/,
      `${label} must correct entryFee itself, the same way GameLobby does — clamping only ` +
      'the slider (Math.max(0, fees.indexOf(entryFee))) leaves the raw value, which the bot ' +
      'button reads directly, free to disagree with what the slider shows');

    const effectAt = src.indexOf('if (!fees.includes(entryFee)) setEntryFee(fees[0]);');
    const nearby = src.slice(Math.max(0, effectAt - 300), effectAt);
    assert.match(nearby, /useEffect\(/, `${label}'s guard must run inside an effect, not once at render time`);
    assert.match(src.slice(effectAt, effectAt + 200), /\[betCurrency\]/,
      `${label}'s guard must re-run whenever betCurrency changes — betCurrency is shared ` +
      'across every game via CurrencyContext, so it can change for reasons this page never initiated');
  });
}

test('the bot-button label reads entryFee directly, which is exactly why a silent slider clamp was not enough', () => {
  // Confirms the actual failure mode this fix closes: if the label read
  // fees[sliderIdx] instead of entryFee, the slider's existing clamp would
  // already have been sufficient and none of this would have been needed.
  for (const file of ['CoinFlipGame.jsx', 'BlackjackGame.jsx']) {
    const src = read('pages', file);
    assert.match(src, /Bet vs Bot — \{fmtFee\(entryFee\)\}/,
      `${file} — if this ever changes to read fees[sliderIdx], the guard test above becomes moot, not wrong`);
  }
});
