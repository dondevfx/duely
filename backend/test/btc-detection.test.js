// Detecting that a BTC deposit exists at all.
//
// This is the single point every Bitcoin deposit passes through, and it read
// one provider:
//
//   [monitor] poll error btc/17pF7...: request to https://blockstream.info/... failed
//
// While blockstream was unreachable, Bitcoin deposits were not detected. Not
// lost — the coins sit in the address and a later poll finds them — but every
// player depositing during the outage waits with no explanation and no way to
// know it is being worked on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');

// Comment-stripped, so an assertion cannot be satisfied by the prose that
// explains it. (A test in this suite passed on its own documentation once.)
const CODE = SRC.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

// The end marker MUST be found. When it is not, indexOf returns -1 and
// String.slice treats that as "one character from the end" — silently handing
// back the rest of the file. That is exactly what happened when fetchEthTxs
// became an arrow function: this helper started returning half the module and
// the assertions began matching unrelated code.
function fn(name, endMarker) {
  const at = CODE.indexOf(`async function ${name}`);
  assert.notEqual(at, -1, `${name} is gone`);
  const end = CODE.indexOf(endMarker, at);
  assert.notEqual(end, -1,
    `the end marker "${endMarker}" no longer exists — this slice would silently run to the end of the file`);
  return CODE.slice(at, end);
}

test('BTC detection survives one provider being down', () => {
  const btc = fn('fetchBtcTxs', 'function explorerMiss');
  assert.match(btc, /blockstream/, 'the primary provider');
  assert.match(btc, /fetchBlockcypherTxs\('btc'/,
    'with a single provider, an outage stops every Bitcoin deposit being noticed');
});

test('a total outage reports an error rather than "no deposits"', () => {
  // The dangerous failure is returning [] when we could not read the address:
  // that is indistinguishable from "nothing arrived", and the deposit is
  // silently ignored. Same shape of lie as a price of 0 meaning "worthless".
  const btc = fn('fetchBtcTxs', 'function explorerMiss');
  const fallback = btc.slice(btc.indexOf('catch'));
  assert.ok(!/return \[\]/.test(fallback),
    'swallowing a double outage into an empty list hides real deposits');
  assert.match(fallback, /return fetchBlockcypherTxs/,
    'the fallback must propagate its own failure to the caller');
});

test('no outbound call can hang the poll pass', () => {
  // node-fetch has no default timeout. One provider that accepts a connection
  // and goes quiet stalls every address queued behind it.
  assert.match(CODE, /AbortController/, 'a timeout needs an abort signal');
  const bare = [...CODE.matchAll(/await fetch\(/g)];
  assert.equal(bare.length, 1,
    `${bare.length} raw fetch calls remain — only the one inside fetchWithTimeout should be bare`);
});

test('the timeout is actually bounded', () => {
  const helper = fn('fetchWithTimeout', '\n}');
  assert.match(helper, /setTimeout\(\(\) => ctrl\.abort\(\)/, 'the abort must be scheduled');
  assert.match(helper, /clearTimeout/, 'and cleared, or every call leaks a timer');
});

test('the fallback preserves the shape the caller expects', () => {
  // Both providers must return { txHash, amount, confirmed } or the deposit
  // handler reads undefined and treats a real deposit as dust.
  const bc = fn('fetchBlockcypherTxs', 'async function fetchTxs');
  for (const field of ['txHash:', 'amount:', 'confirmed:']) {
    assert.ok(bc.includes(field), `the BlockCypher path must return ${field}`);
  }
});
