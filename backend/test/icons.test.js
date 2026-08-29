// The drawn icon sets: games, menu, ranks and the diamond.
//
// These replaced emoji that were copied as literals into a dozen lists each.
// The failure mode is never a crash — it is one list that kept its emoji, so
// the same thing wears two faces on two screens, or a component used without
// being imported, which BUILDS FINE and only crashes when the page renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const fe = (...p) => fs.readFileSync(FE(...p), 'utf8');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsx')) out.push(p);
  }
  return out;
};

// ── Every component used is imported ────────────────────────────────────────

test('nothing uses an icon component it has not imported', () => {
  // This is the one that matters most: an undefined component passes the
  // build and throws at render, which is how a missing GameIcon import in the
  // sidebar shipped as a blank page rather than a build failure.
  const bad = [];
  for (const file of walk(FE())) {
    const src = fs.readFileSync(file, 'utf8');
    for (const c of ['GameIcon', 'UiIcon', 'RankIcon', 'DiamondIcon']) {
      if (!new RegExp(`<${c}[\\s/>]`).test(src)) continue;
      // Accepts every import form the codebase actually uses, including
      // `import UiIcon, { RakebackTierIcon } from './UiIcon'` — matching only
      // `import X from` reported that one as missing.
      //
      // Checked against the import LINES rather than the whole file, so a
      // mention of the name in a comment cannot pass for an import.
      const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l)).join('\n');
      if (new RegExp(`\\b${c}\\b`).test(imports)) continue;
      bad.push(`${path.basename(file)} uses <${c}> without importing it`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

// ── Coverage ────────────────────────────────────────────────────────────────

test('every game has a drawing, and no two games share one', () => {
  const src = fe('components', 'GameIcon.jsx');
  const map = src.slice(src.indexOf('const ICONS = {'), src.indexOf('};', src.indexOf('const ICONS = {')));
  const arts = [...map.matchAll(/:\s*(\w+),/g)].map(m => m[1]);
  for (const key of ['blockBlast', 'coin-flip', 'blackjack', 'carDash', 'colorRush', 'tower', 'scrabble', 'quickMatch']) {
    assert.match(map, new RegExp(`'?${key}'?:`), `no icon for ${key}`);
  }
  assert.equal(new Set(arts).size, arts.length, `two games share an icon: ${arts}`);
});

test('the coin flip icon is the coin from the game, not the C Coin', () => {
  // The gold coin here was the site's currency, which is a different thing —
  // the in-game coin is blue metal with a white H on the heads face.
  const src = fe('components', 'GameIcon.jsx');
  const fn = src.slice(src.indexOf('function CoinFlip'), src.indexOf('function Blackjack'));
  assert.match(fn, /#1250B4|#A0D8FF/i, 'it should use the game coin\'s blue');
  assert.match(fn, />H</, 'and carry the H of the heads face');
  assert.doesNotMatch(fn, /#F5C518/i, 'that gold is the C Coin, not this game');
});

test('every menu entry has a drawn icon', () => {
  const ui = fe('components', 'UiIcon.jsx');
  for (const name of ['home', 'games', 'rewards', 'profile', 'leaderboard', 'wallet', 'tip', 'rakeback']) {
    assert.match(ui, new RegExp(`^  ${name}: `, 'm'), `no menu icon for ${name}`);
  }
  // They must take the menu item's colour, which an emoji cannot do — that is
  // the whole reason the active state reads as active.
  assert.match(ui, /stroke: 'currentColor'/);

  // And both menus must actually ask for them.
  for (const f of [['components', 'LeftSidebar.jsx'], ['components', 'Navbar.jsx']]) {
    assert.match(fe(...f), /<UiIcon name=\{item\.ui\}/, `${f[1]} still draws its own menu icons`);
  }
});

test('every rank has a badge, drawn in that rank\'s own colour', () => {
  const src = fe('components', 'RankIcon.jsx');
  for (const name of ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Unranked']) {
    assert.match(src, new RegExp(`  ${name}:`), `no badge for ${name}`);
  }
  // The colour comes from utils/ranks.js rather than being repeated here, so
  // the badge and the rank text cannot disagree.
  assert.match(src, /rank\?\.color/);
  assert.doesNotMatch(src, /#cd7f32|#ffd700|#ff1744/i,
    'rank colours must come from ranks.js, not be copied into the icon');
});

// ── The emoji are actually gone ─────────────────────────────────────────────

test('no rank still renders as an emoji medal', () => {
  const bad = [];
  for (const file of walk(FE())) {
    const src = fs.readFileSync(file, 'utf8');
    // getRank(...).icon / getDisplayRank(...).icon rendered directly.
    if (/getRank\([^)]*\)\.icon|getDisplayRank\([^)]*\)\.icon/.test(src)) {
      bad.push(path.basename(file));
    }
  }
  assert.deepEqual(bad, [], `still rendering the rank emoji: ${bad.join(', ')}`);
});

test('the diamond currency is drawn, not an emoji, wherever it labels an amount', () => {
  // Chat tips and the admin tools are prose and internal tooling — an emoji in
  // a sentence is fine. What must not survive is the emoji standing in for the
  // currency next to a number, which is what players read.
  const allowed = new Set(['ChatSidebar.jsx', 'Admin.jsx']);
  const bad = [];
  for (const file of walk(FE())) {
    const name = path.basename(file);
    if (allowed.has(name) || name === 'DiamondIcon.jsx') continue;
    // Comments may mention it — they describe the old behaviour. Block
    // comments are blanked out rather than skipped line-by-line, because a
    // continuation line inside /* … */ starts with neither // nor *, and
    // checking only the line prefix reported two of those as real usages.
    const src = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^[ \t]*\/\/.*$/gm, '');
    src.split(/\r?\n/).forEach((line, i) => {
      if (line.includes('\u{1F48E}')) bad.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `diamond emoji still labelling amounts: ${bad.join(', ')}`);
});

// ── Ordering ────────────────────────────────────────────────────────────────

test('the games are in the same order in all three places they are listed', () => {
  const ORDER = ['quick-match', 'block-blast', 'car-dash', 'coin-flip', 'color-rush', 'tower', 'scrabble', 'blackjack'];

  const grid = [...fe('data', 'games.js').matchAll(/slug:\s*'([a-z-]+)'/g)].map(m => m[1]);
  assert.deepEqual(grid, ORDER, 'the home and games grid is out of order');

  // The sidebar and navbar list routes, so compare on the route's last part.
  const routes = (src, re) => [...src.matchAll(re)].map(m => m[1]);
  const side = routes(fe('components', 'LeftSidebar.jsx'), /route: '\/game\/([a-z-]+)'/g);
  assert.deepEqual(side, ORDER, 'the sidebar is out of order');

  const nav = routes(fe('components', 'Navbar.jsx'), /to: '\/game\/([a-z-]+)'/g);
  assert.deepEqual(nav, ORDER, 'the navbar game list is out of order');
});

// ── Color Rush audio ────────────────────────────────────────────────────────

test('Color Rush has a tap, a pickup and a death sound, and the tap is the quietest', () => {
  const snd = fe('utils', 'sound.js');
  for (const fn of ['playCrTap', 'playCrDiamond', 'playCrDeath']) {
    assert.match(snd, new RegExp(`export function ${fn}\\(`), `missing ${fn}`);
  }
  const body = (fn) => snd.slice(snd.indexOf(`export function ${fn}(`), snd.indexOf('}', snd.indexOf(`export function ${fn}(`)));
  const loudest = (fn) => Math.max(...[...body(fn).matchAll(/gain: ([\d.]+)/g)].map(m => Number(m[1])));

  // The tap fires about eleven times per obstacle. At the level of the other
  // games' feedback it is a machine gun, so it has to stay well under them.
  assert.ok(loudest('playCrTap') < loudest('playCrDiamond'),
    'the tap must be quieter than the pickup — it fires far more often');
  assert.ok(loudest('playCrTap') <= 0.06,
    `the tap peaks at ${loudest('playCrTap')} — too loud for something this frequent`);

  // And the canvas must actually play them.
  const canvas = fe('components', 'ColorRushCanvas.jsx');
  assert.match(canvas, /playCrTap\(\);/,     'the tap must fire on tap');
  assert.match(canvas, /playCrDiamond\(\);/, 'the pickup must fire on a diamond');
  assert.match(canvas, /playCrDeath\(\);/,   'the death must fire on death');
});
