// The draw screen inside a bracket, and getting from it into the replay.
//
// A player drew a demo tournament match and was told they had lost, with no
// sudden death ever shown. Three things were wrong at once: the replay started
// while both players were still on their result card, the card did not listen
// for a new match, and the card read a draw as a knockout. These hold the
// client half of the fix; tournament-runner.test.js holds the server half.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = (...p) => path.join(__dirname, '..', '..', 'frontend', 'src', ...p);
const read = (...p) => fs.readFileSync(FE(...p), 'utf8');
const strip = (s) => s
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const ROUND  = strip(read('hooks', 'useTournamentRound.js'));
const RESULT = strip(read('hooks', 'useTournamentResult.js'));
const CARD   = strip(read('components', 'ResultScreen.jsx'));
const BRACKET = strip(read('pages', 'TournamentBracket.jsx'));
const HANDLERS = strip(fs.readFileSync(path.join(__dirname, '..', 'src', 'socket', 'handlers.js'), 'utf8'));

test('the game screen keeps the announcement for the card that mounts after it', () => {
  // The draw and the announcement arrive together, and the card mounts in
  // response to the draw — a listener on the card itself misses it.
  assert.match(ROUND, /socket\.on\('tournament_sudden_death'/,
    'nothing on the game screen hears the draw being announced');
  assert.match(ROUND, /setSudden\(p\)/, 'the announcement is heard and then dropped');
  assert.match(RESULT, /getSudden\(poolId\)/,
    'the card only listens, so it misses an announcement that arrived before it mounted');
});

test('a new match for this pool takes the player into it', () => {
  // The replay is a second match while they are still on the first game's
  // screen. That screen set itself up from its route, so the replay goes
  // through the bracket, whose navigation mounts a fresh game.
  assert.match(ROUND, /socket\.on\('tournament_match'/, 'the game screen ignores the replay');
  assert.match(ROUND, /m\.roomId === roomId\) return/,
    'the match this screen is already playing would bounce the player off it');
  assert.match(ROUND, /state: \{ pending: m \}/, 'the replay is not handed to the bracket');
  assert.match(BRACKET, /navState\?\.pending/, 'the bracket drops a handed-over match');
  assert.match(BRACKET, /navRef\.current\(`\/game\/\$\{m\.game\}`/,
    'the bracket receives the match and does not send the player into it');
});

test('a first draw shows the countdown and the button, not a knockout', () => {
  const at = CARD.indexOf('{tour ? (');
  const branch = CARD.slice(at, CARD.indexOf('tour.over ? (', at));
  assert.match(branch, /isDraw && !tour\.isSuddenRound && !tour\.decided \? \(\s*<SuddenDeathPanel/,
    'a draw falls through to "Knocked out of the tournament"');
});

test('the panel counts to the instant the server sent, and the button says go', () => {
  const panel = CARD.slice(CARD.indexOf('function SuddenDeathPanel'));
  assert.match(panel, /sudden\.startsAt - now/,
    'a card that mounted late would count its own five rather than the real time left');
  assert.match(panel, /onGo\?\.\(\)/, 'the button does nothing');
  assert.match(panel, /Play sudden death/);
  assert.match(RESULT, /emit\('tournament_sudden_ready', \{ poolId \}\)/,
    'pressing go never reaches the server');
});

test('a drawn replay waits for the coin flip rather than calling it', () => {
  const at = CARD.indexOf('{tour ? (');
  const branch = CARD.slice(at, CARD.indexOf('tour.over ? (', at));
  assert.match(branch, /coin flip/i, 'a drawn replay says nothing about how it is settled');
});

test('what the bracket decided outranks what the game read', () => {
  // After sudden death or a coin flip the engine's own reading of the game
  // says nothing about who is through.
  assert.match(RESULT, /iWon: decided \? decided === session\?\.user\?\.id : null/);
  assert.match(CARD, /\(tour\.iWon \?\? isWinner\) \? \(/,
    'the card still decides "next game" or "knocked out" from the game alone');
});

test('the draw banner on the bracket has the same countdown and button', () => {
  // A draw decided at the deadline has no result card: the player lands here.
  assert.match(BRACKET, /useState\(\(\) => getSudden\(id\)\)/,
    'the banner only listens, and the player arrives after the announcement');
  assert.match(BRACKET, /sudden\.players\?\.includes\(me\) && sudden\.startsAt > now/);
  assert.match(BRACKET, /emit\('tournament_sudden_ready', \{ poolId: id \}\)/);
});

test('go is pressed for the socket\'s own player, never an id the client sends', () => {
  const at = HANDLERS.indexOf("socket.on('tournament_sudden_ready'");
  assert.ok(at > 0, 'the server does not listen for go');
  const body = HANDLERS.slice(at, HANDLERS.indexOf('});', at));
  assert.match(body, /suddenReady\(poolId, authenticatedUser\.userId\)/,
    'one player could press go on the other\'s behalf');
});

test('an announced sudden death is a draw on the card, whatever the game said', () => {
  // A demo account's staged draw: the game against the bot reported a win,
  // the bracket announced sudden death. Reading only the game, the card said
  // Victory and offered the next round while the draw screen was running.
  assert.match(CARD, /isDraw: reportedDraw = false/, 'the card still reads the game alone');
  assert.match(CARD, /const isDraw = reportedDraw \|\| !!tour\?\.sudden;/);
  const tourAt = CARD.indexOf('const tour = useTournamentResult();');
  const drawAt = CARD.indexOf('const isDraw = reportedDraw');
  assert.ok(tourAt > 0 && drawAt > tourAt, 'isDraw is worked out before the bracket has been asked');
});

test("the card can't miss who the bracket put through", () => {
  // The result is broadcast in the same instant the game ends, before the card
  // mounts. A card that missed it sat on the draw screen for a draw that had
  // already been settled.
  assert.match(ROUND, /socket\.on\('tournament_result', onDecided\)/,
    'nothing on the game screen keeps the result for the card');
  assert.match(ROUND, /setResult\(r\)/);
  assert.match(RESULT, /getResult\(poolId, tournament\?\.round, tournament\?\.match\)/,
    'the card only listens for a result that may already have gone past');
});

test('the card also reads the match from the bracket it polls', () => {
  // The backstop: whatever was missed, the bracket says who won.
  assert.match(RESULT, /d\?\.pool\?\.bracket\?\.\[tournament\?\.round\]\?\.\[tournament\?\.match\]/);
  assert.match(RESULT, /if \(m\?\.winner\) setDecided\(m\.winner\)/);
});
