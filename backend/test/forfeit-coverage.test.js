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

// The three tests that used to live here pinned WHERE the in-game help button
// sat — off the score, out of the HUD's corners, with padding reserved for it.
// There is no in-game help button any more: the rules are read on the bet
// screen, before anything is running, from a ? in its top-right corner.
//
// What replaces them is the rule that the button is not in a game at all,
// which is both what was asked for and the only thing that can now go wrong.

test('no game renders a help button over the play area', () => {
  // These five put their bet screen through the shared GameLobby, so the page
  // file is the GAME and must hold no help button at all.
  for (const g of ['BlockBlastGame', 'CarDashGame', 'ColorRushGame',
                   'TowerGame', 'WordleGame']) {
    const src = readFE('pages', `${g}.jsx`);
    assert.ok(!/<GameHelp/.test(src),
      `${g} still mounts a help button inside the game`);
  }
  // Coin Flip and Blackjack build their own bet screen in the same file as the
  // game, so counting is the only way to tell one from the other: exactly one
  // button, and it is the bet screen's.
  for (const g of ['CoinFlipGame', 'BlackjackGame']) {
    const src = readFE('pages', `${g}.jsx`);
    const n = (src.match(/<GameHelp/g) || []).length;
    assert.equal(n, 1, `${g} has ${n} help buttons — one belongs to the bet screen`);
    assert.match(src, /placement="top-right"/,
      `${g}'s only help button is not the bet screen's`);
  }
});

test('every bet screen has one, in its top-right corner', () => {
  // The shared lobby, plus Coin Flip and Blackjack which build their own — the
  // two that get missed every time something is added to a bet screen.
  for (const [label, ...where] of [
    ['GameLobby',  'components', 'GameLobby.jsx'],
    ['Coin Flip',  'pages', 'CoinFlipGame.jsx'],
    ['Blackjack',  'pages', 'BlackjackGame.jsx'],
  ]) {
    const src = readFE(...where);
    assert.match(src, /<GameHelp/, `${label} has no help button`);
    assert.match(src, /placement="top-right"/, `${label} does not put it top right`);
    // Absolutely positioned inside a relative wrapper, or "top right" is
    // wherever the flow happens to leave it.
    const at = src.indexOf('<GameHelp');
    const before = src.slice(Math.max(0, at - 300), at);
    assert.match(before, /absolute top-0 right-0/, `${label}: the button is not pinned`);
    assert.match(before, /className="relative"/, `${label}: nothing to pin it to`);
  }
});

test('the help panel opens with real content on every bet screen', () => {
  // GameHelp is keyed by its own names, which are not the queue keys the lobby
  // is handed: block-blast against blockBlast. Unmapped, the panel opens empty
  // on the one screen whose key differs — and an empty panel looks like a bug
  // in the help, not a missing mapping.
  const help = readFE('components', 'GameHelp.jsx');
  const keys = [...help.matchAll(/^\s{2}'?([a-zA-Z-]+)'?: \{/gm)].map(m => m[1]);
  assert.ok(keys.length >= 7, `only found ${keys.length} help entries`);

  const lobby = readFE('components', 'GameLobby.jsx');
  const map = lobby.match(/const HELP_KEYS = \{([^}]*)\}/);
  assert.ok(map, 'nothing maps a queue key to a help key');
  assert.match(map[1], /'block-blast': 'blockBlast'/,
    'block-blast is the key that differs, and the one that opens empty without this');
});

