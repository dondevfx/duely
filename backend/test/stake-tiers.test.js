// The entry fee is a number the client sends. Everything downstream — what is
// deducted, what the winner is paid, what goes in the match row — is computed
// from it. So it has to be checked against the tier list at the door, in every
// handler that starts a staked game, or the tier list is decorative.
//
// The queue handlers always did this. The BOT handlers did not, and that was a
// live exploit: `deductDiamonds` floors the amount but the room keeps the raw
// number, so `play_tower_vs_bot { entryFee: 0.99, currency: 'diamonds' }` cost
// zero and paid out on 0.99. Repeatable, and on all six games.
//
// This walks the actual source rather than mocking a socket, because the thing
// that can regress is someone adding a seventh game by copying a handler — and
// a copied handler with no guard is exactly what this has to fail on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'socket', 'handlers.js');

// Comments are blanked rather than removed, so every index still lines up with
// the real file and error messages can quote a true line number.
function source() {
  return fs
    .readFileSync(SRC, 'utf8')
    .split('\n')
    .map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l.replace(/\s\/\/.*$/, '')))
    .join('\n');
}

// The body of `socket.on('<name>', ...)`, found by matching braces from the
// handler's opening `{`. A window of N lines would not do: these handlers are
// 40-130 lines long and several of them are adjacent, so a window either misses
// the guard or reads the neighbour's.
function handlerBody(src, name) {
  const at = src.indexOf(`socket.on('${name}'`);
  assert.notEqual(at, -1, `handler ${name} not found — was it renamed?`);
  const open = src.indexOf('{', src.indexOf('=>', at));
  assert.notEqual(open, -1, `could not find the body of ${name}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces in ${name}`);
}

// Anything that moves money or commits the player to a stake. The guard has to
// come before all of them — validating after the deduction is not validating.
const SPENDS = /\bdeductDiamonds\s*\(|\bdeductCoins\s*\(|\bdeductMatchFees\s*\(|\blockUser\s*\(/;
const GUARD  = /\brejectBadFee\s*\(|\bisValidFee\s*\(/;

// Every handler that can start a game with something at stake.
const STAKED = [
  'join_block_blast_queue', 'play_block_blast_vs_bot',
  'join_tower_queue',       'play_tower_vs_bot',
  'join_car_dash_queue',    'play_car_dash_vs_bot',
  'join_scrabble_queue',    'play_scrabble_vs_bot',
  'join_coin_flip_queue',   'play_coin_flip_vs_bot',
  'join_bj_queue',          'play_bj_vs_bot',
  'wordle_solo_start',
  'create_private_room',
  'invite_friend',
];

test('every staked handler validates the fee before spending anything', () => {
  const src = source();
  for (const name of STAKED) {
    const body = handlerBody(src, name);
    const guard = body.search(GUARD);
    assert.notEqual(guard, -1, `${name} accepts the client's entryFee without checking it against the tier list`);

    const spend = body.search(SPENDS);
    if (spend !== -1) {
      assert.ok(guard < spend, `${name} checks the fee only AFTER it has already moved money`);
    }
  }
});

// The exploit itself, stated as the property that made it work: a stake that is
// not a whole number of diamonds must be impossible to submit. If the tier list
// ever gains a fractional entry, the floor-vs-payout mismatch is back.
test('no diamond tier is fractional, so flooring a stake can never lose value', () => {
  const src = source();
  const line = src.match(/VALID_DIAMOND_FEES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(line, 'VALID_DIAMOND_FEES not found');
  for (const raw of line[1].split(',')) {
    const n = Number(raw.trim());
    assert.ok(Number.isInteger(n) && n >= 0, `diamond tier ${raw.trim()} is not a whole number — Math.floor would deduct less than the payout is computed from`);
  }
});

// Coin stakes are not floored, but an off-tier coin stake is still an off-tier
// payout, and negatives must never appear.
test('every coin tier is a non-negative number', () => {
  const src = source();
  const line = src.match(/VALID_COIN_FEES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(line, 'VALID_COIN_FEES not found');
  for (const raw of line[1].split(',')) {
    const n = Number(raw.trim());
    assert.ok(Number.isFinite(n) && n >= 0, `coin tier ${raw.trim()} is not a valid stake`);
  }
});

// Guards against this file passing for the wrong reason. If the brace matcher
// silently returned something tiny or something enormous, the checks above
// would be reading the wrong text and would still pass.
test('handler bodies are extracted at a plausible size', () => {
  const src = source();
  for (const name of STAKED) {
    const len = handlerBody(src, name).length;
    assert.ok(len > 200, `${name} body came out at ${len} chars — the extractor is not reading the real handler`);
    assert.ok(len < 20000, `${name} body came out at ${len} chars — the extractor ran past the end of the handler`);
  }
});
