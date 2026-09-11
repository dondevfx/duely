// Color Rush stuttered on tap and the obstacles juddered. Three causes, each
// held here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const canvas = fs.readFileSync(FE('components', 'ColorRushCanvas.jsx'), 'utf8');
const sound  = fs.readFileSync(FE('utils', 'sound.js'), 'utf8');

test('no blurred shadow is drawn every frame on the ball or the diamonds', () => {
  const ball = canvas.slice(canvas.indexOf('function drawBall'), canvas.indexOf('function drawBits'));
  const dia  = canvas.slice(canvas.indexOf('function drawDiamond'), canvas.indexOf('function drawSwitcher'));
  assert.doesNotMatch(ball, /shadowBlur/, 'the ball re-blurs its glow every frame');
  assert.doesNotMatch(dia,  /shadowBlur/, 'every diamond re-blurs its glow every frame');
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
