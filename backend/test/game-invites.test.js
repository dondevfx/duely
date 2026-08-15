// Sending a friend a game invite failed on some games with "Invalid game."
//
// The cause is that one game has two names here: a QUEUE key ('block-blast',
// 'car-dash') that keys the bet-count map the server broadcasts, and a ROOM id
// ('blockBlast', 'carDash') that the invite and private-room APIs take. Both are
// load-bearing, and GameLobby held the first while sending the second — so every
// Block Burst invite was rejected, for demo and real accounts alike.
//
// Nothing about it was demo-specific: the invite path has no demo gating at all,
// which these also check, because two demo accounts inviting each other is the
// case that surfaced it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = (p) => fs.readFileSync(p, 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const be = (...p) => strip(path.join(__dirname, '..', 'src', ...p));
const fe = (...p) => strip(path.join(__dirname, '..', '..', 'frontend', 'src', ...p));

const handlers = be('socket', 'handlers.js');
const lobby    = fe('components', 'GameLobby.jsx');

// Room ids the server will actually build a room for.
const VALID = ['blackjack', 'coin-flip', 'scrabble', 'blockBlast', 'carDash', 'tower'];

test('every accepted game id has a room to build', () => {
  // An id in the allowlist with no case in the switch accepts the invite and
  // then silently does nothing, which is worse than rejecting it.
  for (const g of VALID) {
    assert.ok(handlers.includes(`case '${g}': {`), `no direct-room case for '${g}'`);
  }
});

test('the allowlist and the switch agree in both directions', () => {
  const cases = [...handlers.matchAll(/^ {6}case '([^']+)': \{/gm)].map(m => m[1]);
  for (const c of cases) {
    assert.ok(VALID.includes(c), `'${c}' can be built but is not an accepted invite target`);
  }
});

test('a queue key sent as a game id is normalised, not rejected', () => {
  // Defence in depth: no client spelling should be able to break an invite.
  assert.match(handlers, /const GAME_ALIASES = \{/);
  assert.match(handlers, /'block-blast': 'blockBlast'/);
  assert.match(handlers, /'car-dash':\s+'carDash'/);
  assert.match(handlers, /gameType = canonicalGameType\(gameType\)/);
});

test('private rooms normalise the same way', () => {
  // They take a client gameType and dispatch through the same switch, so they
  // have the same failure mode.
  const n = (handlers.match(/gameType: canonicalGameType\(gameType\)/g) || []).length;
  assert.equal(n, 2, 'both private-room paths should normalise');
});

test('the lobby sends a room id, not its queue key', () => {
  // The server forgives it, but the request should be right as sent.
  assert.match(lobby, /const INVITE_GAME_TYPE = \{/);
  assert.match(lobby, /gameType=\{inviteTypeFor\(gameType\)\}/);
});

test('every queue key a page passes maps to a valid room id', () => {
  // The real regression test: walk what the pages actually hand the lobby and
  // confirm each one ends up as something the server will accept.
  const dir = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages');
  const aliases = {};
  for (const m of lobby.matchAll(/'([\w-]+)':\s*'(\w+)'/g)) aliases[m[1]] = m[2];

  const keys = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('Game.jsx'))) {
    const src = strip(path.join(dir, f));
    for (const m of src.matchAll(/gameType="([\w-]+)"/g)) keys.push({ file: f, key: m[1] });
  }
  assert.ok(keys.length >= 6, `expected every game to declare one, found ${keys.length}`);

  for (const { file, key } of keys) {
    const resolved = aliases[key] || key;
    assert.ok(VALID.includes(resolved),
      `${file} passes '${key}' which resolves to '${resolved}' — not an accepted invite target`);
  }
});

test('the invite path does not gate on demo accounts', () => {
  // Two demo accounts inviting each other has to work; they can already friend
  // each other, and an invite is the next thing they would try.
  const at = handlers.indexOf("socket.on('invite_friend'");
  assert.ok(at > 0, 'invite handler not found');
  const body = handlers.slice(at, handlers.indexOf("socket.on('", at + 10));
  assert.doesNotMatch(body, /isDemo/, 'a demo account must be able to invite another demo account');
});
