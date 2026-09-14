// Profile: the name editor fits a phone, and the picture menu uses drawn icons.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');

test('the name editor stacks on a phone and its input can shrink', () => {
  const src = read('pages', 'Profile.jsx');
  assert.ok(src.includes('<div className="flex flex-col sm:flex-row gap-2 min-w-0">'), 'input and buttons still share one row on a phone');
  assert.ok(src.includes('className="w-full min-w-0 sm:flex-1 bg-bg'), 'the input cannot shrink below its built-in width');
});

test('the picture menu has no emoji, only drawn icons', () => {
  const src = read('pages', 'Profile.jsx');
  const a = src.indexOf('Choice menu: colour, or a photo.');
  const menu = src.slice(a, src.indexOf('Color picker popup', a));
  for (const e of ['🎨', '🖼', '⏳', '✕']) assert.ok(!menu.includes(e), `the menu still shows ${e}`);
  for (const n of ['palette', 'image', 'loading', 'trash']) {
    assert.ok(menu.includes(`<UiIcon name="${n}"`), `the menu does not use the ${n} icon`);
    assert.ok(read('components', 'UiIcon.jsx').includes(`  ${n}: () => (`), `UiIcon has no ${n} icon`);
  }
});
