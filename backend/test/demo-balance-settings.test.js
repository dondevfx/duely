// POST /api/wallet/demo-balance — the Settings balance setter for demo accounts.
// It WRITES a balance, so a real account reaching it would be minting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DEMO = 'dddddddd-0000-4000-8000-0000000000d1';
const REAL = 'aaaaaaaa-0000-4000-8000-0000000000a1';
process.env.DEMO_ACCOUNT_IDS = DEMO;

function fakeSupabase() {
  const writes = [];
  const chain = (table) => {
    const c = {
      update(row) { c.row = row; return c; },
      eq(_k, id) { writes.push({ table, row: c.row, id }); return Promise.resolve({ error: null }); },
      select() { return c; }, single() { return Promise.resolve({ data: null, error: null }); },
      insert() { return Promise.resolve({ error: null }); },
    };
    return c;
  };
  return { from: chain, rpc: () => Promise.resolve({ data: null, error: null }), writes };
}

async function boot(userId) {
  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = { ...realAuth, requireAuth: (req, _res, next) => { req.user = { id: userId }; next(); } };
  const walletPath = require.resolve('../src/routes/wallet');
  delete require.cache[walletPath];
  const sb = fakeSupabase();
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', require(walletPath)(sb, { to: () => ({ emit() {} }), emit() {} }));
  require.cache[authPath].exports = realAuth;
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/wallet/demo-balance`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  return { post, sb, close: () => new Promise(r => server.close(r)) };
}

test('a real account cannot use it: 404, nothing written', async () => {
  const s = await boot(REAL);
  try {
    const r = await s.post({ coins: 1000000, diamonds: 1000000 });
    assert.equal(r.status, 404);
    assert.equal(s.sb.writes.length, 0);
  } finally { await s.close(); }
});

test('a demo account sets Coins and Diamonds exactly', async () => {
  const s = await boot(DEMO);
  try {
    const r = await s.post({ coins: 2500.5, diamonds: 75000 });
    assert.equal(r.status, 200);
    assert.deepEqual(s.sb.writes, [{ table: 'profiles', row: { c_coins: 2500.5, diamonds: 75000 }, id: DEMO }]);
    const one = await s.post({ coins: '', diamonds: 10 });
    assert.equal(one.status, 200);
    assert.deepEqual(s.sb.writes[1].row, { diamonds: 10 });
  } finally { await s.close(); }
});

test('bad amounts are refused', async () => {
  const s = await boot(DEMO);
  try {
    for (const body of [{}, { coins: -1 }, { coins: 'abc' }, { coins: 2_000_000 }, { diamonds: 2_000_000_000 }]) {
      assert.equal((await s.post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(s.sb.writes.length, 0);
  } finally { await s.close(); }
});

test('the Settings section only renders for demo accounts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'Profile.jsx'), 'utf8');
  assert.match(src, /\{profile\?\.is_demo && \(\s*<>\s*<DemoBalanceSection/);
  assert.match(src, /api\.post\('\/wallet\/demo-balance'/);
});
