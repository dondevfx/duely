// Reconnect claim ordering.
//
// The server's authenticate handler is async (it verifies the token and loads a
// profile) while its resume_match handler checks for an authenticated user
// SYNCHRONOUSLY and returns silently if there is not one. So a claim sent on
// `connect` races ahead of authentication, is dropped, and the pending forfeit
// runs — costing a player a match they were still playing over a brief blip.
//
// The client hook lives in the frontend, so this models both sides: a fake
// socket that reproduces the server's ordering, and the hook's own effect body.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── A fake socket + server pair with the real asynchrony ───────────────────
function makeWorld() {
  const listeners = {};
  let authenticated = false;
  const server = { resumeAccepted: 0, resumeDropped: 0 };

  const socket = {
    connected: true,
    on: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    off: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    emit: (ev) => {
      if (ev !== 'resume_match') return;
      // mirrors: if (!authenticatedUser) return;
      if (authenticated) server.resumeAccepted++;
      else server.resumeDropped++;
    },
  };

  const fire = (ev) => (listeners[ev] || []).slice().forEach((fn) => fn());

  // A reconnect: 'connect' fires immediately; the server finishes authenticating
  // some time later and only then emits 'authenticated'.
  const reconnect = async () => {
    authenticated = false;
    fire('connect');
    await new Promise((r) => setTimeout(r, 10));   // token verify + profile load
    authenticated = true;
    fire('authenticated');
  };

  return { socket, server, reconnect, fire };
}

// The hook's effect body, transcribed. Kept in step with the real file by the
// assertion at the bottom of this suite.
function installClaim(socket, isActive) {
  const claim = () => { if (isActive()) socket.emit('resume_match'); };
  socket.on('authenticated', claim);
  if (socket.connected) claim();
  return () => socket.off('authenticated', claim);
}

function installClaimOnConnect(socket, isActive) {   // the old, broken shape
  const claim = () => { if (isActive()) socket.emit('resume_match'); };
  socket.on('connect', claim);
  if (socket.connected) claim();
  return () => socket.off('connect', claim);
}

test('claiming on authenticated survives the reconnect race', async () => {
  const { socket, server, reconnect } = makeWorld();
  socket.connected = false;                       // mid-drop, so no mount claim
  installClaim(socket, () => true);
  await reconnect();
  assert.equal(server.resumeAccepted, 1, 'the claim must reach an authenticated socket');
  assert.equal(server.resumeDropped, 0, 'no claim should be dropped');
});

test('claiming on connect loses the race — this is the bug', async () => {
  const { socket, server, reconnect } = makeWorld();
  socket.connected = false;
  installClaimOnConnect(socket, () => true);
  await reconnect();
  assert.equal(server.resumeAccepted, 0);
  assert.ok(server.resumeDropped > 0,
    'the old ordering is expected to be dropped; if it is not, this model is wrong');
});

test('a page that is not mid-match never claims', async () => {
  const { socket, server, reconnect } = makeWorld();
  socket.connected = false;
  installClaim(socket, () => false);              // sitting in the lobby
  await reconnect();
  assert.equal(server.resumeAccepted, 0, 'a refresh must forfeit, not resume');
  assert.equal(server.resumeDropped, 0);
});

test('navigating into a live match on an already-authenticated socket claims', () => {
  const { socket, server } = makeWorld();
  socket.connected = true;
  // authenticate happened before this page mounted, so the event has gone
  const listeners = [];
  socket.on = (ev, fn) => listeners.push([ev, fn]);
  let authed = true;
  socket.emit = (ev) => { if (ev === 'resume_match') authed ? server.resumeAccepted++ : server.resumeDropped++; };
  installClaim(socket, () => true);
  assert.equal(server.resumeAccepted, 1, 'the mount claim covers an already-authenticated socket');
});

test('the hook still listens on authenticated, not connect', () => {
  // Cheap guard against someone reverting the ordering in the real file.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'hooks', 'useResumeMatch.js'), 'utf8');
  assert.ok(src.includes("socket.on('authenticated'"),
    'useResumeMatch must claim on the authenticated event');
  assert.ok(!/socket\.on\(\s*'connect'/.test(src),
    'useResumeMatch must NOT claim on connect — that races authentication');
});
