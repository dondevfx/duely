// Solana deposits, pushed instead of polled.
//
// The monitor asked every address ever issued whether anything had arrived,
// every 45 seconds, forever — so the cost scaled with lifetime signups rather
// than with deposits, and never came down. This is the same information
// arriving the other way round. The tests that matter are the ones about the
// door: an endpoint that credits money, reached by a URL, is protected by the
// secret or by nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HOOKS   = read('src', 'routes', 'webhooks.js');
const SERVICE = read('src', 'services', 'heliusWebhooks.js');
const MONITOR = read('src', 'services', 'blockchainMonitor.js');
const ADDRESS = read('src', 'services', 'addressService.js');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OURS = 'D9PM1yy8qjSfKEsGrhECVYaBu9fgRe294Lm9krud8SM7';
const THEIRS = 'GAaFbwE9wvQsiiFsfKVAWExd8ioVgGZDzT3jvWR4LqoT';

// A supabase double that only knows deposit_addresses.
function fakeDb(rows) {
  return {
    from: (table) => ({
      select: () => ({
        in: async (_col, vals) => {
          assert.equal(table, 'deposit_addresses');
          return { data: rows.filter(r => vals.includes(r.address)) };
        },
      }),
    }),
  };
}

// Boots the real router with processDeposit swapped for a recorder, so the
// test exercises the actual parsing and auth rather than a copy of them.
async function withRouter(rows, fn) {
  const monitorPath = require.resolve('../src/services/blockchainMonitor');
  const hooksPath   = require.resolve('../src/routes/webhooks');
  const realMonitor = require(monitorPath);
  const calls = [];

  require.cache[monitorPath].exports = {
    ...realMonitor,
    processDeposit: async (_db, args) => { calls.push(args); },
  };
  delete require.cache[hooksPath];
  const webhookRoutes = require(hooksPath);

  const app = express();
  app.use('/api/webhooks', webhookRoutes(fakeDb(rows)));
  const server = app.listen(0);
  const port = server.address().port;
  try {
    await fn({ port, calls });
  } finally {
    server.close();
    require.cache[monitorPath].exports = realMonitor;
    delete require.cache[hooksPath];
  }
}

const post = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/api/webhooks/helius`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// Settle the fire-and-forget processing the route does after responding.
const settle = () => new Promise(r => setTimeout(r, 60));

test('no secret configured means the door is shut', async () => {
  const prev = process.env.HELIUS_WEBHOOK_SECRET;
  delete process.env.HELIUS_WEBHOOK_SECRET;
  await withRouter([], async ({ port, calls }) => {
    // Not merely "the feature is off" — an unconfigured secret must not become
    // an endpoint that accepts unauthenticated deposit notifications.
    const res = await post(port, [], {});
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
  if (prev !== undefined) process.env.HELIUS_WEBHOOK_SECRET = prev;
});

test('a wrong or missing secret is refused', async () => {
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([], async ({ port }) => {
    assert.equal((await post(port, [], {})).status, 401);
    assert.equal((await post(port, [], { authorization: 'wrong' })).status, 401);
    assert.equal((await post(port, [], { authorization: 'right' })).status, 200);
  });
});

test('a SOL transfer to one of our addresses is a deposit', async () => {
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([{ address: OURS, coin: 'sol', user_id: 'u1' }], async ({ port, calls }) => {
    await post(port, [{
      signature: 'sig1',
      nativeTransfers: [{ fromUserAccount: THEIRS, toUserAccount: OURS, amount: 250_000_000 }],
    }], { authorization: 'right' });
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      userId: 'u1', coin: 'sol', address: OURS, txHash: 'sig1', amount: 0.25,
    });
  });
});

test('lamports are converted, not passed through', async () => {
  // 250000000 credited as 250 million SOL would be a memorable incident.
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([{ address: OURS, coin: 'sol', user_id: 'u1' }], async ({ port, calls }) => {
    await post(port, [{
      signature: 'sig2',
      nativeTransfers: [{ toUserAccount: OURS, amount: 1_000_000_000 }],
    }], { authorization: 'right' });
    await settle();
    assert.equal(calls[0].amount, 1);
  });
});

test('a USDC transfer is recognised by its mint', async () => {
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([{ address: OURS, coin: 'usdc', user_id: 'u1' }], async ({ port, calls }) => {
    await post(port, [{
      signature: 'sig3',
      tokenTransfers: [{ toUserAccount: OURS, mint: USDC, tokenAmount: 12.5 }],
    }], { authorization: 'right' });
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].coin, 'usdc');
    assert.equal(calls[0].amount, 12.5);
  });
});

test('an unknown mint is ignored', async () => {
  // Anyone can mint a token and send it to any address. Crediting on the
  // strength of "a token arrived" would credit whatever someone printed.
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([{ address: OURS, coin: 'usdc', user_id: 'u1' }], async ({ port, calls }) => {
    await post(port, [{
      signature: 'sig4',
      tokenTransfers: [{ toUserAccount: OURS, mint: 'SCAMcoin1111111111111111111111111111111111', tokenAmount: 1e9 }],
    }], { authorization: 'right' });
    await settle();
    assert.equal(calls.length, 0);
  });
});

test('transfers to addresses that are not ours are ignored', async () => {
  // Helius reports the whole transaction, so the other side of every transfer
  // arrives too — including the sweep we make right after a deposit.
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([{ address: OURS, coin: 'sol', user_id: 'u1' }], async ({ port, calls }) => {
    await post(port, [{
      signature: 'sig5',
      nativeTransfers: [
        { toUserAccount: THEIRS, amount: 5_000_000 },
        { toUserAccount: OURS,   amount: 5_000_000 },
      ],
    }], { authorization: 'right' });
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].address, OURS);
  });
});

test('zero and negative amounts are ignored', async () => {
  process.env.HELIUS_WEBHOOK_SECRET = 'right';
  await withRouter([{ address: OURS, coin: 'sol', user_id: 'u1' }], async ({ port, calls }) => {
    await post(port, [{
      signature: 'sig6',
      nativeTransfers: [{ toUserAccount: OURS, amount: 0 }],
      tokenTransfers:  [{ toUserAccount: OURS, mint: USDC, tokenAmount: -5 }],
    }], { authorization: 'right' });
    await settle();
    assert.equal(calls.length, 0);
  });
});

test('the response does not wait for the deposit to be processed', () => {
  // Helius retries on a non-2xx, and processing means a swap and an on-chain
  // forward — far longer than any delivery timeout. Holding the response open
  // earns a retry for a deposit already in hand.
  const route = HOOKS.slice(HOOKS.indexOf("router.post('/helius'"));
  const ack = route.indexOf('res.json({ ok: true })');
  const work = route.indexOf('handleHeliusEvent');
  assert.ok(ack > 0 && work > ack, 'acknowledge first, work after');
});

test('the webhook path credits through the same function the poller does', () => {
  // Two paths into money with two sets of rules is how a deposit gets credited
  // twice. This one decides WHICH deposit and nothing else.
  assert.match(HOOKS, /processDeposit \} = require\('\.\.\/services\/blockchainMonitor'\)/);
  assert.match(MONITOR, /module\.exports = \{[^}]*processDeposit/);
  const route = HOOKS.slice(HOOKS.indexOf("router.post('/helius'"));
  assert.ok(!/creditCoins|recordDeposit|from\('transactions'\)/.test(route),
    'the webhook must not have its own crediting logic');
});

test('polling stays on as the backstop', () => {
  // A webhook can be missed: a deploy mid-delivery, a retry budget running
  // out, a re-registration that failed. Deposits are money.
  assert.match(MONITOR, /SOL_SWEEP_EVERY_PASSES = 480/);
  assert.match(MONITOR, /_passNo % SOL_SWEEP_EVERY_PASSES\) === 0/);
  assert.match(MONITOR, /if \(heliusOn && !sweeping\)/,
    'Solana is only skipped when webhooks are actually enabled');
});

test('the first pass after a restart sweeps everything', () => {
  // Otherwise a restart waits six hours to discover what arrived while the
  // process was down — exactly the window a webhook cannot cover.
  assert.match(MONITOR, /let _passNo = 0/);
  const at = MONITOR.indexOf('const sweeping =');
  const incr = MONITOR.indexOf('_passNo++');
  assert.ok(at > 0 && incr > at, 'the pass number is read before it is bumped, so pass 0 sweeps');
});

test('a new address is registered, and the registration is coalesced', () => {
  // Opening the deposit page creates one address per coin back to back, and
  // all three derive to the same Solana account — three identical full-list
  // rewrites for one player.
  assert.match(ADDRESS, /require\('\.\/heliusWebhooks'\)\.scheduleSync\(supabase\)/);
  assert.match(SERVICE, /COALESCE_MS = 10_000/);
  assert.match(SERVICE, /if \(!isEnabled\(\) \|\| _pending\) return/);
});

test('an unchanged address list is not rewritten', () => {
  // sync runs on every boot and after every new address; an unchanged PUT is
  // a request that buys nothing.
  assert.match(SERVICE, /const same = before\.size === watch\.length && watch\.every/);
  assert.match(SERVICE, /if \(same\) return \{ unchanged: true/);
});

test('the webhook is found by its delivery URL, not a stored id', () => {
  // An id needs somewhere durable to live and goes stale the moment someone
  // deletes the webhook in the dashboard. The URL is what makes it ours.
  assert.match(SERVICE, /\.find\(w => w\.webhookURL === url\)/);
});

// ── Registration survives being unable to register ────────────────────────

test('a failed sync is retried, with backoff', async () => {
  // The failure that actually happened: the account was out of RPC credits, so
  // REGISTERING the webhook failed too. One attempt 15 seconds after boot and
  // nothing afterwards means the feature stays off after credits return, until
  // something restarts the server — silently unregistered while every log line
  // says it started.
  const SERVICE_SRC = read('src', 'services', 'heliusWebhooks.js');
  assert.match(SERVICE_SRC, /function syncWithRetry\(supabase, attempt = 0\)/);
  assert.match(SERVICE_SRC, /RETRY_BASE_MS \* 2 \*\* attempt/, 'backoff, not a fixed interval');
  assert.match(SERVICE_SRC, /Math\.min\([^)]*RETRY_MAX_MS\)/, 'and a ceiling on the wait');
  assert.match(SERVICE_SRC, /const t = setTimeout\(\(\) => syncWithRetry\(supabase\), 15_000\)/,
    'init must go through the retrying path, not a bare sync');
});

test('the retry actually fires, and backs off between attempts', async () => {
  // Behaviour, not shape: the shape assertions above cannot tell a retry that
  // runs from one that was written and never wired up.
  const svc = require('../src/services/heliusWebhooks');
  const prev = { k: process.env.HELIUS_API_KEY, u: process.env.PUBLIC_API_URL, s: process.env.HELIUS_WEBHOOK_SECRET };
  process.env.HELIUS_API_KEY = 'k';
  process.env.PUBLIC_API_URL = 'https://unreachable.invalid';
  process.env.HELIUS_WEBHOOK_SECRET = 's';

  const waits = [];
  const realTimeout = global.setTimeout;
  // Collapse the waits so the test does not sit through a minute of backoff,
  // recording what the real delays would have been.
  global.setTimeout = (fn, ms) => {
    if (ms >= 60_000) { waits.push(ms); if (waits.length > 3) return { unref() {} }; ms = 1; }
    return realTimeout(fn, ms);
  };

  // Every attempt throws — the address query fails before any network call.
  const db = { from: () => ({ select: () => ({ in: async () => ({ error: { message: 'down' } }) }) }) };
  try {
    svc.syncWithRetry(db);
    await new Promise(r => realTimeout(r, 200));
  } finally {
    global.setTimeout = realTimeout;
    process.env.HELIUS_API_KEY = prev.k ?? '';
    if (prev.u === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = prev.u;
    process.env.HELIUS_WEBHOOK_SECRET = prev.s ?? '';
  }

  assert.ok(waits.length >= 3, `expected repeated retries, saw ${waits.length}`);
  assert.equal(waits[0], 60_000);
  assert.ok(waits[1] > waits[0] && waits[2] > waits[1],
    `each wait must grow: ${waits.slice(0, 3).join(', ')}`);
});

test('having no addresses yet is not a failure to retry against', () => {
  // A fresh deployment has none. scheduleSync fires when the first is issued,
  // so a timer here would just burn requests asking about an empty table.
  const SERVICE_SRC = read('src', 'services', 'heliusWebhooks.js');
  assert.match(SERVICE_SRC, /if \(addresses\.length === 0\) return \{ addresses: 0 \}/);
  assert.match(SERVICE_SRC, /will register when one is issued/);
});
