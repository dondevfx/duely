// Two bugs that both spoil a Coin Flip result before the coin lands, and one
// that makes a phone feel broken after unlocking it.
//
// ── The reveal ──
//
// The server settles the match and only then emits coin_flip_result. Settling
// fires balance_changed first, so the refresh that gives the outcome away was
// already in flight before the client took its hold — the hold was taken when
// the RESULT arrived, which is too late by construction. It now starts when the
// coin leaves the hand.
//
// And BalanceSync coalesces refreshes to one a second. The deferred timer did
// not re-check the hold, so a refresh scheduled a fraction of a second before
// the flip began still ran mid-spin, straight through the hold.
//
// ── The resume ──
//
// iOS freezes a backgrounded socket without closing it, so on return the client
// reports connected while the server has long since dropped it. Nothing local
// can detect that; the only way is to ask the server with a deadline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = (p) => fs.readFileSync(p, 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const fe = (...p) => strip(path.join(__dirname, '..', '..', 'frontend', 'src', ...p));
const be = (...p) => strip(path.join(__dirname, '..', 'src', ...p));

test('the hold starts when the coin starts spinning, not when the result lands', () => {
  const src = fe('pages', 'CoinFlipGame.jsx');
  const at = src.indexOf("setPhase('flipping')");
  assert.ok(at > 0, "no setPhase('flipping') found");
  // Every path that starts a spin must take a hold near that transition.
  for (let i = at; i !== -1; i = src.indexOf("setPhase('flipping')", i + 1)) {
    assert.match(src.slice(i, i + 500), /holdBalance\(\)/,
      'a flip that starts without a hold can have its result spoiled by a refresh');
  }
});

test('a result arriving with no hold still takes one', () => {
  // Covers a rejoin, or a flip that resolves before the countdown finishes.
  const src = fe('pages', 'CoinFlipGame.jsx');
  assert.match(src, /if \(!releaseBalanceRef\.current\) releaseBalanceRef\.current = holdBalance\(\)/);
});

test('the hold is released when the result screen shows, and on unmount', () => {
  // A leaked hold freezes the displayed balance site-wide, which is worse than
  // the bug being fixed. There is a safety timer too, but it should not be the
  // thing doing the work.
  const src = fe('pages', 'CoinFlipGame.jsx');
  const releases = src.match(/releaseBalanceRef\.current = null/g) || [];
  assert.ok(releases.length >= 2, 'expected a release on result and on unmount');
});

test('the throttled refresh re-checks the hold before running', () => {
  const src = fe('components', 'BalanceSync.jsx');
  const timer = src.slice(src.indexOf('setTimeout(() => {'), src.indexOf('}, 1000 - since)'));
  assert.match(timer, /isBalanceHeld\(\)/,
    'a refresh scheduled before the hold would otherwise run straight through it');
  assert.match(timer, /pendingRef\.current = true/, 'it must defer, not drop');
});

test('a held refresh is deferred, never dropped', () => {
  // The balance still has to land eventually — just after the reveal.
  const src = fe('utils', 'balanceHold.js');
  assert.match(src, /onBalanceRelease/);
  const sync = fe('components', 'BalanceSync.jsx');
  assert.match(sync, /onBalanceRelease\(\(\) => \{[\s\S]{0,200}doRefresh\(\)/);
});

test('the hold cannot leak forever', () => {
  const src = fe('utils', 'balanceHold.js');
  assert.match(src, /setTimeout\(release, maxMs\)/, 'the hold needs a hard ceiling');
});

test('the server answers a liveness probe', () => {
  const src = be('socket', 'handlers.js');
  assert.match(src, /socket\.on\('ping_check'/);
  assert.match(src, /if \(typeof ack === 'function'\) ack\(/, 'the probe is useless without an ack');
});

test('the probe needs no auth', () => {
  // A socket whose session lapsed while backgrounded is exactly the case this
  // has to answer, so gating it on auth would defeat it.
  const src = be('socket', 'handlers.js');
  const at = src.indexOf("socket.on('ping_check'");
  const body = src.slice(at, src.indexOf('});', at));
  assert.doesNotMatch(body, /authenticatedUser/);
});

test('returning to the tab probes with a deadline and reconnects on silence', () => {
  const src = fe('context', 'SocketContext.jsx');
  assert.match(src, /visibilitychange/);
  assert.match(src, /pageshow/);
  assert.match(src, /timeout\(1200\)\.emit\('ping_check'/,
    'the probe must have a deadline — a frozen socket never answers at all');
  const cb = src.slice(src.indexOf("emit('ping_check'"));
  assert.match(cb.slice(0, 600), /s\.disconnect\(\);\s*s\.connect\(\)/,
    'no answer means tear it down rather than wait out the ping timeout');
});

test('a socket already known to be down reconnects immediately', () => {
  const src = fe('context', 'SocketContext.jsx');
  assert.match(src, /if \(!s\.connected\) \{ .*s\.connect\(\); return; \}/,
    'skip the remaining backoff when we already know it is disconnected');
});

test('the resume listeners are removed on cleanup', () => {
  const src = fe('context', 'SocketContext.jsx');
  for (const ev of ['visibilitychange', 'pageshow', 'focus', 'online']) {
    assert.match(src, new RegExp(`removeEventListener\\('${ev}', resume\\)`),
      `${ev} listener is never removed`);
  }
});

// ── A stale token that never gets retried ───────────────────────────────────
//
// Not the resume timing above — a separate failure mode that produces the
// identical symptom. The server always answers a stale/expired access token
// with an 'error' event naming exactly why; nothing on the client listened
// for it, so the failure was invisible and the app sat on "Connecting…" /
// "Authenticating…" with no way out short of a manual reload. This can
// happen even while the tab is actively open and was never backgrounded —
// AuthContext's own refresh timer is a single setTimeout, and setTimeout is
// throttled or fully suspended in a backgrounded tab, so the timer meant to
// prevent this can itself run late.

test('the server has exactly two ways to say the token was rejected', () => {
  // Pinned so the two messages below can never silently drift from what the
  // server actually sends — matching a different string just means the fix
  // does nothing.
  const src = be('socket', 'handlers.js');
  const at = src.indexOf("socket.on('authenticate'");
  const body = src.slice(at, src.indexOf("router.post", at) === -1 ? at + 2000 : src.indexOf("router.post", at));
  assert.match(body, /'Authentication failed'/);
  assert.match(body, /'Authentication error'/);
});

test('a rejected token triggers a refresh, not silence', () => {
  const src = fe('context', 'SocketContext.jsx');
  const at = src.indexOf("socket.on('error'");
  assert.notEqual(at, -1, 'nothing listens for the server rejecting the token at all');
  const body = src.slice(at, src.indexOf('});', at));
  assert.match(body, /message !== 'Authentication failed'/);
  assert.match(body, /message !== 'Authentication error'/);
  assert.match(body, /forceReauth\(\)/,
    'the failure must trigger an actual refresh, not just be logged and dropped');
});

test('the auth-failure listener does not fire on unrelated errors', () => {
  // 'error' also carries dozens of unrelated messages — bad bet amount,
  // insufficient balance, game-state errors. Any of those triggering a token
  // refresh would be pure noise at best.
  const src = fe('context', 'SocketContext.jsx');
  const at = src.indexOf("socket.on('error'");
  const body = src.slice(at, src.indexOf('});', at));
  assert.match(body, /if \(message !== 'Authentication failed' && message !== 'Authentication error'\) return;/,
    'must return early for every other message, not just the two it acts on');
});

test('the refresh fix is reachable: exposed by AuthContext, wired above SocketContext', () => {
  const authSrc = fe('context', 'AuthContext.jsx');
  assert.match(authSrc, /forceReauth:\s*_doRefresh/,
    'AuthContext must expose its own refresh function — a duplicate one in ' +
    'SocketContext risks two refreshes racing on the same refresh_token');

  const appSrc = fe('App.jsx');
  const authAt = appSrc.indexOf('<AuthProvider>');
  const socketAt = appSrc.indexOf('<SocketProvider>');
  assert.ok(authAt !== -1 && socketAt !== -1 && authAt < socketAt,
    'AuthProvider must wrap SocketProvider, or useAuth() inside it has nothing to read');
});
