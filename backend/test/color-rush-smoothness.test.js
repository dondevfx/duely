// Color Rush stuttered on tap and the obstacles juddered. Three causes, each
// held here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const canvas = fs.readFileSync(FE('components', 'ColorRushCanvas.jsx'), 'utf8');
const sound  = fs.readFileSync(FE('utils', 'sound.js'), 'utf8');

test('the diamonds cost nothing to glow, and the ball keeps its own', () => {
  const ball = canvas.slice(canvas.indexOf('function drawBall'), canvas.indexOf('function drawBits'));
  const dia  = canvas.slice(canvas.indexOf('function drawDiamond'), canvas.indexOf('function drawSwitcher'));
  // There are many diamonds on screen and one ball. Replacing the ball's
  // blurred glow with flat rings read as an OUTLINE around it rather than as
  // a light, so the ball keeps the real thing; the diamonds, which are the
  // volume, keep the cheap halo.
  assert.doesNotMatch(dia, /shadowBlur/, 'every diamond re-blurs its glow every frame');
  assert.match(ball, /shadowBlur = 16 \+ S\.pulse \* 22;/, 'the ball glow is gone again');
});

test('the frame is drawn at the real moment, not the last fixed step', () => {
  assert.match(canvas, /tDraw = S\.simT \+ ahead;/);
  assert.match(canvas, /const th = angleOf\(o, tDraw\);/, 'obstacles still drawn at the stepped time');
  assert.match(canvas, /sy\(yDraw\)/, 'the ball is still drawn at the stepped position');
});

test('a tap does not build a new noise buffer', () => {
  const nb = sound.slice(sound.indexOf('function noiseBurst'), sound.indexOf('let _noise'));
  assert.doesNotMatch(nb, /createBuffer\(/, 'every tap fills a fresh buffer on the main thread');
  assert.match(nb, /noiseBuffer\(ac\)/);
});
