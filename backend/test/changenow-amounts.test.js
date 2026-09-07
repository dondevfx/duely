// The number that says how much money arrived.
//
// ChangeNow's v1 transaction status returns amountSend and amountReceive.
// getExchangeStatus read amountFrom and amountTo, which are not in the
// response, so parseFloat(undefined || 0) was 0 on every call — and swapPoller
// credits the received amount and refuses anything under $3.
//
// So every ChangeNow deposit the platform ever took was read as zero USDC and
// never credited. Not one BTC, ETH, LTC, DOGE or TRX deposit had ever reached a
// player's balance. The money arrived every time. The number did not.
//
// Found on a real $8 ETH deposit: status "finished", payoutHash present,
// amountReceive 7.46551 USDC in the treasury, and the poller logging
// "$0 USDC received, no user credit".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', ...p), 'utf8');
const POLLER = read('swapPoller.js');

// The exact body ChangeNow returned for the deposit that exposed this.
const REAL_RESPONSE = {
  status: 'finished',
  payinHash: '0x22b31a0f6fd23eb41e980af637fa49d829a0e20f409a7c52fd7c5b6397bac196',
  payoutHash: '4mJs5nyfDAJz4Hio89WjguvU9gsdcnCNpbwzdgsMguk3rA4Y9d8G4zFRQAGri79MjXYRrHrc8mPouAfvt2HWLgPG',
  payinAddress: '0xpayin', payoutAddress: 'SoLpayout',
  fromCurrency: 'eth', toCurrency: 'usdcsol',
  amountSend: 0.00319006,
  amountReceive: 7.46551,
  id: '8e654e39706677', expectedReceiveAmount: 7.465858,
};

function loadService(body) {
  const nf = require.resolve('node-fetch');
  const real = require.cache[nf];
  require.cache[nf] = { id: nf, filename: nf, loaded: true, exports:
    async () => ({ ok: true, status: 200, json: async () => body }) };
  try {
    const p = path.join(__dirname, '..', 'src', 'services', 'simpleSwapService.js');
    const m = new Module(p, null);
    m.filename = p;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    m._compile(fs.readFileSync(p, 'utf8'), p);
    return m.exports;
  } finally {
    if (real) require.cache[nf] = real; else delete require.cache[nf];
  }
}

test('the received amount is read from the field ChangeNow actually sends', async () => {
  const svc = loadService(REAL_RESPONSE);
  const out = await svc.getExchangeStatus('8e654e39706677');
  assert.equal(out.amountTo, 7.46551,
    'the USDC that arrived was read as ' + out.amountTo +
    ' — swapPoller credits this number, and anything under $3 is not credited at all');
  assert.equal(out.amountFrom, 0.00319006);
  assert.equal(out.status, 'finished');
  assert.equal(out.txTo, REAL_RESPONSE.payoutHash, 'the payout hash proves the money moved');
});

test('a deposit of this size clears the credit floor once it is read', async () => {
  // The whole failure in one assertion: 7.46551 credits, 0 does not.
  const svc = loadService(REAL_RESPONSE);
  const { amountTo } = await svc.getExchangeStatus('x');
  assert.ok(amountTo >= 3.00, `$${amountTo} would still be refused by the $3 floor`);
});

test('the older field names still work, if a v2 endpoint is ever used', async () => {
  const svc = loadService({ status: 'finished', amountFrom: 1.5, amountTo: 42.5 });
  const out = await svc.getExchangeStatus('x');
  assert.equal(out.amountTo, 42.5);
  assert.equal(out.amountFrom, 1.5);
});

test('a genuinely absent amount is zero, not NaN', async () => {
  // NaN >= 3 is false, so it would not credit — but NaN also formats as "NaN"
  // in the log and compares false against everything, which is a worse thing to
  // have flowing through money code than a plain 0.
  const svc = loadService({ status: 'waiting' });
  const out = await svc.getExchangeStatus('x');
  assert.equal(out.amountTo, 0);
  assert.ok(!Number.isNaN(out.amountTo));
});

// ── Never call a read failure a small deposit ──────────────────────────────

test('finished with nothing readable is escalated, not filed as below_min', () => {
  // ChangeNow does not report a swap finished without paying one out, so a zero
  // there means we failed to READ the amount — not that a real deposit was too
  // small to bother with. Filing it as below_min stated something untrue about
  // the player's money in a status nobody investigates, and that is what hid
  // this bug for the platform's entire history.
  const start = POLLER.indexOf('} else if (creditUser && !(usdcRaw > 0))');
  // Ends where the next branch begins — the legitimate below_min case.
  const branch = POLLER.slice(start, POLLER.indexOf('} else {', start + 10));
  assert.ok(branch.length > 0, 'the zero case is not distinguished from a small deposit');
  assert.match(branch, /status: 'stuck'/,
    'a finished swap we cannot read must reach the admin queue');
  // The status it WRITES, not the word — the log line in this branch says
  // "not calling it below_min", which is the opposite of the failure.
  assert.doesNotMatch(branch, /status: 'below_min'/,
    'below_min says the deposit was too small, which is not what happened');
  assert.match(branch, /console\.error/, 'this is an error, not an informational log');
});

test('a real small deposit is still below_min', () => {
  // The escalation must not swallow the legitimate case, or every dust deposit
  // becomes an admin task.
  const tail = POLLER.slice(POLLER.indexOf("} else {", POLLER.indexOf('} else if (creditUser && !(usdcRaw > 0))')));
  assert.match(tail.slice(0, 600), /status: 'below_min'/,
    'a genuinely under-floor deposit should still be recorded as below_min');
});

test('the credit floor and fee are unchanged by this', () => {
  // Read amounts changed; the policy did not.
  assert.match(POLLER, /MIN_CREDIT_USD = 3\.00/);
  assert.match(POLLER, /OUR_FEE\s*=\s*0\.001/);
});
