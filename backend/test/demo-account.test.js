// Two demo-account behaviours, both of which are dangerous if the guard slips.
//
// 1. The tip form doubles as a balance setter for demo accounts, because a demo
//    cannot deposit and otherwise has no way to reach a chosen balance for a
//    walkthrough. That path WRITES a balance rather than crediting one, so a
//    real account reaching it would be minting money.
//
// 2. The public friend-invite preview hid demo accounts from everyone, so the
//    two demo accounts could never use each other's invite links — even though
//    the POST that actually creates the friendship allowed it.
//
// Read from source: both are route wiring rather than an exported function.
// Comments are stripped first, since an earlier test in this repo passed
// against its own explanatory prose instead of the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs
  .readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const wallet = read('routes', 'wallet.js');
const auth   = read('routes', 'auth.js');
const mw     = read('middleware', 'auth.js');

// ── Balance setter ──────────────────────────────────────────────────────────

test('the balance setter is gated on isDemo', () => {
  const tip = wallet.slice(wallet.indexOf("router.post('/tip'"));
  const setter = tip.indexOf('demoBalanceSet');
  assert.ok(setter > 0, 'demo balance setter not found');

  // The write must sit inside an isDemo branch, not merely near one.
  const guard = tip.lastIndexOf('if (isDemo(req.user.id))', setter);
  assert.ok(guard > 0 && guard < setter, 'the balance write must be inside an isDemo check');
});

test('the setter writes the balance rather than crediting it', () => {
  // Using creditCoins here would ADD to the balance instead of setting it, and
  // would run the same code path real deposits use.
  const tip = wallet.slice(wallet.indexOf("router.post('/tip'"));
  const branch = tip.slice(tip.indexOf('if (isDemo(req.user.id))'), tip.indexOf('demoBalanceSet') + 200);
  assert.match(branch, /from\('profiles'\)\s*\n?\s*\.update\(/);
  assert.doesNotMatch(branch, /creditCoins|creditDiamonds/,
    'a demo balance must be written directly, never credited');
});

test('the setter returns before any real transfer can run', () => {
  // If it fell through, a demo would set its balance AND tip someone.
  const tip = wallet.slice(wallet.indexOf("router.post('/tip'"));
  const setter = tip.indexOf('demoBalanceSet');
  const transfer = tip.indexOf('deductCoins');
  assert.ok(transfer > setter, 'expected the transfer to come after the demo branch');
  assert.match(tip.slice(setter - 200, transfer), /return res\.json/,
    'the demo branch must return, not fall through to the transfer');
});

test('a real account still cannot tip a demo', () => {
  // The demo balance is play money; letting it flow to a real account would
  // turn it into a withdrawable balance.
  const tip = wallet.slice(wallet.indexOf("router.post('/tip'"));
  assert.match(tip, /isDemo\(recipient\.id\)/);
});

// ── Friend invite preview ───────────────────────────────────────────────────

test('optionalAuth leaves req.user unset rather than rejecting', () => {
  // The preview must stay readable while logged out, so this cannot 401.
  const fn = mw.slice(mw.indexOf('async function optionalAuth'));
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /res\.status\(401\)/);
  assert.match(mw, /optionalAuth/);
  assert.match(mw, /module\.exports[\s\S]*optionalAuth/);
});

test('the invite preview hides a demo from real users but not from another demo', () => {
  const route = auth.slice(auth.indexOf("router.get('/friend-invite/:username'"));
  const head = route.slice(0, route.indexOf('res.json'));
  assert.match(head, /optionalAuth/, 'the preview needs to know who is asking');
  assert.match(head, /isDemo\(p\.id\) && !isDemo\(req\.user\?\.id\)/,
    'a blanket isDemo block here strands demo-to-demo invite links');
});

test('the preview and the accept path agree on the rule', () => {
  // These drifting apart is exactly what broke it: POST allowed the friendship
  // while GET 404'd, so the link died at the preview.
  const get  = auth.slice(auth.indexOf("router.get('/friend-invite/:username'"));
  const post = auth.slice(auth.indexOf("router.post('/friend-invite/:username'"));
  assert.match(get.slice(0, get.indexOf('res.json')), /!isDemo\(/);
  assert.match(post.slice(0, post.indexOf('inviter.id === myId')), /!isDemo\(myId\)/);
});

test('the preview still does not hand out the user id', () => {
  const start = auth.indexOf("router.get('/friend-invite/:username'");
  // Up to the NEXT route, not the first '});' — that one closes the 404 branch.
  const end = auth.indexOf('router.', start + 10);
  assert.match(auth.slice(start, end), /const \{ id, \.\.\.safe \}/,
    'anonymous callers must not receive the profile id');
});
