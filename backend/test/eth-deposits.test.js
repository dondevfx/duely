// ETH deposits, which had never once worked.
//
// Two independent faults, at opposite ends of the same flow: detection asked
// Etherscan with an empty API key and read the refusal as "no deposits", and
// sending built a provider on an undefined URL. The transactions table holds
// no ETH deposit in its entire history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const svc = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');

// Load the monitor with fetchEvmTxs reachable, without exporting it in prod,
// and with its HTTP client replaced.
//
// It calls node-fetch, not global fetch, and reads bodies with res.text() — so
// a stub has to be installed in the module cache and answer text(), or the test
// silently exercises nothing and passes.
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

// A node-fetch-shaped response carrying this JSON.
const reply = (obj) => ({ status: 200, ok: true, text: async () => JSON.stringify(obj) });

test('a deposit is still found with no Etherscan key', async () => {
  // The bug, exactly: no key, and every ETH deposit invisible. The keyless
  // source has to carry it alone.
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = '';
  const asked = [];
  const monitor = loadMonitor(async (url) => {
    asked.push(String(url));
    return reply({ status: '1', message: 'OK', result: [{
      hash: '0xabc', to: '0xdead', value: '3237000000000000',
      isError: '0', confirmations: '12',
    }] });
  });
  try {
    const out = await monitor.__fetchEvmTxs('eth', '0xDEAD');
    assert.equal(out.length, 1, 'the deposit was not found');
    assert.equal(out[0].txHash, '0xabc');
    assert.ok(Math.abs(out[0].amount - 0.003237) < 1e-12);
    assert.ok(out[0].confirmed);
    assert.ok(!asked.some(u => u.includes('etherscan.io')),
      'spent a request on Etherscan with no key to send');
  } finally {
    process.env.ETHERSCAN_API_KEY = realKey;
  }
});

test('a refused explorer falls through instead of reporting an empty address', async () => {
  // The heart of it. "Missing/Invalid API Key" is not "no deposits arrived",
  // and treating the two the same is what hid every ETH deposit.
  const realKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = 'set-but-rejected';
  let call = 0;
  const monitor = loadMonitor(async () => reply(++call === 1
    ? { status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }
    : { status: '1', message: 'OK', result: [{ hash: '0xf00d', to: '0xdead',
        value: '1000000000000000000', isError: '0', confirmations: '3' }] }));
  try {
    const out = await monitor.__fetchEvmTxs('eth', '0xDEAD');
    assert.equal(call, 2, 'never tried the second source');
    assert.equal(out.length, 1, 'a rejected key still swallowed the deposit');
  } finally {
    process.env.ETHERSCAN_API_KEY = realKey;
  }
});

test('an address with nothing on it is not a failure to retry', async () => {
  let calls = 0;
  const monitor = loadMonitor(async () => {
    calls++;
    return reply({ status: '0', message: 'No transactions found', result: [] });
  });
  assert.deepEqual(await monitor.__fetchEvmTxs('eth', '0xDEAD'), []);
  assert.equal(calls, 1, 'burned a second source on a genuinely empty address');
});

test('explorers are asked for one page, not a whole history', () => {
  // A full history on a busy address takes longer than the 12s timeout, and a
  // timeout here reads as "no deposits" — the same failure by another route.
  // Measured: 12s+ timeout unpaged, 415ms paged.
  const src = svc('blockchainMonitor.js');
  assert.match(src, /const PAGE = \d+;/);
  for (const m of src.matchAll(/action=txlist[^`]*/g)) {
    assert.match(m[0], /offset=\$\{PAGE\}/, `an unpaged txlist call: ${m[0].slice(0, 90)}`);
  }
});

test('sending ETH does not need a private RPC configured', () => {
  // new JsonRpcProvider(undefined) threw before reaching the chain, so ETH
  // could not be forwarded either. BNB and SOL already had a fallback.
  const src = svc('chainSend.js');
  assert.match(src, /ALCHEMY_ETH_RPC \|\| ETH_RPC_FALLBACK/);
  assert.match(src, /const ETH_RPC_FALLBACK = 'https:\/\//);
});

test('money on the wrong chain is reported, never credited', async () => {
  // An 0x address is ours on every EVM network. A send to the right address on
  // the wrong chain has to become visible — but it cannot be credited: the
  // sweep converts through ChangeNow, which has no L2 support, so a credit
  // would be issued against ETH nobody can move.
  const l2 = require('../src/services/l2Watch');
  assert.ok(l2.L2_CHAINS.some(c => c.chainId === 4663), 'Robinhood Chain is not watched');

  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () =>
    ({ jsonrpc: '2.0', id: 1, result: '0xb8008cb235000' }) });   // 0.003237 ETH
  const supabase = { from: () => ({ select: () => ({ ilike: async () => ({
    data: [{ user_id: 'u1', address: '0x003D1682aaa7feaA2EC52d1C877fb7c32022eF76' }] }) }) }) };
  try {
    const found = await l2.findStranded(supabase);
    assert.ok(found.length >= 1, 'stranded funds were not detected');
    assert.ok(Math.abs(found[0].eth - 0.003237) < 1e-9);
    assert.ok(found.some(f => f.chain === 'Robinhood Chain'));
  } finally { global.fetch = realFetch; }

  // And nothing in it moves money or grants coins.
  const src = svc('l2Watch.js');
  assert.doesNotMatch(src, /sendCrypto|c_coins|addBalance|createDepositSwap/,
    'l2Watch must only observe');
});

test('dust is left alone', async () => {
  const l2 = require('../src/services/l2Watch');
  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ result: '0x2386f26fc10000' }) }); // 0.01 ETH
  const supabase = { from: () => ({ select: () => ({ ilike: async () => ({
    data: [{ user_id: 'u1', address: '0xabc' }] }) }) }) };
  try {
    assert.equal((await l2.findStranded(supabase, { minEth: 1 })).length, 0,
      'reported a balance under the floor');
  } finally { global.fetch = realFetch; }
});

test('the deposit screen warns before the address is copied', () => {
  // The address is what people copy; a warning under it is a warning after the
  // mistake. Only for 0x addresses — the network-collision problem is an EVM
  // one, and a blanket warning on a Solana address is noise.
  const jsx = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Wallet.jsx'), 'utf8');
  const warn = jsx.indexOf('Send on {depCoin.network} only');
  const addr = jsx.indexOf('{/* Address */}');
  assert.ok(warn > 0, 'no wrong-network warning on the deposit screen');
  assert.ok(addr > warn, 'the warning is below the address');
  assert.match(jsx, /depAddress\.address\?\.startsWith\('0x'\)/);
  assert.match(jsx, /Robinhood/);
});
