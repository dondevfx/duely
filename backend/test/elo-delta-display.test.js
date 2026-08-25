// A Rush Hour win reported +44, against a gain range of +20..+23.
//
// The rating WRITTEN was always correct. The number DISPLAYED was not: the
// result card computed its delta as (newElo - eloBeforeRef.current), and
// eloBeforeRef is captured on the page when the player joins the queue. The
// server computes the new rating from whatever the profile reads at
// SETTLEMENT. Those diverge whenever a rating moves in between — most often
// the previous match's result landing while this one was queuing or playing:
//
//   queue-time baseline   1000
//   rating at settlement  1022   (previous match's +22 landed)
//   server writes         1044   (a real +22)
//   card shows            +44    (1044 - 1000)
//
// freshRatings already returned winnerBefore/loserBefore for exactly this
// reason. Two engines computed them and threw them away; four never asked
// for them; no page used them. Every game was affected, not just Rush Hour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

// ── The arithmetic that produced +44 ────────────────────────────────────

test('a stale queue-time baseline is what turns +22 into +44', () => {
  const joinedAt = 1000;   // eloBeforeRef captured at queue time
  const atSettle = 1022;   // previous match's result landed in between
  const gain     = 22;
  const written  = atSettle + gain;

  assert.equal(written - joinedAt, 44, 'this is the reported number');
  assert.equal(written - atSettle, gain, 'the rating actually moved by the real gain');
});

test('using the server-supplied before-value always yields a gain in range', () => {
  const { eloGain, eloLoss } = require('../src/services/eloService');
  for (let i = 0; i < 500; i++) {
    const before = 800 + Math.floor(Math.random() * 500);
    const g = eloGain(), l = eloLoss();
    assert.ok((before + g) - before >= 20 && (before + g) - before <= 23, 'gain out of range');
    assert.ok(before - (before - l) >= 17 && before - (before - l) <= 20, 'loss out of range');
  }
});

// ── Every engine sends the before-values ────────────────────────────────

const PVP_ENGINES = [
  ['carDashEngine.js',    'car_dash_result'],
  ['towerEngine.js',      'tower_result'],
  ['blockBlastEngine.js', 'block_blast_result'],
  ['wordleEngine.js',     'wordle_result'],
  ['coinFlipEngine.js',   'coin_flip_result'],
  ['blackjackEngine.js',  'blackjack_result'],
];

for (const [file] of PVP_ENGINES) {
  test(`${file} computes and emits winnerBefore/loserBefore`, () => {
    const src = strip(be('services', file));
    assert.match(src, /winnerBefore/,
      `${file} must destructure the before-values from freshRatings — it already returns them`);
    assert.match(src, /winnerBefore, loserBefore,/,
      `${file} must EMIT them; computing and discarding them is what left the card guessing`);
  });
}

test('the two solo/bot paths send their own before-value', () => {
  // These settle a single human against a bot and emit `newElo`, not
  // winner/loser pairs, so they carry `eloBefore` instead.
  assert.match(strip(be('services', 'towerEngine.js')), /eloBefore,/,
    'tower solo must send the rating it computed from');
  assert.match(strip(be('services', 'blockBlastEngine.js')), /eloBefore:\s*humanEloBefore/,
    'block burst solo must send the rating it computed from');
  assert.match(strip(be('socket', 'handlers.js')), /eloBefore,/,
    'wordle solo settles in handlers.js and must send it too');
});

// ── The card prefers it ─────────────────────────────────────────────────

test('ResultScreen prefers the server before-value over its own stale ref', () => {
  const src = strip(fe('components', 'ResultScreen.jsx'));
  assert.match(src, /const serverBefore = isWinner \? winnerBefore : loserBefore;/,
    'must select the right side of the match');
  assert.match(src, /const eloBefore = serverBefore \?\? eloBeforeRef\?\.current \?\? null;/,
    'the server value must take precedence, with the old ref only as a fallback');
});

test('every game page passes the before-values through', () => {
  const pages = [
    'CarDashGame.jsx', 'TowerGame.jsx', 'BlockBlastGame.jsx',
    'WordleGame.jsx', 'CoinFlipGame.jsx', 'BlackjackGame.jsx',
  ];
  for (const p of pages) {
    const src = fe('pages', p);
    assert.match(src, /winnerBefore=\{/,
      `${p} renders ResultScreen without winnerBefore — that page still shows the stale delta`);
    assert.match(src, /loserBefore=\{/, `${p} is missing loserBefore`);
  }
});
