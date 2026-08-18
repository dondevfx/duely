// Why a won match reported +4 instead of +20.
//
// calculateNewRatings returns an ABSOLUTE rating, and every engine fed it the
// elo cached on the socket when the player joined the queue. Those drift apart
// the moment the player finishes another match, and writing an absolute value
// derived from a stale baseline produces a delta that is not the gain at all:
//
//   socket says 1000, profile is actually 1016
//   calculateNewRatings(1000, 1000) -> 1020
//   writing 1020 over 1016 is +4, on a win worth +20
//
// Reported from a real Rush Hour diamond bot match. It had been fixed in Tower
// alone, by hand, and left in the other five engines — so this asserts the
// property across all six rather than for the one that was reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { freshRatings, calculateNewRatings } = require('../src/services/eloService');

const ENGINES = ['carDashEngine', 'blockBlastEngine', 'wordleEngine',
                 'blackjackEngine', 'coinFlipEngine', 'towerEngine'];

const src = (f) => fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', f + '.js'), 'utf8')
  .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

// A profile table that disagrees with the socket, which is the whole bug.
const dbWithElo = (byId) => ({
  from: () => ({
    select: () => ({
      eq: (_c, id) => ({ single: async () => ({ data: { elo: byId[id] } }) }),
    }),
  }),
});

test('the baseline comes from the profile, not the socket', async () => {
  const db = dbWithElo({ u1: 1016 });
  const r = await freshRatings(db, { userId: 'u1', elo: 1000 }, { isBot: true, elo: 1000 });

  assert.equal(r.winnerBefore, 1016, 'the current rating is what the swing is measured from');
  const gain = r.newWinnerElo - r.winnerBefore;
  assert.ok(gain >= 20 && gain <= 23, 'a win moved the rating by ' + gain + ', not the 20-23 a win is worth');
});

test('the stale baseline really did produce the reported +4', () => {
  // Pins the diagnosis rather than only the fix: with the socket value as the
  // baseline, the write lands a few points above a profile 16 points ahead.
  const cached = 1000, actual = 1016;
  const { newWinnerElo } = calculateNewRatings(cached, 1000);
  const apparent = newWinnerElo - actual;
  assert.ok(apparent >= 4 && apparent <= 7,
    'expected the old path to show roughly +4, got +' + apparent + ' — if this is wrong the diagnosis is wrong');
});

test('a loss moves by a loss, not by whatever the drift happens to be', async () => {
  const db = dbWithElo({ u1: 1016 });
  const r = await freshRatings(db, { isBot: true, elo: 1000 }, { userId: 'u1', elo: 1000 });
  const drop = r.loserBefore - r.newLoserElo;
  assert.ok(drop >= 17 && drop <= 20, 'a loss moved the rating by ' + drop + ', not the 17-20 a loss costs');
});

test('a bot keeps its nominal rating — it has no profile to read', async () => {
  const db = dbWithElo({ u1: 1016 });
  const r = await freshRatings(db, { userId: 'u1', elo: 1000 }, { isBot: true, elo: 1000 });
  assert.equal(r.loserBefore, 1000);
});

test('a failed read falls back rather than failing the settlement', async () => {
  // A rating that moves by slightly the wrong amount beats a match that does
  // not settle at all.
  const broken = { from: () => ({ select: () => ({ eq: () => ({ single: async () => { throw new Error('down'); } }) }) }) };
  const r = await freshRatings(broken, { userId: 'u1', elo: 1007 }, { isBot: true, elo: 1000 });
  assert.equal(r.winnerBefore, 1007, 'it must fall back to the cached value');
});

test('no engine still computes ratings from a cached value', () => {
  // The fix was applied to Tower by hand and left everywhere else. Asserting it
  // per engine is what stops that happening again.
  for (const e of ENGINES) {
    assert.ok(!/calculateNewRatings\(/.test(src(e)),
      e + ' still calls calculateNewRatings directly — its baseline is the socket stale copy');
  }
});

test('every engine settles through the shared helper', () => {
  for (const e of ENGINES) {
    assert.match(src(e), /freshRatings\(/, e + ' does not read the current rating');
  }
});
