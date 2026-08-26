// Rematch for invite/code matches — same two players, no new code.
//
// The rule that matters: these are STAKED matches, so one player clicking
// Rematch must not put the other player's coins into a game they have not
// agreed to. Both sides accept, or nothing happens.
//
// And it applies only to private matches. A queue opponent is whoever the
// matchmaker found and a bot is not waiting for anything, so those keep Play
// Again and the ordinary queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const be = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const fe = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const HANDLERS = strip(be('socket', 'handlers.js'));

function handler(name) {
  const at = HANDLERS.indexOf(`socket.on('${name}'`);
  assert.notEqual(at, -1, `${name} handler is gone`);
  const next = HANDLERS.indexOf("socket.on('", at + 20);
  return HANDLERS.slice(at, next === -1 ? undefined : next);
}

// ── Only private matches get a rematch ──────────────────────────────────

test('the offer is registered where private matches are paired, and nowhere else', () => {
  // _pairPrivatePlayers is the single point every invite and every code, for
  // every game, already flows through — which is exactly why this needs no
  // per-game wiring and cannot accidentally cover the queue.
  const fn = HANDLERS.slice(HANDLERS.indexOf('async function _pairPrivatePlayers'));
  assert.match(fn, /_offerRematch\(roomId, gameType, p1, p2, entryFee, currency\)/,
    'a private pairing must register a rematch offer');

  // The queue pairings must NOT. If _offerRematch appears anywhere else, a
  // queue or bot match could offer to rematch an opponent who never agreed
  // to play this specific person.
  const calls = (HANDLERS.match(/_offerRematch\(/g) || []).length;
  assert.equal(calls, 2, 'expected exactly one definition and one call site');
});

test('every private match tells the client it is private', () => {
  // The page must not infer this from how it started: a reload or a rejoin
  // loses that state, and a button that silently re-queues into the public
  // pool when the player meant to rematch a friend is worse than none.
  const fn = HANDLERS.slice(HANDLERS.indexOf('async function _pairPrivatePlayers'));
  const emits = fn.match(/emit\('[a-z_]*match_found'/g) || [];
  assert.ok(emits.length >= 6, `expected a match_found emit per game, found ${emits.length}`);
  const flags = (fn.match(/isPrivate: true/g) || []).length;
  assert.ok(flags >= emits.length,
    `every private match_found must carry isPrivate — ${emits.length} emits but ${flags} flags`);
});

// ── Both must accept ────────────────────────────────────────────────────

test('one click does not start the match', () => {
  const h = handler('request_rematch');
  // The early return on a one-sided acceptance must come BEFORE the pairing
  // call, or the first click starts a staked match on its own.
  const waiting = h.indexOf("emit('rematch_waiting')");
  const pairing = h.indexOf('_pairPrivatePlayers(');
  assert.ok(waiting !== -1, 'the first clicker must be told it is waiting');
  assert.ok(pairing !== -1, 'the second click must start the match');
  assert.ok(waiting < pairing, 'the waiting branch must return before pairing');

  // The return must CLOSE the waiting branch, not merely exist somewhere
  // between the two markers — the function has other returns in between, so
  // a looser check still passed with this one deleted. Confirmed by deleting
  // it and watching this fail.
  const branch = h.slice(waiting, pairing);
  // No [\s\S]* — that spans past the branch to a LATER return, so the check
  // passed with this one deleted. Anchored to the rematch_requested line
  // and the very next statement instead.
  assert.match(branch, /rematch_requested[^\n]*\n\s*return;/,
    'the waiting branch must RETURN — falling through would start the match on one click');
});

test('the opponent is told a rematch was requested', () => {
  assert.match(handler('request_rematch'), /emit\('rematch_requested'/);
});

test('balances are re-checked at the second click, not the first', () => {
  // The first acceptance can be a minute old by then, and a balance moves.
  const h = handler('request_rematch');
  const bothIn = h.indexOf('rematchOffers.delete(roomId)');
  const balance = h.indexOf("select('id,c_coins,diamonds')");
  assert.ok(balance > bothIn,
    'the balance check belongs on the path where both have accepted');
  assert.match(h, /reason: 'balance'/, 'both players must be told if it cannot be afforded');
});

test('the offer is consumed before the match starts', () => {
  // Otherwise a double-click, or two tabs, could pair the same two players
  // twice and deduct twice.
  const h = handler('request_rematch');
  assert.ok(h.indexOf('rematchOffers.delete(roomId)') < h.indexOf('_pairPrivatePlayers('),
    'the offer must be removed before pairing, or it can fire twice');
});

// ── Nobody gets stranded ────────────────────────────────────────────────

test('an offline opponent falls back instead of waiting', () => {
  const h = handler('request_rematch');
  assert.match(h, /theirSockets\.length === 0[\s\S]{0,200}?opponent_left/,
    'a player whose opponent has gone must be told, not left waiting');
});

test('declining tells the other player immediately', () => {
  const h = handler('decline_rematch');
  assert.match(h, /rematchOffers\.delete\(roomId\)/);
  assert.match(h, /reason: 'declined'/);
});

test('a disconnect only withdraws the offer once every tab is gone', () => {
  // A second tab, or a reconnect while the result card is up, must not
  // cancel a rematch the player is still deciding on.
  const at = HANDLERS.indexOf("socket.on('disconnect'");
  const body = HANDLERS.slice(at, at + 2500);
  assert.match(body, /_socketsForUser\(authenticatedUser\.userId\)\.length === 0/,
    'the offer must survive a disconnect while another socket remains');
  assert.match(body, /rematchOffers\.delete\(rid\)/);
});

test('a forgotten offer expires rather than lingering', () => {
  assert.match(HANDLERS, /REMATCH_TTL_MS/);
  assert.match(HANDLERS, /_sweepRematchOffers/);
});

test('a player already in another match cannot be pulled into a rematch', () => {
  assert.match(handler('request_rematch'), /inMatchOrQueue\(authenticatedUser\.userId\)/);
});

// ── The button ──────────────────────────────────────────────────────────

test('the same button changes word — no second button is added', () => {
  // The request was explicit: everything looks the same, only the word
  // changes. A separate Rematch button already exists for Block Burst's
  // in-room rematch and must not be confused with this.
  const src = fe('components', 'ResultScreen.jsx');
  const at = src.indexOf('onClick={isPrivate ? onPrivateRematch : onPlayAgain}');
  assert.notEqual(at, -1, 'the Play Again button must switch action when private');
  // Bounded by the button's own closing tag, not a character count — a fixed
  // window is one label away from cutting off the branch it means to check,
  // which is exactly what happened when this was first written.
  const btn = src.slice(at, src.indexOf('</button>', at));
  assert.match(btn, /'Play Again'/, 'a public match still says Play Again');
  assert.match(btn, /'Rematch'/,    'a private match says Rematch');
});

test('a public match is unaffected', () => {
  const src = fe('components', 'ResultScreen.jsx');
  assert.match(src, /isPrivate = false/, 'isPrivate must default to false');
  assert.match(src, /!isPrivate\s*\?\s*'Play Again'/,
    'the non-private label must remain exactly Play Again');
});

test('the waiting state cannot be clicked twice', () => {
  const src = fe('components', 'ResultScreen.jsx');
  assert.match(src, /disabled=\{isPrivate && rematchState === 'waiting'\}/);
});

// ── Client wiring ───────────────────────────────────────────────────────

test('every game page uses the shared hook', () => {
  // Six hand-written copies is how one page gets missed — which has already
  // happened in this codebase with avatars and with migration fallbacks.
  for (const page of ['CoinFlipGame', 'BlackjackGame', 'TowerGame',
                      'CarDashGame', 'WordleGame', 'BlockBlastGame']) {
    const src = fe('pages', `${page}.jsx`);
    assert.match(src, /usePrivateRematch\(socket, '/, `${page} does not use the hook`);
    assert.match(src, /onPrivateRematch=\{privateRematch\.requestRematch\}/,
      `${page} never passes the rematch action to its result card`);
  }
});

test('every ResultScreen on every page gets the props', () => {
  // A page with two result cards (a solo one and a PvP one) must wire both,
  // or the rematch silently does nothing on one of them.
  for (const page of ['CoinFlipGame', 'BlackjackGame', 'TowerGame',
                      'CarDashGame', 'WordleGame', 'BlockBlastGame']) {
    const src = fe('pages', `${page}.jsx`);
    const cards = (src.match(/onPlayAgain=\{/g) || []).length;
    const wired = (src.match(/onPrivateRematch=\{/g) || []).length;
    assert.equal(wired, cards,
      `${page} has ${cards} result cards but only ${wired} wired for rematch`);
  }
});

test('the hook reads isPrivate from the server, not from page state', () => {
  const src = fe('hooks', 'usePrivateRematch.js');
  assert.match(src, /setIsPrivate\(!!payload\?\.isPrivate\)/,
    'the server decides whether a match was private');
  assert.match(src, /roomIdRef/, 'the room id must survive re-renders');
});
