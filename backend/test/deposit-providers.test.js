// Every deposit coin, against a provider that is failing.
//
// The ETH outage was one instance of a shape that was in every fetcher: a
// missing field in an error body became an empty array, so an address we could
// not read was indistinguishable from an address with nothing on it. Deposits
// then went unnoticed with no error, no log and no record — which is exactly
// how $8.13 of ETH went missing and how every ETH deposit before it did.
//
// These drive the real fetchers through the real switch, once per coin, with a
// provider that answers the way a failing provider actually answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// The monitor with fetchTxs reachable and node-fetch replaced.
function loadMonitor(handler) {
  const nf = require.resolve('node-fetch');
  const real = require.cache[nf];
  require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: handler };
  try {
    const p = path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js');
    const m = new Module(p, null);
    m.filename = p;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    m._compile(fs.readFileSync(p, 'utf8') + '\nmodule.exports.__fetchTxs = fetchTxs;\n', p);
    return m.exports;
  } finally {
    if (real) require.cache[nf] = real; else delete require.cache[nf];
  }
}

const res = (obj) => ({ status: 200, ok: true, text: async () => JSON.stringify(obj) });

// A real address per coin, so nothing fails for the wrong reason.
const ADDR = {
  btc:  '17pF7bTpL5kp2vFWzXgqWVsJYkzX77VhAv',
  ltc:  'LU1xGRmuhQcFMDRSK5sSdCK5H3ZU6wE1Z2',
  doge: 'DEL7ZHBykkyfh1nWpFQrC9ggse5nRKazVN',
  trx:  'TJZdrUNff67VvQPso3PGj61jVVqUtcqaR3',
  eth:  '0x003D1682aaa7feaA2EC52d1C877fb7c32022eF76',
  sol:  '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM',
  usdc: '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM',
  usdt: '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM',
};

// What each provider sends back when it refuses. Taken from the real thing:
// BlockCypher answers HTTP 400 {error}, TronGrid drops `data`, a Solana RPC
// returns a JSON-RPC error object, Etherscan-family returns status "0".
const REFUSAL = {
  btc:  { error: 'Limit of 3 req/sec reached' },
  ltc:  { error: 'Limit of 3 req/sec reached' },
  doge: { error: 'Limit of 3 req/sec reached' },
  trx:  { Error: 'invalid api key' },
  eth:  { status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' },
  sol:  { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } },
  usdc: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } },
  usdt: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } },
};

// And what it sends back for an address that is simply empty. Verified against
// all four live providers — the field is present and empty, never absent.
const EMPTY = {
  btc:  { address: 'x', n_tx: 0, txs: [] },
  ltc:  { address: 'x', n_tx: 0, txs: [] },
  doge: { address: 'x', n_tx: 0, txs: [] },
  trx:  { data: [], success: true, meta: {} },
  eth:  { status: '0', message: 'No transactions found', result: [] },
  sol:  { jsonrpc: '2.0', id: 1, result: [] },
  usdc: { jsonrpc: '2.0', id: 1, result: [] },
  usdt: { jsonrpc: '2.0', id: 1, result: [] },
};

const COINS = Object.keys(ADDR);

for (const coin of COINS) {
  test(`${coin}: a refusing provider is an error, not an empty address`, async () => {
    const monitor = loadMonitor(async () => res(REFUSAL[coin]));
    await assert.rejects(
      () => monitor.__fetchTxs(coin, ADDR[coin]),
      (e) => {
        // The reason has to survive to the message, or the log says only that
        // something went wrong.
        assert.ok(e instanceof Error, `${coin} did not throw an Error`);
        assert.ok(e.message.length > 10, `${coin} threw an empty reason`);
        return true;
      },
      `${coin} reported a refusing provider as an address with no deposits`);
  });

  test(`${coin}: an empty address is quietly empty`, async () => {
    // The other half. If a real empty address threw, every unused deposit
    // address would raise a fault on every pass and the log would be useless.
    const monitor = loadMonitor(async () => res(EMPTY[coin]));
    const out = await monitor.__fetchTxs(coin, ADDR[coin]);
    assert.deepEqual(out, [], `${coin} treated an empty address as a failure`);
  });
}

test('a transport failure is not an empty address either', async () => {
  // A timeout, a DNS failure, a dropped socket: no body at all to misread.
  for (const coin of COINS) {
    const monitor = loadMonitor(async () => { throw new Error('ETIMEDOUT'); });
    await assert.rejects(() => monitor.__fetchTxs(coin, ADDR[coin]), undefined,
      `${coin} swallowed a transport failure`);
  }
});

test('an unknown coin returns nothing rather than throwing', async () => {
  // The default branch. A coin nobody can deposit is not a fault to report on
  // every pass — it is simply not watched.
  const monitor = loadMonitor(async () => res({}));
  assert.deepEqual(await monitor.__fetchTxs('xmr', 'whatever'), []);
});

test('failures are logged once per coin per reason, not per address per pass', async () => {
  // A provider outage hits every address at once and does not change between
  // passes. One line per address per 45s pass buries everything else — which is
  // how a BNB plan limit once made the log unreadable. The address is
  // deliberately not part of the key; the reason is, so a DIFFERENT failure
  // still reports immediately.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function pollCoin'), src.indexOf('const SWEEP_EVERY_PASSES'));
  assert.match(fn, /_missLogged/, 'poll failures are not deduped');
  assert.match(fn, /replace\(address, '<address>'\)/,
    'the address must be stripped from the key, or the dedupe is per address');
  assert.match(fn, /MISS_REPEAT_MS/);
});

test('every deposit coin has a real detector behind it', async () => {
  // A coin may only be offered if a deposit to it can be SEEN. Handing out an
  // address for a coin nothing watches is money taken and never credited, and
  // it fails silently — no error, no log, nothing until someone complains.
  const { DEPOSIT_COINS } = require('../src/services/coinConfig');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  const sw = src.slice(src.indexOf('async function fetchTxs'), src.indexOf('// ── Deposit processor'));
  for (const coin of DEPOSIT_COINS) {
    assert.match(sw, new RegExp(`case '${coin}':`), `${coin} is offered with no detector`);
  }
  // And the inverse: everything offered is covered by the tests above.
  for (const coin of DEPOSIT_COINS) {
    assert.ok(COINS.includes(coin), `${coin} is a deposit coin with no provider test`);
  }
});
