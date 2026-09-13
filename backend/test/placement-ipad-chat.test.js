// Placement on the leaderboard, iPad getting the phone layout, and the phone
// chat handle clearing the bottom bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the leaderboard lists placed players only, at their rating or the 1000 placement gives', () => {
  const src = read('backend', 'src', 'routes', 'leaderboard.js');
  const elo = src.slice(src.indexOf("router.get('/', wrap"), src.indexOf("router.get('/diamonds'"));
  assert.ok(elo.includes('.filter(placed)'), 'unplaced accounts are still listed at 0 ELO');
  assert.ok(elo.includes('const placed = (p) => ((p.wins ?? 0) + (p.losses ?? 0)) >= PLACEMENT;'));
  assert.ok(elo.includes('elo: Number(p.elo) > 0 ? Number(p.elo) : 1000'), 'a placed player with no rating shows 0');
  assert.ok(elo.includes('.sort((a, b) => b.elo - a.elo)'), 'the 1000s are not re-ordered into place');
});

test('displayElo: 0 while unplaced, 1000 when placed with nothing written', async () => {
  const { displayElo } = await import(pathToFileURL(path.join(ROOT, 'frontend', 'src', 'utils', 'ranks.js')).href);
  assert.equal(displayElo({ wins: 1, losses: 1, elo: 1000 }), 0);
  assert.equal(displayElo({ wins: 2, losses: 1, elo: 0 }), 1000);
  assert.equal(displayElo({ wins: 2, losses: 1, elo: null }), 1000);
  assert.equal(displayElo({ wins: 5, losses: 4, elo: 1043 }), 1043);
});

test('a touch tablet never matches the desktop breakpoints', () => {
  const tw = read('frontend', 'tailwind.config.js');
  for (const [name, w] of [['md', 720], ['lg', 1024], ['xl', 1280]]) {
    const q = `{ raw: '(min-width: ${w}px) and (hover: hover) and (pointer: fine)' }`;
    const line = tw.split(/\r?\n/).find(l => l.trim().startsWith(`${name}:`));
    assert.ok(line && line.includes(q), `${name} still matches an iPad by width alone`);
  }
});

test('the phone chat handle sits above the bottom bar, wherever the bar is', () => {
  const chat = read('frontend', 'src', 'components', 'ChatSidebar.jsx');
  assert.ok(chat.includes('{!mobileOpen && showsNav && ('), 'the handle is limited to one page again');
  assert.ok(chat.includes('bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px)+0.75rem)]'), 'the handle is under the bottom bar');
  assert.ok(chat.includes("import { useShowsBottomNav } from './BottomNav';"));
});

test('the left sidebar has no About/Terms/Privacy/Support links', () => {
  const side = read('frontend', 'src', 'components', 'LeftSidebar.jsx');
  for (const p of ["'/about'", "'/tos'", "'/privacy'", "'/support'"]) assert.ok(!side.includes(p), `sidebar still links ${p}`);
});
