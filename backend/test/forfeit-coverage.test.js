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

test('an inline help button cannot overlap anything', () => {
  // 'inline' means it flows in the header row and takes real space, so no
  // amount of later layout change can put a score underneath it.
  const src = readFE('components', 'GameHelp.jsx');
  const placements = src.slice(src.indexOf('const PLACEMENT'), src.indexOf('};', src.indexOf('const PLACEMENT')));
  assert.match(placements, /inline:\s*''/, 'inline must apply no positioning at all');
});

test('the help panel covers the screen, not its container', () => {
  // Inline places the button inside a header row; an absolutely positioned
  // overlay would then be sized to that row.
  const src = readFE('components', 'GameHelp.jsx');
  assert.match(src, /fixed inset-0/, 'the panel must be fixed, or inline placement traps it in a header');
});
