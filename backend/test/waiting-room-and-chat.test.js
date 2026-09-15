// Leaving the tournament screens leaves the tournament; a waiting-room leave is
// pushed at once; chat keeps the last hour; Duely Bot does not chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');

const { createStore } = require('../src/services/tournamentPools');
const { createRunner } = require('../src/services/tournamentRunner');

test('leaving the tournament screens by any route leaves the tournament', () => {
  const x = fe('components', 'TournamentReloadExit.jsx');
  assert.ok(x.includes('const inFlow = pathname === `/tournaments/${mark}`'));
  assert.ok(x.includes("(pathname.startsWith('/game/') && state?.tournament?.poolId === mark)"),
    'a game entered from the bracket would count as leaving');
  assert.ok(x.includes('api.post(`/tournaments/${mark}/leave`'));
  assert.ok(!fe('pages', 'Tournaments.jsx').includes('clearTournamentMark'), 'the bet page clears the marker before the leave is sent');
  assert.ok(!fe('hooks', 'useTournamentRound.js').includes("sessionStorage.removeItem(KEY)"), 'a game screen wipes the marker before the leave is sent');
});

test('someone leaving a waiting room is pushed to the others at once', () => {
  const pools = createStore();
  const sent = [];
  const sockets = new Map();
  for (const u of ['a', 'b']) sockets.set(u, { id: u, _authenticatedUserId: u, emit: (e, p) => sent.push({ to: u, e, p }) });
  const io = { sockets: { sockets }, to: () => ({ emit() {} }), emit() {} };
  const runner = createRunner({ io, supabase: null, pools, log: { error() {} } });
  const { pool } = pools.join({ userId: 'a', username: 'a', entryFee: 1, now: Date.now() });
  pools.join({ userId: 'b', username: 'b', entryFee: 1, now: Date.now() });
  runner.leave(pool.id, 'b');
  const pushed = sent.filter(x => x.to === 'a' && x.e === 'tournament_update');
  assert.ok(pushed.length, 'the player still waiting was not told');
  assert.equal(pushed.at(-1).p.pool.players.length, 1, 'the leaver still shows in the seats');
});

test('chat keeps the last hour and hands it to anyone who asks; deletes come out of it', () => {
  const h = be('socket', 'handlers.js');
  assert.ok(h.includes('const CHAT_HISTORY_MS = 60 * 60 * 1000;'));
  assert.ok(h.includes('recentChat().push(chatMsg);'));
  assert.ok(h.includes("socket.on('chat_history_request'"));
  assert.ok(/const i = chatHistory\.findIndex\(m => m\.messageId === messageId\);/.test(h), 'a deleted message comes back after a refresh');
  const c = fe('components', 'ChatSidebar.jsx');
  assert.ok(c.includes("socket.emit('chat_history_request');") && c.includes("socket.on('chat_history',    onHistory);"));
});

test('Duely Bot no longer posts in chat', () => {
  const c = fe('components', 'ChatSidebar.jsx');
  assert.ok(!c.includes('scheduleBot'), 'the bot chat timer is still there');
  assert.ok(!/BOT_LINES\[Math\.floor/.test(c));
});
