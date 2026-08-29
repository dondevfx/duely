// Typing a room code shows the match details before it joins.
//
// The rule that matters is the same one the shared challenge link already
// enforces: joining deducts a real entry fee, so the act of entering a code
// must never be the act of spending money. You see the host and the stake,
// then you accept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const MODAL = strip(fe('components', 'JoinRoomModal.jsx'));

test('submitting a code peeks — it does not join', () => {
  // The submit path must reach peek_private_room and nothing else. If it also
  // called onJoin, the confirm screen would be decoration over a match that
  // had already started and already charged.
  const at = MODAL.indexOf('const submit =');
  assert.notEqual(at, -1, 'the submit handler is gone');
  const body = MODAL.slice(at, MODAL.indexOf('\n  };', at));
  assert.match(body, /peek_private_room/, 'submitting must peek');
  assert.doesNotMatch(body, /onJoin\(/, 'submitting must NOT join — that spends the entry fee');
});

test('only Accept joins', () => {
  const calls = (MODAL.match(/onJoin\(/g) || []).length;
  assert.equal(calls, 1, `onJoin must have exactly one call site, found ${calls}`);
  assert.match(MODAL, /onClick=\{\(\) => \{ onJoin\(info\.code\); onClose\(\); \}\}/,
    'the join must hang off the Accept button, using the code the server confirmed');
});

test('the details actually shown are the ones the server sent', () => {
  // Echoing back what the player typed would show a stake nobody verified.
  for (const field of ['info.hostUsername', 'info.hostElo', 'info.entryFee', 'info.currency']) {
    assert.ok(MODAL.includes(field), `${field} must come from the peek`);
  }
  assert.match(MODAL, /GAME_NAMES\[info\.gameType\]/, 'the game name must come from the peek');
});

test('the stake is spelled out, free included', () => {
  assert.match(MODAL, /'Free'/, "a free room must say Free rather than showing nothing");
  assert.match(MODAL, /CoinIcon/,  'a coin stake shows the coin');
  assert.match(MODAL, /DiamondIcon/, 'a diamond stake shows the diamond');
});

test('a bad code is reported in the modal, not swallowed', () => {
  assert.match(MODAL, /setError\(message/, 'the server message must reach the player');
  assert.match(MODAL, /error \? 'text-danger'/, 'an error must read as an error');
});

test('the error listener is scoped to the peek', () => {
  // 'error' is the server's shared channel. A listener mounted for the life of
  // the modal would show unrelated failures as though the code were bad.
  assert.match(MODAL, /if \(!socket \|\| !peeking\) return;/,
    'the listener must only be mounted while a peek is in flight');
  assert.match(MODAL, /socket\.off\('private_room_info'/, 'and torn down after');
});

test('you cannot join your own room from the code box', () => {
  assert.match(MODAL, /info\.isHost/, 'the host branch must be handled');
  const at = MODAL.indexOf('info && info.isHost');
  const branch = MODAL.slice(at, at + 900);
  assert.doesNotMatch(branch, /onJoin\(/, 'the host must not be offered a join');
});

test('every game gets this — the modal is the single choke point', () => {
  // Six pages enter codes; none of them should be re-implementing the confirm
  // step, and none should be able to skip it.
  const pages = ['CoinFlipGame', 'BlackjackGame', 'TowerGame',
                 'CarDashGame', 'WordleGame', 'BlockBlastGame'];
  let wired = 0;
  for (const page of pages) {
    const src = fe('pages', `${page}.jsx`);
    if (/JoinRoomModal/.test(src)) { wired++; continue; }
    // The rest reach it through the shared lobby.
    assert.match(src, /onJoinPrivate=\{joinPrivate\}/, `${page} has no path to the join modal`);
    wired++;
  }
  assert.equal(wired, pages.length);
  assert.match(strip(fe('components', 'GameLobby.jsx')), /<JoinRoomModal/,
    'the shared lobby must use the same modal');
});

test('the server peek still mutates nothing', () => {
  // The confirm screen is only honest if peeking is genuinely free.
  const src = strip(be('socket', 'handlers.js'));
  const at = src.indexOf("socket.on('peek_private_room'");
  assert.notEqual(at, -1);
  const body = src.slice(at, src.indexOf("socket.on('join_private_room'"));
  assert.doesNotMatch(body, /pendingPrivateRooms\.delete|lockUser|_pairPrivatePlayers/,
    'peeking must not join, lock, or consume the room');
  assert.match(body, /if \(!authenticatedUser\)/,
    'peeking must stay behind auth — 6 characters is a sweepable space');
});
