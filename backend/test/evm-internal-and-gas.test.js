// Two things a deposit could quietly lose money to.
//
// 1. txlist returns only top-level transactions. Money arriving from a CONTRACT
//    — a bridge paying out through its outbox, an exchange or wallet that sends
//    through one — is an "internal" transfer and appears only in
//    txlistinternal. Verified against the live explorer: 25 of 41 incoming
//    transfers to a busy address were internal-only and entirely absent from
//    its txlist.
//
// 2. The gas reserve was a fixed number per coin, and whatever is reserved is
//    not forwarded, so it is not converted and not credited — a flat fee on the
//    player. Measured: 0.0004 ETH held back against a forward costing
//    0.00000168 ETH, which on an $8 deposit is a 12% haircut.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');

function loadMonitor(handler) {
  const nf = require.resolve('node-fetch');
  const real = require.cache[nf];
  require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: handler };
  try {
    const p = path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js');
    const m = new Module(p, null);
    m.filename = p;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    m._compile(fs.readFileSync(p, 'utf8') + '\nmodule.exports.__fetchEvmTxs = fetchEvmTxs;\n', p);
    return m.exports;
  } finally {
    if (real) require.cache[nf] = real; else delete require.cache[nf];
  }
}
const reply = (obj) => ({ status: 200, ok: true, text: async () => JSON.stringify(obj) });

// ── Internal transfers ─────────────────────────────────────────────────────

test('a deposit that only exists as an internal transfer is found', async () => {
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = '';
  const asked = [];
  const monitor = loadMonitor(async (url) => {
    asked.push(String(url));
    if (String(url).includes('txlistinternal')) {
      // Note the shape: transactionHash, and NO confirmations field.
      return reply({ status: '1', message: 'OK', result: [{
        transactionHash: '0xbridge', to: '0xdead', value: '3237000000000000',
        isError: '0', type: 'call',
      }] });
    }
    return reply({ status: '0', message: 'No transactions found', result: [] });
  });
  try {
    const out = await monitor.__fetchEvmTxs('eth', '0xDEAD');
    assert.equal(asked.filter(u => u.includes('txlistinternal')).length, 1,
      'txlistinternal was never asked for');
    assert.equal(out.length, 1, 'a bridged deposit is still invisible');
    assert.equal(out[0].txHash, '0xbridge', 'internal rows carry transactionHash, not hash');
    assert.equal(out[0].confirmed, true,
      'internal rows have no confirmations field — NaN >= 1 is false, and the ' +
      'deposit would be found and then never credited');
  } finally { process.env.ETHERSCAN_API_KEY = realKey; }
});

test('Blockscout answering status 2 is still a usable answer', async () => {
  // It returns "some internal transactions within this block range have not yet
  // been processed" alongside perfectly good rows. A strict status === '1'
  // throws all of them away.
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = '';
  const monitor = loadMonitor(async (url) => String(url).includes('txlistinternal')
    ? reply({ status: '2', message: 'Some internal transactions within this block range have not yet been processed',
              result: [{ transactionHash: '0xpartial', to: '0xdead', value: '1000000000000000', isError: '0' }] })
    : reply({ status: '0', message: 'No transactions found', result: [] }));
  try {
    const out = await monitor.__fetchEvmTxs('eth', '0xDEAD');
    assert.equal(out.length, 1, 'status 2 rows were discarded');
  } finally { process.env.ETHERSCAN_API_KEY = realKey; }
});

test('status 2 is accepted only for the internal endpoint', async () => {
  // On txlist it is not a documented success, and treating an unknown status as
  // one is how a failure gets read as an empty address.
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = '';
  const monitor = loadMonitor(async () => reply({ status: '2', message: 'NOTOK', result: [] }));
  try {
    await assert.rejects(() => monitor.__fetchEvmTxs('eth', '0xDEAD'), undefined,
      'a status the external endpoint never returns was accepted as success');
  } finally { process.env.ETHERSCAN_API_KEY = realKey; }
});

test('an address with no internal transfers is not a provider failure', async () => {
  // The two endpoints phrase emptiness differently: "No transactions found"
  // and "No internal transactions found". Matching only the first made every
  // ordinary address — external transactions, no internal ones, which is
  // nearly all of them — fall through every source and report as a fault.
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = '';
  const monitor = loadMonitor(async (url) => String(url).includes('txlistinternal')
    ? reply({ status: '0', message: 'No internal transactions found', result: [] })
    : reply({ status: '1', message: 'OK', result: [{ hash: '0xnormal', to: '0xdead',
        value: '5000000000000000', isError: '0', confirmations: '20' }] }));
  try {
    const out = await monitor.__fetchEvmTxs('eth', '0xDEAD');
    assert.equal(out.length, 1, 'an ordinary deposit was lost to the empty internal list');
    assert.equal(out[0].txHash, '0xnormal');
  } finally { process.env.ETHERSCAN_API_KEY = realKey; }
});

test('a transaction in both lists is one deposit, not two', async () => {
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = '';
  const row = { to: '0xdead', value: '1000000000000000', isError: '0', confirmations: '9' };
  const monitor = loadMonitor(async (url) => String(url).includes('txlistinternal')
    ? reply({ status: '1', message: 'OK', result: [{ ...row, transactionHash: '0xsame' }] })
    : reply({ status: '1', message: 'OK', result: [{ ...row, hash: '0xsame' }] }));
  try {
    const out = await monitor.__fetchEvmTxs('eth', '0xDEAD');
    assert.equal(out.length, 1, 'the same deposit was returned twice');
  } finally { process.env.ETHERSCAN_API_KEY = realKey; }
});

test('the extra endpoint costs nothing in requests per hour', async () => {
  // Two calls per poll instead of one, so the cadence halves. The point of the
  // budget work was that request volume is the binding constraint — this must
  // not quietly undo it. Blockscout rate-limited a burst during development,
  // which is exactly the failure being avoided.
  const { COIN_EVERY_PASSES } = require('../src/services/blockchainMonitor');
  assert.ok(COIN_EVERY_PASSES.eth >= 2,
    'eth asks two endpoints per poll; at every pass that doubles its hourly requests');
});

// ── The gas reserve ────────────────────────────────────────────────────────

const monitorReal = require('../src/services/blockchainMonitor');

test('the ETH reserve is measured, not assumed', async () => {
  // 0.08 gwei: a transfer costs 0.00000168 ETH against a 0.0004 fixed reserve.
  const gasPrice = '0x' + (80_000_000n).toString(16);   // 0.08 gwei
  const monitor = loadMonitor(async () => reply({ jsonrpc: '2.0', id: 1, result: gasPrice }));
  const r = await monitor.gasReserveFor('eth', 0.0004);
  assert.ok(r < 0.0004, `still holding back the fixed ${r}`);
  assert.ok(r > 0, 'a zero reserve means the forward cannot pay for itself');
});

test('the reserve never falls below its floor', async () => {
  // Gas moves between the poll and the send. A reserve sized to a quiet instant
  // makes the forward fail, and a failed forward is worse than an over-reserve.
  const monitor = loadMonitor(async () => reply({ result: '0x1' }));   // 1 wei
  assert.equal(await monitor.gasReserveFor('eth', 0.0004), 0.00002);
});

test('a spike cannot take an unbounded bite out of a deposit', async () => {
  const monitor = loadMonitor(async () => reply({ result: '0x' + (500_000_000_000n).toString(16) })); // 500 gwei
  const r = await monitor.gasReserveFor('eth', 0.0004);
  assert.equal(r, 0.0008, 'the ceiling is twice the old fixed number');
});

test('a gas lookup that fails does not block the deposit', async () => {
  // The fixed number is what this always used and is known to be adequate.
  const monitor = loadMonitor(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await monitor.gasReserveFor('eth', 0.0004), 0.0004);
  const junk = loadMonitor(async () => reply({ result: null }));
  assert.equal(await junk.gasReserveFor('eth', 0.0004), 0.0004);
});

test('only the coins whose gas can be priced are measured', async () => {
  // Bitcoin's reserve is deliberately generous — its fees spike hard and an
  // under-reserved forward fails outright. Tron's covers a bandwidth model this
  // cannot price. Solana's fees are already noise.
  for (const [coin, fixed] of [['btc', 0.00002], ['trx', 2], ['sol', 0.003], ['ltc', 0.001], ['doge', 1]]) {
    assert.equal(await monitorReal.gasReserveFor(coin, fixed), fixed,
      `${coin} must keep its documented fixed reserve`);
  }
});

test('the reserve is awaited where the deposit is forwarded', () => {
  // It became async. A forgotten await makes gasRes a Promise, and
  // `amount - Promise` is NaN — the deposit would be dropped as dust.
  assert.match(SRC, /const gasRes\s*=.*await gasReserveFor\(/,
    'gasReserveFor is async; without await the reserve is NaN and the deposit vanishes');
});

// ── Saying so at startup ───────────────────────────────────────────────────

test('a missing explorer key is said out loud, once, at startup', () => {
  // ETH deposits were invisible for months because this key was unset and
  // nothing anywhere mentioned it. The keyless fallback added afterwards does
  // work, but rate-limits under normal polling — measured against the live
  // service, it did not recover within a minute. It is a fallback for a
  // rejected key, not a substitute for having one.
  const warned = [];
  const realWarn = console.warn;
  const env = {};
  for (const k of ['ETHERSCAN_API_KEY', 'BLOCKCYPHER_TOKEN', 'ALCHEMY_ETH_RPC']) {
    env[k] = process.env[k];
    delete process.env[k];
  }
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    monitorReal.reportConfig();
    assert.ok(warned.some(w => w.includes('ETHERSCAN_API_KEY')), 'nothing said about the ETH key');
    assert.ok(warned.some(w => w.includes('BLOCKCYPHER_TOKEN')), 'nothing said about BlockCypher');
    assert.ok(warned.some(w => /etherscan\.io\/apis/.test(w)),
      'a warning without the fix is half a warning');

    // And silent when it is configured, or it is noise people learn to skip.
    warned.length = 0;
    process.env.ETHERSCAN_API_KEY = 'k';
    process.env.BLOCKCYPHER_TOKEN = 't';
    process.env.ALCHEMY_ETH_RPC = 'https://rpc';
    monitorReal.reportConfig();
    assert.equal(warned.length, 0, 'warned about configuration that is present');
  } finally {
    console.warn = realWarn;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the monitor reports its configuration when it starts', () => {
  assert.match(SRC, /blockchain monitor started'\);\s+reportConfig\(\);/,
    'reportConfig must run at startup, or the warning never reaches anyone');
});
