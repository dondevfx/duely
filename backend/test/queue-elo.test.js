// Every PvP queue used to take the FIRST eligible player, so pairing was purely
// by wait order and rating never entered into it. With three people queued at
// the same stake that is a coin toss between a fair match and a hopeless one.
//
// closestByElo picks the nearest rating from the players ALREADY eligible. It
// deliberately does not gate on a rating band: at low traffic, refusing to match
// because nobody nearby is waiting is worse than an uneven game.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { closestByElo, DEFAULT_ELO } = require('../src/services/queueMatch');

const p = (elo, extra = {}) => ({ elo, socketId: `s${elo}`, ...extra });
const any = () => true;

test('picks the nearest rating, not the longest wait', () => {
  const queue = [p(1600), p(1010), p(1400)];
  const idx = closestByElo(queue, p(1000), any);
  assert.equal(queue[idx].elo, 1010);
});

test('a far-off opponent is still matched when nobody closer is waiting', () => {
  // Bronze vs champion is an acceptable outcome; not playing at all is not.
  const queue = [p(2400)];
  assert.equal(closestByElo(queue, p(900), any), 0);
});

test('eligibility wins over closeness', () => {
  // The nearest player here is at the wrong stake. Rating may only choose
  // BETWEEN valid opponents — it must never promote an invalid one.
  const queue = [
    p(1005, { entryFee: 50 }),   // closest, wrong stake
    p(1900, { entryFee: 1 }),    // far, but the only legal match
  ];
  const idx = closestByElo(queue, p(1000), o => o.entryFee === 1);
  assert.equal(queue[idx].elo, 1900);
});

test('returns -1 when nobody is eligible', () => {
  assert.equal(closestByElo([p(1000, { entryFee: 5 })], p(1000), o => o.entryFee === 1), -1);
  assert.equal(closestByElo([], p(1000), any), -1);
});

test('an equal rating keeps first-come-first-served', () => {
  // Two players at the same distance must not be reordered by the tie-break, or
  // a queue of identically rated players would stop being fair on wait time.
  const queue = [p(1200, { socketId: 'first' }), p(1200, { socketId: 'second' })];
  assert.equal(queue[closestByElo(queue, p(1200), any)].socketId, 'first');
});

test('distance is absolute — above and below count the same', () => {
  const queue = [p(1100), p(950)];   // +100 vs -50
  assert.equal(queue[closestByElo(queue, p(1000), any)].elo, 950);
});

test('a missing rating is treated as the default, not as zero', () => {
  // Reading a missing elo as 0 would make an unrated player the "closest" match
  // for the weakest person queued and the worst for everyone else.
  const queue = [p(undefined), p(1500)];
  const idx = closestByElo(queue, p(1450), any);
  assert.equal(queue[idx].elo, 1500);
  assert.equal(DEFAULT_ELO, 1000);
});

test('a non-numeric rating does not poison the comparison', () => {
  // NaN comparisons are always false, so a bad value could silently win or lose
  // every comparison depending on which side of the < it landed.
  const queue = [p('abc'), p(1200)];
  const idx = closestByElo(queue, p(1190), any);
  assert.equal(queue[idx].elo, 1200);
});

test('every PvP queue actually uses it', () => {
  // The helper is worthless if one engine still calls findIndex directly, and
  // that is exactly the kind of thing that gets missed when adding a game.
  const dir = path.join(__dirname, '..', 'src', 'services');
  for (const f of ['matchmaking.js', 'blackjackEngine.js', 'blockBlastEngine.js',
                   'carDashEngine.js', 'coinFlipEngine.js', 'wordleEngine.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.match(src, /closestByElo\(/, `${f} must select its opponent by rating`);
    assert.match(src, /require\('\.\/queueMatch'\)/, `${f} must import the helper`);
  }
});
