// What may move a rating, and what a rating looks like before it exists.
//
// The rules, as asked for:
//   - ELO moves only in a PvP match with a stake (coins or diamonds).
//   - Free matches, solo runs and every bot match — including a diamond bet
//     against a bot — move nothing.
//   - Any match still counts towards the three placement matches.
//   - Until those three are done the rating shows as 0 / Unranked, and no
//     result screen reports a swing.
//   - Win streaks follow the same PvP-with-a-stake rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ratesElo, applyMatchStreaks } = require('../src/services/eloService');
const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');

test('only a staked PvP match rates', () => {
  assert.equal(ratesElo({ vsBot: false, isFree: false }), true, 'a staked PvP match must rate');
  assert.equal(ratesElo({ vsBot: false, isFree: true }), false, 'a free match rated');
  assert.equal(ratesElo({ vsBot: true, isFree: false }), false,
    'a bot match rated — a diamond bet against a bot was the way in');
  assert.equal(ratesElo({ vsBot: true, isFree: true }), false, 'a free bot match rated');
  assert.equal(ratesElo({ vsBot: false, isFree: false, isDraw: true }), false, 'a draw rated');
});

test('every engine asks that one question', () => {
  // Rush Hour and Color Rush had it as `!isFree || !vsBot` — an OR, which
  // rated a free PvP match AND a paid bot match. Both now read the shared rule.
  for (const f of ['towerEngine.js', 'blockBlastEngine.js', 'carDashEngine.js',
                   'colorRushEngine.js', 'wordleEngine.js', 'coinFlipEngine.js',
                   'blackjackEngine.js']) {
    const src = be('services', f);
    assert.match(src, /ratesElo/, `${f} decides rating for itself`);
    assert.ok(!/!isFree \|\| !vsBot/.test(src), `${f} still rates free PvP and paid bot matches`);
  }
});

test('a streak needs a stake, and a real opponent', async () => {
  const noop = { from: () => ({ update: () => ({ eq: async () => ({}) }) }), rpc: async () => ({ data: 1 }) };
  const a = { userId: 'a' }, b = { userId: 'b' };
  const free = await applyMatchStreaks(noop, a, b, { staked: false });
  assert.equal(free.applied, false, 'a free match moved a streak');
  const bot = await applyMatchStreaks(noop, a, { userId: 'bot', isBot: true }, { staked: true });
  assert.equal(bot.applied, false, 'a bot match moved a streak');
});

test('every engine passes the stake through to the streak', () => {
  for (const f of ['towerEngine.js', 'blockBlastEngine.js', 'carDashEngine.js',
                   'colorRushEngine.js', 'wordleEngine.js', 'coinFlipEngine.js',
                   'blackjackEngine.js']) {
    assert.match(be('services', f), /applyMatchStreaks\(supabase, winner, loser, \{ staked: !isFree \}\)/,
      `${f} builds a streak on free play`);
  }
});

test('placement is still reached by playing anything', () => {
  // The counters are what placement reads, and they are NOT gated on the
  // stake — only the rating is. The one exception stays: an unloseable free
  // solo run, which would otherwise be a win for nothing.
  const elo = be('services', 'eloService.js');
  assert.match(elo, /if \(total < 3\) return \{ applied: false, placement: true \}/,
    'the placement hold on ratings is gone');
  const ranks = fe('utils', 'ranks.js');
  assert.match(ranks, /\(profile\?\.wins \?\? 0\) \+ \(profile\?\.losses \?\? 0\)\) >= 3/,
    'placement counts something other than matches played');
});

test('an unplaced account reads 0, not 1000', () => {
  const ranks = fe('utils', 'ranks.js');
  assert.match(ranks, /export function displayElo\(profile\) \{\s*\n\s*return isRanked\(profile\) \? \(profile\?\.elo \?\? 1000\) : 0;/);
  // The leaderboard, the home strip: the number and the badge come from the
  // same place, so they cannot say different things.
  const lb = fe('pages', 'Leaderboard.jsx');
  assert.match(lb, /getDisplayRank\(player\)} size=\{15\} \/>\{displayElo\(player\)\} ELO/);
  assert.match(lb, /getDisplayRank\(profile\)} size=\{15\} \/>\{displayElo\(profile\)\} ELO/);
  assert.match(fe('pages', 'Home.jsx'), /\{ label: 'ELO', value: displayElo\(profile\) \}/);
});

test('no result screen reports a rating that did not move', () => {
  const card = fe('components', 'ResultScreen.jsx');
  // Win, loss and draw all go through this one card, so one rule covers all
  // three: a row only when the account is placed AND a number arrived.
  assert.match(card, /const ratingMoved = elo != null && ranked;/);
  assert.match(card, /const showElo = ranked;/);
  assert.ok(!/entryFee > 0 && elo != null/.test(card),
    'a paid match still shows a rating to an unplaced account');
});
