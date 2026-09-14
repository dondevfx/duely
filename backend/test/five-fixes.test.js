// Date input fit, placed players on the leaderboard, the Rewards title, the
// leaderboard's Rank column, and Rush Hour filling the screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');

test('the self-exclusion date input drops its native width', () => {
  const p = fe('pages', 'Profile.jsx');
  const input = p.slice(p.indexOf('id="self-exclude-until"'), p.indexOf('/>', p.indexOf('id="self-exclude-until"')));
  assert.ok(input.includes('appearance-none') && input.includes("WebkitAppearance: 'none'"), 'iPhone draws it at its own width');
  assert.ok(input.includes('max-w-full min-w-0'));
});

test('a placed player is on the ELO board even with no wins', () => {
  const lb = fe('pages', 'Leaderboard.jsx');
  assert.ok(lb.includes("if (tab?.id === 'elo') return isRanked(p);"));
  assert.ok(!lb.includes("if (tab?.id === 'elo') return (p.wins ?? 0) > 0;"), 'three losses still hides a placed player');
});

test('the Rank column is two of ten, in the headers and the rows alike', () => {
  const lb = fe('pages', 'Leaderboard.jsx');
  assert.ok(!lb.includes('<span className="col-span-1">Rank</span>'), 'Rank is still squeezed into one column');
  assert.equal((lb.match(/<span className="col-span-2">Rank<\/span>/g) || []).length, 2);
  assert.equal((lb.match(/<span className="col-span-2 flex items-center">\s*<RankBadge/g) || []).length, 2, 'rows would not line up with the header');
});

test('Rewards is titled "Rewards" at the top, with no subtitle', () => {
  const r = fe('pages', 'Rewards.jsx');
  assert.ok(r.includes('>Rewards</h1>'));
  assert.ok(!r.includes('Daily Rewards</h1>'));
  assert.ok(!r.includes('Spin your rank wheels and the daily wheel'));
  assert.ok(r.indexOf('>Rewards</h1>') < r.indexOf('<ReferralCard />'), 'the title is not the first thing on the page');
});

test('Rush Hour sizes from its container, rounds up, and follows it as it resizes', () => {
  const h = fe('components', 'HighwayCanvas.jsx');
  assert.ok(h.includes('const box = canvas.parentElement;'));
  assert.ok(!/H = canvas\.clientHeight \|\| 640;/.test(h.replace(/H = box\?\.clientHeight \|\| canvas\.clientHeight \|\| 640;/, '')), 'still measured from its own pinned height');
  assert.ok(h.includes('Math.ceil(H * dpr)'), 'the buffer can stop a pixel short');
  assert.ok(h.includes('ro?.observe(canvas.parentElement);') && h.includes('ro?.disconnect();'));
});
