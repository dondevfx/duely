// The Word VS answer must never reach a client that is still playing for it.
//
// Checked because it was asked about directly: could someone open devtools
// mid-match and read the word? Today they cannot, in either staked mode — but
// nothing stopped a future change from adding it to wordle_start "for
// convenience", so this pins the property rather than leaving it to habit.
//
// Three modes, three different answers:
//
//   PvP           server-authoritative. wordle_start carries only the word
//                 LENGTH and the guess limit. Guesses are evaluated on the
//                 server and only the resulting colours come back.
//   Paid solo     same. The client submits a guess and is told the feedback.
//   Free practice the word IS in client state — and nothing is at stake. No
//                 entry fee, no ELO, no score submitted. Reading it wins
//                 nothing, so it is not worth the round trip to hide.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'wordleEngine.js'), 'utf8');

// The body of one io.*.emit(...) call, by event name.
function emitPayload(event) {
  const at = ENGINE.indexOf(`emit('${event}'`);
  assert.notEqual(at, -1, `${event} is no longer emitted`);
  const open = ENGINE.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < ENGINE.length; i++) {
    if (ENGINE[i] === '{') depth++;
    else if (ENGINE[i] === '}' && --depth === 0) break;
  }
  return ENGINE.slice(open, i + 1);
}

test('the start event does not carry the word', () => {
  const p = emitPayload('wordle_start');
  assert.ok(!/\bword\s*:/.test(p),
    'the answer must not be sent when the match begins — that is the whole game');
  assert.match(p, /wordLength/, 'the client needs the length, which is not the word');
});

test('a guess result carries only the colours, not the answer', () => {
  const p = emitPayload('wordle_guess_result');
  assert.ok(!/room\.word/.test(p),
    'feedback is derived server-side; the word itself must stay there');
});

test('an opponent learns the count, never the letters', () => {
  // Greens from an opponent's guesses would give away letter positions, which
  // is the same leak by a longer route.
  const p = emitPayload('wordle_opponent_progress');
  assert.match(p, /guessCount/);
  assert.ok(!/feedback|guess\s*:|letters/.test(p),
    "an opponent's letters would hand over the answer position by position");
});

test('the word is only revealed once the match is over', () => {
  // resultFor is built inside the settlement path, after a winner exists.
  const at = ENGINE.indexOf('function resultFor');
  assert.notEqual(at, -1, 'resultFor is gone');
  assert.ok(ENGINE.slice(at, at + 600).includes('word:'),
    'the result screen does show the answer, which is correct');
  assert.ok(at > ENGINE.indexOf("emit('wordle_start'"),
    'the reveal must come after the start, not before it');
});

test('the server evaluates guesses rather than trusting the client', () => {
  // A client that scored its own guesses could simply claim it solved it.
  assert.match(ENGINE, /evaluateGuess\(room\.word, guess\)/,
    'grading must happen against the server-held word');
});

test('free practice is the only mode holding the word client-side', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'WordleGame.jsx'), 'utf8');

  // Paid solo must go through the server for every guess.
  assert.match(page, /socket\.emit\('wordle_solo_guess'/,
    'a paid solo guess must be graded by the server');

  // And the local evaluator must be reachable ONLY when there is no session id,
  // which is what distinguishes free practice from a paid game.
  const localAt = page.indexOf('evalGuessLocal(soloWord, guess)');
  assert.notEqual(localAt, -1, 'the practice evaluator is gone');
  const branch = page.slice(Math.max(0, localAt - 400), localAt);
  assert.match(branch, /soloSessionId/,
    'local grading must be gated on there being no server session, or a paid game could grade itself');
});
