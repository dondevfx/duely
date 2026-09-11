// Rush Hour and Tower: the same smoothness work as Color Rush.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const highway = fs.readFileSync(FE('components', 'HighwayCanvas.jsx'), 'utf8');
const tower   = fs.readFileSync(FE('components', 'TowerCanvas.jsx'), 'utf8');

for (const [name, src] of [['Rush Hour', highway], ['Tower', tower]]) {
  test(`${name} moves by an even frame step, not the raw wobbling timestamp`, () => {
    assert.match(src, /est \+= \(raw - est\) \* 0\.08;/, 'still moved by the raw frame time');
    // The difference is paid back, so the game clock does not drift.
    assert.match(src, /debt \+= raw - est;/);
    assert.match(src, /debt -= pay;/);
    // Paid back gradually — paying it all at once put the wobble straight back.
    assert.match(src, /clamp\(debt \* 0\.05,/);
  });
}

test('Tower draws no blurred shadow and builds nothing per frame it can cache', () => {
  assert.doesNotMatch(tower.replace(/\/\/.*$/gm, ''), /shadowBlur/, 'the 3x pop still blurs every frame');
  assert.match(tower, /getContext\('2d', \{ alpha: false \}\)/);
  assert.match(tower, /if \(!scrim\) \{/, 'the fade gradient is rebuilt every frame');
  assert.match(tower, /const c = shadesOf\(b\.index\);/, 'block colours are formatted every frame');
});

test('the pacing conserves time: a jittery minute adds up to a minute', () => {
  // The same arithmetic as the loops, run on 60Hz frames with +/-4ms jitter.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let est = 0, debt = 0, total = 0, real = 0, maxStep = 0, minStep = 1;
  for (let i = 0; i < 3600; i++) {
    const raw = 1 / 60 + (i % 2 ? 0.004 : -0.004);
    real += raw;
    if (!est || raw > est * 3) { est = raw; debt = 0; }
    est += (raw - est) * 0.08;
    debt += raw - est;
    const pay = clamp(debt * 0.05, -est * 0.2, est * 0.2);
    debt -= pay;
    const dt = est + pay;
    total += dt;
    if (i > 120) { maxStep = Math.max(maxStep, dt); minStep = Math.min(minStep, dt); }
  }
  assert.ok(Math.abs(total - real) < 0.02, `drifted ${total - real}s over a minute`);
  assert.ok(maxStep - minStep < 0.008, 'the steps are no more even than the raw frames');
});
