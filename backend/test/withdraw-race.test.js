// Two withdrawals launched at the same instant.
//
// The in-flight lock is CHECKED at the end of withdrawalGuards and SET later,
// at the top of the route's try block. That looks racy and is not, for one
// specific reason: between the two there is a single await resumption and then
// only synchronous code. Another request can reach the same lines only when an
// I/O event is delivered, and a macrotask cannot preempt a microtask
// continuation — so no second request can observe the unlocked state.
//
// That correctness rests entirely on nothing awaitable appearing in that gap.
// It was a comment; now it is a test. Adding an `await` between the guard and
// the lock — a plausible edit, e.g. looking up a fee or a price before
// validating — would open a real hole: deduct_coins is atomic so a balance
// could never be overdrawn, but the playthrough rule is checked per request
// against the amount asked for, so with $100 of coins and $50 withdrawable,
// two concurrent $50 withdrawals would each pass and $100 would leave against
// a $50 limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');

test('nothing is awaited between the lock check and the lock set', () => {
  const check = SRC.indexOf('activeWithdrawals.has(');
  const set   = SRC.indexOf('activeWithdrawals.add(', check);
  assert.ok(check !== -1 && set !== -1, 'the in-flight lock is gone');

  // The gap spans the end of withdrawalGuards and the route's validation.
  const gap = SRC.slice(check, set);
  const code = gap.split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  // `await withdrawalGuards(req)` is the one permitted await: it is the call
  // that performed the check, so its resumption is the microtask boundary the
  // reasoning above is about, not an extra one inside the gap.
  const awaits = (code.match(/\bawait\b/g) || [])
    .filter((_, i) => true);
  const guardAwait = (code.match(/await withdrawalGuards\(req\)/g) || []).length;
  assert.equal(awaits.length - guardAwait, 0,
    'an await here lets a second withdrawal observe the unlocked state — ' +
    'take the lock synchronously instead, immediately after the check');
});

test('both withdrawal routes take the lock, and release it', () => {
  const adds    = (SRC.match(/activeWithdrawals\.add\(/g) || []).length;
  const deletes = (SRC.match(/activeWithdrawals\.delete\(/g) || []).length;
  assert.equal(adds, 2, 'the crypto and fiat routes must each take the lock');
  assert.equal(deletes, adds, 'every acquisition needs a matching release');
});

test('validation runs before the lock is taken', () => {
  // A rejected request that had already taken the lock would bar the player
  // from withdrawing until the process restarted — the lock is in memory and
  // nothing else ever clears it.
  for (const route of ["router.post('/withdraw'", "router.post('/withdraw-fiat'"]) {
    const at = SRC.indexOf(route);
    assert.notEqual(at, -1, `${route} is gone`);
    const body = SRC.slice(at, SRC.indexOf('activeWithdrawals.add(', at));
    assert.match(body, /return res\.status\(400\)/,
      `${route} takes the lock before it validates anything`);
  }
});

// ── And the behaviour, driven through the real route ───────────────────────

function boot({ withdrawable = 50, balance = 100 } = {}) {
  const app = express();
  app.use(express.json());

  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = {
    ...realAuth,
    // A verified email and an aal2 session, so the request reaches the lock
    // rather than being turned away by a guard that runs before it.
    requireAuth: (req, _res, next) => {
      req.user = { id: 'racer', email_confirmed_at: new Date().toISOString() };
      next();
    },
    tokenAal: () => 'aal2',
  };

  // Chainable, because the route chains .eq().eq() in places and a mock that
  // stops one level short fails as a 500 that looks like the bug under test.
  const q = () => {
    const o = {
      single: async () => {
        await new Promise(r => setImmediate(r));   // a real I/O-shaped await
        return { data: { banned: false }, error: null };
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update', 'ilike']) {
      o[m] = () => o;
    }
    return o;
  };
  const supabase = {
    from: () => q(),
    auth: { admin: { getUserById: async () => ({ data: { user: { factors: [] } } }) } },
    rpc: async () => ({ error: null }),
  };

  const stub = (mod, exports) => {
    const p = require.resolve(mod);
    const real = require.cache[p];
    require.cache[p] = { id: p, filename: p, loaded: true,
                         exports: { ...(real ? real.exports : {}), ...exports } };
    return () => { if (real) require.cache[p] = real; else delete require.cache[p]; };
  };

  const attempts = [];
  const restores = [
    stub('../src/services/lockService', { isLocked: () => false }),
    stub('../src/services/walletService', {
      getWithdrawable: async () => {
        await new Promise(r => setImmediate(r));
        return { withdrawable, hasPlayed: true, lifetimeDeposited: 100,
                 lifetimeWagered: 100, unplayedDeposits: 0 };
      },
      playthroughMessage: () => null,
      getBalance: async () => balance,
      getLastWithdrawal: async () => null,
      deductCoins: async () => { attempts.push('deduct'); },
      recordWithdrawal: async () => {},
      creditCoins: async () => {},
      sanitizeAmount: (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid amount');
        return n;
      },
      MAX_SINGLE_AMOUNT: 10000,
    }),
    stub('../src/services/chainSend', {
      sendCrypto: async () => { attempts.push('send'); return 'txhash'; },
      checkPayout: async () => 'missing',
    }),
    stub('../src/services/simpleSwapService', {
      SS_TICKERS: { usdc: 'usdcsol' },
      getWithdrawalMinUsd: async () => 0,
      createWithdrawalSwap: async () => ({ id: 'x', payinAddress: 'y' }),
      estimateWithdrawal: async () => ({}),
    }),
    stub('../src/services/jupiterService', {
      swapUsdcToSol: async () => ({ txHash: 't', solReceived: 1 }),
      swapUsdcToUsdt: async () => ({}),
    }),
  ];

  delete require.cache[require.resolve('../src/routes/wallet')];
  const routes = require('../src/routes/wallet');
  app.use('/api/wallet', routes(supabase));

  require.cache[authPath].exports = realAuth;
  for (const r of restores) r();
  delete require.cache[require.resolve('../src/routes/wallet')];

  const server = app.listen(0);
  return { server, port: server.address().port, attempts };
}

const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/wallet/withdraw`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const withdraw = (port, amountUsd) => post(port, {
  coin: 'usdc', amountUsd,
  address: '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM',
});

test('two simultaneous withdrawals pay out once', async () => {
  process.env.ADMIN_PHANTOM_PRIVATE_KEY =
    process.env.ADMIN_PHANTOM_PRIVATE_KEY || '3'.repeat(88);
  const { server, port, attempts } = boot({ withdrawable: 50, balance: 100 });
  try {
    // Both in flight at once — not awaited in turn.
    const [a, b] = await Promise.all([withdraw(port, 50), withdraw(port, 50)]);
    const rejected = [a, b].filter(r => r.status === 429);
    assert.equal(rejected.length, 1,
      `both requests passed the lock — $100 could leave against a $50 allowance ` +
      `(statuses ${a.status}, ${b.status})`);
    assert.match(rejected[0].body.error || '', /already in progress/);
    assert.equal(attempts.filter(x => x === 'send').length, 1,
      'money left more than once for a single allowance');
  } finally { server.close(); }
});

test('a rejected withdrawal leaves the player able to withdraw', async () => {
  const { server, port } = boot();
  try {
    const bad = await post(port, { coin: 'nonsense', amountUsd: 10, address: 'x'.repeat(20) });
    assert.equal(bad.status, 400);
    const next = await withdraw(port, 10);
    assert.notEqual(next.status, 429, 'the rejected request kept the lock');
  } finally { server.close(); }
});

test('a hostile body is refused, not a stack trace', async () => {
  // {"coin": 123} made coin.toLowerCase() a TypeError, and a body that is not
  // JSON leaves req.body undefined so destructuring it throws. Both answered
  // 500 with a server error rather than saying what was wrong.
  const { server, port } = boot();
  try {
    const typed = await post(port, { coin: 123, amountUsd: 10, address: 'x'.repeat(20) });
    assert.equal(typed.status, 400, 'a non-string coin should be a refusal');

    const notJson = await post(port, 'not json at all');
    assert.ok(notJson.status === 400, `a non-JSON body answered ${notJson.status}`);

    // And neither left the player locked out.
    const next = await withdraw(port, 10);
    assert.notEqual(next.status, 429, 'a malformed request locked the player out');
  } finally { server.close(); }
});
