// The home card's tournament countdown. When one timer ended, the old one
// stayed painted and the next drew on top of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Home.jsx'), 'utf8');
const fn = src.slice(src.indexOf('function TournamentCountdown'));

test('switching between entry open and closed puts down a new element', () => {
  assert.match(fn, /key=\{clock\.joinOpen \? 'open' : 'closed'\}/,
    'the pulsing timer is restyled in place and leaves its old frame behind');
});

test('a timer that has reached zero is not left on the card', () => {
  assert.match(fn, /if \(!clock \|\| clock\.seconds <= 0\) return null;/);
});
