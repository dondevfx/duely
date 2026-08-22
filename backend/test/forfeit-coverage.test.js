// Every game must be reachable by BOTH leave paths, and the help button must
// not sit on top of a score.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HANDLERS = fs.readFileSync(path.join(__dirname, '..', 'src', 'socket', 'handlers.js'), 'utf8');

// The engines a leaving player can have a live room in.
const ENGINES = [
  'getBlockBlastRoomBySocket',
  'getWordleRoomBySocket',
  'getCoinFlipRoomBySocket',
  'getBlackjackRoomBySocket',
  'getCarDashRoomBySocket',
  'getTowerRoomBySocket',
];

// The two places a leave is noticed. They keep SEPARATE lookup tables, so a new
// game added to one and not the other silently never forfeits by that route —
// and the two routes are different real situations: 'player_forfeit' is
// in-app navigation, 'disconnect' is refresh, tab close and quitting.
function lookupTable(handlerName) {
  const at = HANDLERS.indexOf(`socket.on('${handlerName}'`);
  assert.notEqual(at, -1, `${handlerName} handler not found`);
  const start = HANDLERS.indexOf('roomLookups = [', at);
  assert.notEqual(start, -1, `${handlerName} has no roomLookups table`);
  const end = HANDLERS.indexOf('];', start);
  return HANDLERS.slice(start, end);
}

for (const handler of ['player_forfeit', 'disconnect']) {
  test(`${handler} can settle every game`, () => {
    const table = lookupTable(handler);
    for (const engine of ENGINES) {
      assert.ok(table.includes(engine),
        `${engine} is missing from the ${handler} table — leaving that game this way settles nothing and the opponent hangs`);
    }
  });
}

test('both leave paths cover the same set of games', () => {
  // Drift between the two is the failure that is easy to miss: it works when
  // you navigate away and not when you refresh, or the other way round.
  const forfeit = lookupTable('player_forfeit');
  const disconnect = lookupTable('disconnect');
  for (const engine of ENGINES) {
    assert.equal(forfeit.includes(engine), disconnect.includes(engine),
      `${engine} is handled by only one of the two leave paths`);
  }
});

test('a forfeit pays out through the same settlement as a normal match', () => {
  // Not a special cheaper path — the stayer is owed exactly what winning pays.
  const fn = HANDLERS.slice(HANDLERS.indexOf('async function _handleForfeit'));
  assert.match(fn, /forfeitSettleDiamonds|settleMatchDiamonds/, 'diamond stakes must settle');
  assert.match(fn, /forfeitSettleCoins|settleMatch/, 'coin stakes must settle');
  assert.match(fn, /settleCoinFlip/, "Coin Flip rakes 2%, so it must not settle on the 5% path");
  assert.match(fn, /settleBotMatch/, 'leaving a bot match must still take the stake');
});

test('a forfeit is recorded on the row, not inferred from it', () => {
  // The profile showed "Opponent disconnected" under ordinary matches — and
  // under BOT matches, which cannot disconnect. Nothing on the row said a
  // forfeit had happened, so the frontend guessed from early_click and
  // reaction_time_ms. Those belong to the reaction game and are empty on every
  // other game, so every staked match matched the guess.
  const fn = HANDLERS.slice(HANDLERS.indexOf('async function _handleForfeit'));
  const insert = fn.slice(fn.indexOf("from('matches').insert("));
  assert.match(insert, /ended_by_forfeit:\s*true/,
    'the forfeit path must mark the row, or the label has nothing truthful to read');

  const profile = readFE('pages', 'Profile.jsx');
  assert.match(profile, /ended_by_forfeit === true/,
    'the label must read the column');
  assert.ok(!/isForfeit\s*=.*reaction_time_ms/.test(profile),
    'inferring a forfeit from the reaction game\'s columns is the bug itself');
});

// ── The help button ────────────────────────────────────────────────────────
//
// It floated at top-right on all six games, and every one of them puts
// something there: the opponent's tower height, the opponent's score, the
// opponent's guess count, the lap timer, the turn timer. So it covered the one
// number the player most needs mid-match.

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const readFE = (...p) => fs.readFileSync(FE(...p), 'utf8');

// gameFile -> what already occupies its top-right corner
const TOP_RIGHT_OCCUPIED = {
  'TowerGame':      "the opponent's tower height",
  'CarDashGame':    'the lap timer drawn in the canvas',
  'BlockBlastGame': "the opponent's score",
  'WordleGame':     "the opponent's guess count",
  'BlackjackGame':  'the turn timer',
};

test('the help button never sits where a score does', () => {
  for (const [game, occupant] of Object.entries(TOP_RIGHT_OCCUPIED)) {
    const src = readFE('pages', `${game}.jsx`);
    const at = src.indexOf('<GameHelp');
    assert.notEqual(at, -1, `${game} has no help button`);
    const tag = src.slice(at, src.indexOf('/>', at));
    assert.match(tag, /placement=/,
      `${game} uses the default top-right placement, which covers ${occupant}`);
    assert.ok(!/placement="top-right"/.test(tag),
      `${game} pins the help button over ${occupant}`);
  }
});

test('a corner-placed help button has space reserved for it', () => {
  // This is the invariant that actually holds the button off the HUD, and the
  // only one worth pinning. Measured in a browser at 320-768px: with the
  // reservation the button overlaps nothing; with it removed, it lands on the
  // player's own score at EVERY width. The corner alone does nothing.
  //
  // A reservation is a left pad wide enough to clear a 36px button at left-3
  // (12px) — so 48px minimum. pl-12 is exactly that.
  const MIN_RESERVE = 48;
  for (const game of ['BlockBlastGame', 'WordleGame', 'BlackjackGame']) {
    const src = readFE('pages', `${game}.jsx`);
    assert.match(src, /placement="top-left"/, `${game} is not using the reserved-corner placement`);

    const tw  = /\bpl-12\b/.test(src);                       // 3rem = 48px
    const css = [...src.matchAll(/padding:\s*'[^']*?(\d+)px'/g)]
      .some(m => Number(m[1]) >= MIN_RESERVE);               // 4-value shorthand, last = left
    assert.ok(tw || css,
      `${game} pins the help button in a corner but reserves no room for it, so the layout puts a score underneath`);
  }
});

test('the help panel covers the screen, not its container', () => {
  // The button sits inside a positioned header row; an absolutely positioned
  // overlay would then be sized to that row rather than to the screen.
  const src = readFE('components', 'GameHelp.jsx');
  assert.match(src, /fixed inset-0/, 'the panel must be fixed, or inline placement traps it in a header');
});

test('every help button has a positioning context to sit in', () => {
  // The bug behind the floating '?' on Coin Flip. Every placement is
  // `absolute`, which resolves against the nearest POSITIONED ancestor — and
  // if the intended container is not positioned, the button silently sails
  // past it and anchors to whatever is. On Coin Flip it anchored to a small
  // centred block and floated next to the coin, mid-screen.
  //
  // It is invisible in review because the markup looks right: the button is
  // written inside the container it belongs to. Only the CSS disagrees.
  const GAMES = [
    'TowerGame', 'CarDashGame', 'BlockBlastGame',
    'WordleGame', 'BlackjackGame', 'CoinFlipGame',
  ];
  for (const game of GAMES) {
    const src = readFE('pages', `${game}.jsx`);
    const at = src.indexOf('<GameHelp');
    assert.notEqual(at, -1, `${game} has no help button`);

    // The element it is written inside: the nearest <div opened before it.
    const open = src.lastIndexOf('<div', at);
    assert.notEqual(open, -1, `${game}: could not find the containing element`);
    // Everything from that <div up to the button: the whole opening tag,
    // however it is spread over lines and whether it styles by class or by
    // inline object.
    const tag = src.slice(open, at);

    assert.ok(/className="[^"]*\brelative\b/.test(tag) || /position:\s*'relative'/.test(tag),
      `${game} puts the help button in a container that is not positioned, so it will anchor somewhere else on the page`);
  }
});
