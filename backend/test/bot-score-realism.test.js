// A bot opponent must finish on the number the player watched all match, and
// must sometimes end its own run — "Jake has 20 score, then I die and Jake
// jumps to 25" is what a bot looks like when neither is true.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
const TOWER = read('towerEngine.js');
const BLOCK = read('blockBlastEngine.js');
const RUSH  = read('carDashEngine.js');
const COLOR = read('colorRushEngine.js');

for (const [name, src, live] of [['Tower', TOWER, "room.pingScores['bot']"], ['Block Burst', BLOCK, "room.pingScores['bot']"]]) {
  test(`${name}: the card prints the score that was on screen, not a fresh one`, () => {
    assert.ok(src.includes(`const shown = ${live};`), `${name} recalculates the bot's final score`);
    assert.match(src, /let botScore = shown != null \? shown : Math\.floor\(verified/,
      `${name} still prefers the recalculated score`);
  });
}

test('Block Burst: the live score keeps up, so it is at the target when the run ends', () => {
  assert.match(BLOCK, /Math\.ceil\(gap \/ 3\)/, 'a lagging ticker means the final card jumps');
});

for (const [name, src, key] of [['Rush Hour', RUSH, 'car_dash'], ['Color Rush', COLOR, 'color_rush']]) {
  test(`${name}: a third of bot matches, the bot ends its own run around 30s`, () => {
    assert.match(src, /botDiesAtMs: demoWin && Math\.random\(\) < 0\.33\s*\n\s*\? 27_000 \+ Math\.floor\(Math\.random\(\) \* 6_000\)\s*\n\s*: 0,/,
      `${name} has no bot death, or not at the stated odds`);
    // The player is told, and the match is NOT resolved there — they play on.
    const told = src.includes(`emit('${key}_opponent_died', { ms })`)
              || src.includes(`emit('${key}_opponent_crashed', { ms })`);
    assert.ok(told, `${name} never tells the player the opponent went out`);
    const at = src.indexOf('if (fresh.botDiesAtMs) {');
    assert.ok(at > 0, `${name} does not schedule it`);
    const body = src.slice(at, src.indexOf('fresh.botTimers.push(dies);', at));
    assert.doesNotMatch(body, /_resolveFromTimes|_maybeResolve/, 'the match must end on the PLAYER\'s run, not here');
    assert.match(body, /r\.times\[human\.socketId\] != null\) return;/, 'a player who died first would still see it');
  });

  test(`${name}: the opponent's final time is the one their bar showed`, () => {
    assert.match(src, /const shown = room\.progress\[_botKey\(room\)\] \?\? Math\.floor\(hT \* \(room\.botTrail \?\? 0\.85\)\);/,
      `${name} draws a new time on the result card`);
    // The per-match variation lives on the bar itself, so the shown time is
    // never a constant fraction AND is the one that gets printed.
    assert.match(src, /botTrail: 0\.58 \+ Math\.random\(\) \* 0\.34,/,
      `${name} trails at one fixed pace in every match`);
    assert.match(src, /const diedOwn = room\.times\[_botKey\(room\)\] != null && room\.botDiesAtMs/,
      `${name} overwrites a bot that really did end its own run`);
  });
}

test('a bot that died first still cannot out-score the player it is meant to lose to', () => {
  for (const [name, src] of [['Rush Hour', RUSH], ['Color Rush', COLOR]]) {
    const at = src.indexOf('if (diedOwn) {');
    const body = src.slice(at, at + 400);
    assert.match(body, /Math\.min\(room\.scores\[_botKey\(room\)\] \?\? 0, hS - 1\)/, `${name}: the bot could win on score`);
  }
});
