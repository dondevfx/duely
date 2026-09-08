// The rules of a tournament, as arithmetic.
//
// The money split, the schedule and the game rotation are the parts that have
// to be right, and the parts hardest to check once sixteen live players are
// involved. They are pure functions so they can be checked here instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/services/tournamentFormat');

// ── Money ──────────────────────────────────────────────────────────────────

test('the prizes always add up to the pot, minus the fee', () => {
  // A prize table that does not sum to the pot is a slow leak nothing checks.
  // Rounding three shares to the nearest cent independently can pay out MORE
  // than was collected: 50/30/20 of 15.2 is 7.6 + 4.56 + 3.04, but shift the
  // pot and the three roundings can each go up.
  for (const fee of F.ENTRY_FEES) {
    const { pot, fee: rake, net, prizes } = F.prizesFor(fee);
    assert.equal(pot, fee * F.POOL_SIZE, `pot wrong at ${fee}`);
    const paid = prizes.reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(paid - net) < 0.005,
      `at ${fee}/head the prizes pay ${paid} out of a ${net} pool`);
    assert.ok(Math.abs(pot - rake - paid) < 0.005, 'the pot does not reconcile');
  }
});

test('the fee is five percent, and it is the only cut', () => {
  const { pot, fee, net } = F.prizesFor(10);
  assert.equal(fee, round2(pot * 0.05));
  assert.equal(net, round2(pot - fee));
  function round2(n) { return Math.round(n * 100) / 100; }
});

test('three places are paid, first the most', () => {
  const { prizes } = F.prizesFor(5);
  assert.equal(prizes.length, F.PAID_PLACES);
  assert.ok(prizes[0] > prizes[1] && prizes[1] > prizes[2], `not descending: ${prizes}`);
});

test('second place beats the entry fee', () => {
  // A bracket where only the winner comes out ahead is one nobody enters
  // twice. Sixteen players, three paid, so second and third have to be worth
  // reaching.
  for (const fee of F.ENTRY_FEES) {
    const { prizes } = F.prizesFor(fee);
    assert.ok(prizes[1] > fee, `at ${fee}/head second place returns ${prizes[1]}`);
    assert.ok(prizes[2] > fee, `at ${fee}/head third place returns ${prizes[2]}`);
  }
});

test('the rounding remainder goes to first, never to the platform', () => {
  // Whatever the split leaves over is a player's, not the house's.
  //
  // Sixteen players at a whole number of coins always divides exactly — 50/30/20
  // of 15.2 is 7.60/4.56/3.04 — so the CONFIGURED stakes cannot show whether
  // the rounding is right. A pool that does not divide can: 7 players at 1 coin
  // leaves a net of 6.65, and 30% of that is 1.995. Rounded to the nearest cent
  // the three shares pay 6.66 out of a 6.65 pool, a cent per tournament leaving
  // the platform with nothing counting it.
  const odd = F.prizesFor(1, 7);
  const paidOdd = odd.prizes.reduce((s, p) => s + p, 0);
  assert.equal(paidOdd, odd.net,
    `an uneven split paid ${paidOdd} out of ${odd.net}`);
  assert.ok(paidOdd <= odd.net, 'the prizes paid out more than was collected');

  // And the dust goes to a player, not into the fee.
  const { net, prizes } = F.prizesFor(1);
  assert.equal(prizes.reduce((s, p) => s + p, 0), net,
    'part of the pool was kept back');
});

// ── Schedule ───────────────────────────────────────────────────────────────

const at = (h, m, s = 0) => Date.UTC(2026, 0, 1, h, m, s);

test('a tournament starts every twenty minutes, on the clock', () => {
  for (const [h, m, expectMin] of [[9, 0, 0], [9, 7, 0], [9, 20, 20],
                                   [9, 33, 20], [9, 41, 40], [10, 0, 0]]) {
    const s = F.slotAt(at(h, m));
    assert.equal(new Date(s.startsAt).getUTCMinutes(), expectMin,
      `${h}:${String(m).padStart(2, '0')} belongs to the wrong slot`);
  }
});

test('three an hour, and the next is always twenty minutes on', () => {
  const s = F.slotAt(at(9, 3));
  assert.equal(s.nextStartsAt - s.startsAt, 20 * 60 * 1000);
  assert.equal(new Date(s.nextStartsAt).getUTCHours(), 9);
  assert.equal(new Date(s.nextStartsAt).getUTCMinutes(), 20);
});

test('entry is open for the first five minutes only', () => {
  assert.equal(F.slotAt(at(9, 0)).joinOpen, true);
  assert.equal(F.slotAt(at(9, 4, 59)).joinOpen, true);
  assert.equal(F.slotAt(at(9, 5)).joinOpen, false, 'entry stayed open past the window');
  assert.equal(F.slotAt(at(9, 19)).joinOpen, false);
});

test('joining after the window puts you in the next slot, not this one', () => {
  const s = F.joinableSlot(at(9, 12));
  assert.equal(new Date(s.startsAt).getUTCMinutes(), 20,
    'a late player was put into a tournament that had already started');
  assert.equal(s.joinOpen, true);
});

test('joining during the window puts you in this one', () => {
  const s = F.joinableSlot(at(9, 2));
  assert.equal(new Date(s.startsAt).getUTCMinutes(), 0);
});

test('the countdown to entry closing is the one a player is shown', () => {
  assert.equal(F.slotAt(at(9, 4)).msUntilClose, 60 * 1000);
  assert.equal(F.slotAt(at(9, 9)).msUntilClose, 0, 'a closed window still counted down');
});

test('a full tournament fits between one slot and the next', () => {
  // Four rounds of up to three minutes is twelve, from a window that closes
  // five minutes in — so the longest possible tournament ends at seventeen,
  // and the next slot opens at twenty. This is the arithmetic the whole
  // schedule rests on, and it fails loudly if any of the three numbers moves.
  const PLAY_MS = 3 * 60 * 1000;
  const longest = F.JOIN_WINDOW_MS + F.ROUNDS * PLAY_MS;
  assert.ok(longest < F.SLOT_MS,
    `a tournament can run ${longest / 60000} minutes into a ${F.SLOT_MS / 60000} minute slot`);
});

// ── The games ──────────────────────────────────────────────────────────────

test('blackjack and coin flip are not in a tournament', () => {
  // Both are decided by the deal or the flip rather than by play, and a
  // bracket that can turn on a coin toss is not a bracket.
  assert.ok(!F.TOURNAMENT_GAMES.includes('blackjack'));
  assert.ok(!F.TOURNAMENT_GAMES.includes('coin-flip'));
});

test('every round is a different game', () => {
  for (let seed = 0; seed < 200; seed++) {
    let n = seed;
    const rng = () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const games = F.pickRoundGames(F.ROUNDS, rng);
    assert.equal(games.length, F.ROUNDS);
    assert.equal(new Set(games).size, F.ROUNDS, `repeated a game: ${games}`);
    for (const g of games) assert.ok(F.TOURNAMENT_GAMES.includes(g), `${g} is not a tournament game`);
  }
});

test('there are more games than rounds, so no repeat is ever forced', () => {
  assert.ok(F.TOURNAMENT_GAMES.length > F.ROUNDS,
    'with only as many games as rounds the rotation is fixed, not random');
});

test('asking for more rounds than there are games is an error, not a repeat', () => {
  assert.throws(() => F.pickRoundGames(F.TOURNAMENT_GAMES.length + 1),
    /without repeating/);
});

test('the rotation is reproducible from a seed', () => {
  // Every player must be told the same game for the same round. Drawn
  // independently on two servers, that is two different tournaments.
  const make = () => { let n = 42; return () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); };
  assert.deepEqual(F.pickRoundGames(4, make()), F.pickRoundGames(4, make()));
});

// ── The bracket ────────────────────────────────────────────────────────────

test('sixteen players make four rounds of halving', () => {
  const b = F.emptyBracket(16);
  assert.deepEqual(b.map(r => r.length), [8, 4, 2, 1]);
  assert.equal(b.length, F.ROUNDS);
});

test('the whole shape exists before anyone has played', () => {
  // The waiting screen draws the bracket immediately; growing it a round at a
  // time would make it jump under the player between matches.
  const b = F.emptyBracket(16);
  for (const round of b) {
    for (const m of round) {
      assert.deepEqual(m, { a: null, b: null, winner: null, scores: null });
    }
  }
});

test('first-round pairs are adjacent, because arrival order means nothing', () => {
  const players = Array.from({ length: 16 }, (_, i) => `p${i}`);
  const pairs = F.firstRoundPairs(players);
  assert.equal(pairs.length, 8);
  assert.deepEqual(pairs[0], ['p0', 'p1']);
  assert.deepEqual(pairs[7], ['p14', 'p15']);
});

test('a winner advances to the right side of the right match', () => {
  // Matches 0 and 1 both feed match 0 of the next round, on opposite sides.
  assert.deepEqual(F.advanceTo(0, 0), { round: 1, match: 0, side: 'a' });
  assert.deepEqual(F.advanceTo(0, 1), { round: 1, match: 0, side: 'b' });
  assert.deepEqual(F.advanceTo(0, 2), { round: 1, match: 1, side: 'a' });
  assert.deepEqual(F.advanceTo(2, 1), { round: 3, match: 0, side: 'b' });
});

// ── Who placed ─────────────────────────────────────────────────────────────

function bracketWith({ finalA, finalB, winner, semis }) {
  return [
    [], [],
    semis,
    [{ a: finalA, b: finalB, winner, scores: null }],
  ];
}

test('first and second come out of the final', () => {
  const b = bracketWith({
    finalA: 'alice', finalB: 'bob', winner: 'alice',
    semis: [
      { a: 'alice', b: 'carol', winner: 'alice' },
      { a: 'bob',   b: 'dave',  winner: 'bob'   },
    ],
  });
  const p = F.placings(b);
  assert.equal(p.first, 'alice');
  assert.equal(p.second, 'bob');
});

test('third is whoever lost to the champion, not whoever is listed first', () => {
  // There is no third-place playoff, so the two semi-final losers are
  // separated by who beat them. Without the rule, third place is whichever the
  // array happened to hold first — which is arbitrary, and it is real money.
  const b = bracketWith({
    finalA: 'alice', finalB: 'bob', winner: 'alice',
    semis: [
      { a: 'bob',   b: 'dave',  winner: 'bob'   },   // lost to the RUNNER-UP, listed first
      { a: 'alice', b: 'carol', winner: 'alice' },   // lost to the CHAMPION
    ],
  });
  assert.equal(F.placings(b).third, 'carol',
    'third went to the player who lost to the runner-up');
});

test('an unfinished tournament has no placings', () => {
  const b = bracketWith({
    finalA: 'alice', finalB: 'bob', winner: null,
    semis: [{ a: 'alice', b: 'carol', winner: 'alice' }],
  });
  assert.equal(F.placings(b), null, 'places were awarded before the final was played');
});
