// The admin dashboard's shape.
//
// It was one long scroll: stat grids, then tools, then a row of tabs over five
// queues. Everything above the tabs was always rendered, so finding anything
// meant knowing how far down it lived, and there was no way to ask what
// happened over a range somebody had not picked in advance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fe = (...p) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const ADMIN = fe('pages', 'Admin.jsx');
const CHART = fe('components', 'AdminChart.jsx');
const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

test('every section is reachable from the left nav', () => {
  const code = strip(ADMIN);
  // Scoped to the SECTIONS array. Matching `key: '...'` across the whole file
  // also picks up the game labels, the range presets and the metric list —
  // three other tables that happen to share the shape.
  const block = ADMIN.slice(ADMIN.indexOf('const SECTIONS = ['), ADMIN.indexOf('];', ADMIN.indexOf('const SECTIONS = [')));
  const declared = [...block.matchAll(/\{ key: '([a-z]+)',\s+label:/g)].map(m => m[1]);
  assert.deepEqual(declared,
    ['analytics', 'overview', 'attention', 'kyc', 'support', 'transactions', 'users', 'tools']);
  // Declared is not rendered: each one needs a panel keyed off the same value.
  for (const key of declared) {
    const rendered = key === 'analytics'
      ? /\{section === 'analytics' && <AnalyticsPanel \/>\}/.test(code)
      : code.includes(`{section === '${key}' && (`);
    assert.ok(rendered, `the "${key}" section has a nav entry but nothing renders it`);
  }
});

test('nothing was left behind by the move', () => {
  // The point was to reorganise, not to trim. These are the blocks that used
  // to sit in the always-rendered scroll above the tabs.
  for (const marker of [
    'Total Users', 'Total Matches', 'Pending Withdrawals',
    'Active Players (24h)', 'Uncollected Fees', 'Total Fees Claimed',
    'Diamonds in Circulation', 'Coins Paid by Wheels',
    'Matches by Game', 'Total Coins in Circulation',
    'Set Player ELO', 'Remove My Coins',
  ]) {
    assert.ok(ADMIN.includes(marker), `"${marker}" went missing in the restructure`);
  }
});

test('the horizontal tab row is gone, not duplicated', () => {
  const code = strip(ADMIN);
  assert.ok(!/setTab\(/.test(code), 'the old tab state is still being set');
  assert.ok(!/tab === '/.test(code), 'a panel still keys off the old tab state');
  assert.match(code, /const \[section, setSection\]\s+= useState\('analytics'\)/,
    'the page should open on analytics — the reason for the redesign');
});

test('a queue with work in it says so without being opened', () => {
  // The one thing worth keeping from the horizontal tabs.
  const code = strip(ADMIN);
  assert.match(code, /count: d => d\.attention\.length/);
  assert.match(code, /count: d => d\.kycQueue\.length/);
  assert.match(code, /urgent: true/);
});

test('the range picker can date back, not only pick a preset', () => {
  const code = strip(ADMIN);
  assert.equal((code.match(/type="date"/g) || []).length, 2, 'a from and a to');
  assert.match(code, /setPreset\('custom'\)/, 'editing a date must leave the preset behind');
  for (const label of ['Last 7 days', 'Last 30 days', 'Last 90 days', 'Last 12 months', 'Year to date']) {
    assert.ok(ADMIN.includes(label), `missing preset: ${label}`);
  }
  // And the bucket is overridable, since auto is a default rather than a rule.
  for (const b of ['Daily', 'Weekly', 'Monthly']) assert.ok(ADMIN.includes(b));
});

test('the chart tells the truth about zero', () => {
  // An axis that starts at the minimum turns a 2% wobble into a mountain
  // range, and a bucket with nothing in it has to look like nothing.
  assert.match(CHART, /const ticks = \[0, max \/ 2, max\]/, 'the axis starts at zero');
  assert.match(CHART, /const h = v > 0 \? Math\.max\(1, /,
    'a real but tiny value must be visible; a zero must not be');
  assert.match(CHART, /function niceMax/, 'so the top of the axis reads 500, not 487');
});

test('the analytics panel says when a range was truncated', () => {
  // A capped range looks exactly like a quiet one.
  assert.match(ADMIN, /data\?\.truncated\?\.length > 0/);
  assert.match(ADMIN, /these numbers are a floor, not a total/);
});

test('active players is labelled as not addable', () => {
  // It is the one total on the page that is not the sum of its own chart.
  assert.match(ADMIN, /unique per bucket — the total is unique across the whole range, not the sum/);
});
