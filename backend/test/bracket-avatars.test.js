// Bracket pictures were "not the actual pfps": the bracket drew its own
// avatar — a rounded square, clipped with a CSS inset() iOS Safari ignores on
// SVG images, no ring, a white initial on a dark disc — instead of what
// components/Avatar draws for the same player everywhere else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'Bracket.jsx'), 'utf8');
const code = src.split(/\r?\n/).filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('pictures are clipped to a circle with a real clipPath, not CSS inset()', () => {
  assert.doesNotMatch(code, /inset\(0 round/, 'the Safari-ignored inset() clip is back');
  assert.match(code, /<clipPath id=\{id\}><circle cx=\{cx\} cy=\{cy\} r=\{r\} \/><\/clipPath>/);
  assert.match(code, /clipPath=\{`url\(#\$\{id\}\)`\}/);
});

test('each avatar has its own clip id, or every picture would share one circle', () => {
  // clipPrefix, not the player id: bot ids contain colons, which break url(#).
  assert.match(code, /id=\{`\$\{clipPrefix\}-\$\{r\}-\$\{i\}-\$\{side\}`\}/);
  assert.match(code, /const clipPrefix = useId\(\)\.replace\(\/:\/g, ''\)/, 'colons from useId break url(#...)');
});

test('it looks like Avatar: the ring and tinted initial in the player colour', () => {
  assert.match(code, /const ring = player\?\.profileColor \|\| '#1250B4';/, 'same default colour as Avatar');
  assert.match(code, /fill=\{`\$\{ring\}22`\}/, 'the tinted background');
  assert.match(code, /stroke=\{ring\}/, 'the ring');
  assert.match(code, /textAnchor="middle" fill=\{ring\}/, 'the initial in their colour, not white');
});
