// The Word VS bot.
//
// It used to guess on a 1.5-3 second timer regardless of the player, and it
// filtered candidates properly — so it could solve the word first and a slow
// player lost a match they were never really in. A bot match should ask one
// question: can YOU solve it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'wordleEngine.js'), 'utf8');
const engine = require('../src/services/wordleEngine');

// The socket surface the engine touches, and nothing more.
const fakeIo = () => ({ to: () => ({ emit() {} }), emit() {} });

function room(engineRooms, roomId) { return engineRooms.get(roomId); }

// Drives a real bot room: creates it, starts the bot, and lets the test act as
// the human by calling the engine's own guess handler.
async function botRoom() {
  const human = { socketId: 'human', userId: 'u-human', username: 'Ann', entryFee: 0, currency: 'coins' };
  const bot   = { socketId: 'bot',   userId: 'u-bot',   username: 'Bot', entryFee: 0, currency: 'coins', isBot: true };
  const { roomId } = engine.createDirectWordleRoom(human, bot);
  const rooms = engine._rooms();
  rooms.get(roomId).startedAt = Date.now();
  return { roomId, rooms, human, bot };
}

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// Settling the room stops the bot loop; clearing the room's own timers is what
// lets the process exit. A guess arms an idle timer and a fail timer, and those
// are ordinary setTimeouts holding the event loop open — in the server that is
// invisible behind the HTTP listener, in a test run it is a file that passes
// every assertion and then hangs for a minute.
function stop(rooms, roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  r.settled = true;
  if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  if (r.failTimer) { clearTimeout(r.failTimer); r.failTimer = null; }
  engine.deleteWordleRoom(roomId);
}

test('the bot never plays the answer', async () => {
  // Asserted on the code as well as behaviour: the old rule was conditional on
  // a demo account, which made "the bot can win" the default.
  assert.match(SRC, /const notTheWord = \(w\) => w !== fresh\.word;/);
  assert.ok(!/fresh\.demoWin && guess === fresh\.word/.test(SRC),
    'avoiding the answer must not be conditional on the room being a demo');
});

test('the bot waits for the player instead of a timer', async () => {
  assert.match(SRC, /if \(humanGuesses - behindBy > guessNum\) break;/);
  assert.ok(!/const delay = 1500 \+ Math\.floor\(Math\.random\(\) \* 1500\)/.test(SRC),
    'the free-running clock is what let the bot get ahead');
});

test('the bot stays exactly one guess behind, over a whole game', async () => {
  const { roomId, rooms } = await botRoom();
  const io = fakeIo();
  engine.scheduleBotWordleMove(io, null, roomId, 'bot');

  const r = room(rooms, roomId);
  const wrong = ['CRANE', 'SLOTH', 'PIQUE', 'MOUNT', 'BLAZE'].filter(w => w !== r.word);

  try {
  for (let i = 0; i < 4; i++) {
    await engine.handleWordleGuess(io, null, roomId, 'human', wrong[i]);
    // Long enough to cover the bot's 600-1500ms reply beat.
    await tick(2200);
    const cur = room(rooms, roomId);
    if (!cur || cur.settled) break;
    const humanN = cur.pstate.human.guesses.length;
    const botN   = cur.pstate.bot.guesses.length;
    assert.equal(botN, Math.max(0, humanN - 1),
      `after ${humanN} player guesses the bot should have ${humanN - 1}, had ${botN}`);
    assert.ok(!cur.pstate.bot.solved, 'the bot solved the word');
  }
  } finally { stop(rooms, roomId); }
});

test('the bot never guesses before the player does', async () => {
  const { roomId, rooms } = await botRoom();
  engine.scheduleBotWordleMove(fakeIo(), null, roomId, 'bot');
  // Well past the old 1.5-3s timer: on the old code the bot had guessed twice
  // by now without the player touching the board.
  await tick(4000);
  const cur = room(rooms, roomId);
  try {
    assert.equal(cur.pstate.bot.guesses.length, 0, 'the bot moved on its own clock');
  } finally { stop(rooms, roomId); }
});

test('failing to solve loses the bot match, whatever the tiles say', () => {
  // The bot never solves, so nobody solves when the player fails — and the
  // greens tiebreaker would then award the win on a technicality against an
  // opponent that was never trying.
  const settle = SRC.slice(SRC.indexOf('const botP = room.players.find(p => p.isBot);'));
  assert.match(settle.slice(0, 600), /winnerPlayer = solved \? humanP : botP;/);
  const tiebreak = SRC.indexOf('Both failed — compare best guess score');
  const override = SRC.indexOf('const botP = room.players.find(p => p.isBot);');
  assert.ok(override > tiebreak, 'the bot rule must come after the tiebreaker to override it');
});

test('the demo special case is gone, because the rule now covers it', () => {
  // demoWin forced the demo account to win a bot match. With the bot unable to
  // solve and the player judged only on solving, a demo wins by solving like
  // anyone else — and loses by not, which is the honest outcome.
  assert.ok(!/if \(room\.demoWin\) \{[\s\S]{0,200}winnerPlayer = demoP/.test(SRC));
});

// ── The Home grid ─────────────────────────────────────────────────────────

test('Home is one grid of nine cells, with the card as the last', () => {
  // Eight games plus How Duely Works is exactly 3x3, which is why three
  // columns and not four: four leaves the last row holding one game and a
  // card with two empty cells beside them.
  const HOME = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Home.jsx'), 'utf8');
  assert.match(HOME, /grid grid-cols-2 xl:grid-cols-3/);
  const grid = HOME.slice(HOME.indexOf('grid grid-cols-2 xl:grid-cols-3'));
  const cardAt = grid.indexOf('<HowDuelyWorks />');
  const gamesAt = grid.indexOf('GAMES.map');
  assert.ok(gamesAt > 0 && cardAt > gamesAt, 'the card must be the last cell, after the games');
  assert.ok(cardAt < grid.indexOf('</div>', cardAt) , 'and inside the grid');
});

test('the card fills its cell rather than overflowing it', () => {
  // aspect-square is a ratio, not a clamp: at 271px the card wanted 292px, so
  // the bottom row grew and the two games beside it sat with a gap under
  // them. The xl: sizes are what make it fit.
  const HOME = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Home.jsx'), 'utf8');
  const comp = HOME.slice(HOME.indexOf('function HowDuelyWorks()'), HOME.indexOf('function DailySpinWidget'));
  assert.match(comp, /col-span-2 xl:col-span-1/, 'full width on a phone, one cell on a desktop');
  assert.match(comp, /xl:aspect-square/);
  for (const cls of ['xl:p-4', 'xl:mb-2', 'xl:space-y-1.5', 'xl:mt-3']) {
    assert.ok(comp.includes(cls), `${cls} is part of making it fit the square`);
  }
});

test('three columns waits for xl, where the sidebars leave room', () => {
  // The page loses 240px to the left nav from md and another 320px to world
  // chat from lg. Three columns below xl measured 175px on an iPad portrait
  // and 189px on landscape — smaller than the 169px a phone gives in a window
  // a third the size.
  const HOME = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Home.jsx'), 'utf8');
  assert.ok(!/grid-cols-2 (md|lg):grid-cols-3/.test(HOME),
    'three columns before xl makes the cards smaller than a phone gives');
  assert.match(HOME, /max-w-3xl xl:max-w-5xl/, 'and the container has to widen with it');
});
