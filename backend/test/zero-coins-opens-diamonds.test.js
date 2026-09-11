// A player with no coins lands on the diamonds betting screen, so a new
// account can play with its welcome diamonds straight away.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'context', 'CurrencyContext.jsx'), 'utf8');

test('a game screen with no coins opens on diamonds', () => {
  assert.match(src, /pathname\.startsWith\('\/game\/'\)/, 'not limited to the game betting screens');
  assert.match(src, /coins <= 0 && diamonds > 0\) setDisplayCurrency\('diamonds'\)/);
});

test('it never overrides a currency the navigation asked for, or a switch made on the screen', () => {
  assert.match(src, /if \(state\?\.betCurrency\) return;/);
  assert.match(src, /appliedFor\.current === pathname\) return;/,
    'a player switching back to coins would be switched again on every profile refresh');
});
