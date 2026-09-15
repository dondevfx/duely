// Helius costs: the same idle Solana transactions were being fetched on every
// sweep, every stablecoin address was checked hourly, and an unchanged webhook
// list was re-read after every address issued.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');

test('a Solana signature with no deposit in it is not fetched again', () => {
  const s = read('blockchainMonitor.js');
  assert.match(s, /const _ruledOut = new Set\(\)/);
  // Both Solana paths skip them, and both only rule OUT a signature that
  // produced nothing — a deposit is always re-checked.
  assert.equal((s.match(/if \(_ruledOut\.has\(sig\.signature\)\) continue;/g) || []).length, 2);
  assert.match(s, /if \(results\.length === found\) ruleOut\(sig\.signature\);/);
  assert.match(s, /if \(lamports <= 0\) \{ ruleOut\(sig\.signature\); continue; \}/);
  // Bounded, or a long-running process grows one entry per signature seen.
  assert.match(s, /_ruledOut\.size >= RULED_OUT_MAX/);
});

test('the stablecoin sweep checks live addresses hourly and everything daily', () => {
  const s = read('blockchainMonitor.js');
  const fn = s.slice(s.indexOf('async function sweepStrandedUsdc'), s.indexOf('function reportConfig'));
  assert.match(fn, /_lastFullStableSweep/);
  assert.match(fn, /isHot\(r\.user_id, r\.coin\) \|\| _hadStablecoin\.has/);
  assert.match(fn, /_hadStablecoin\.add/);
  assert.match(s, /const FULL_STABLE_SWEEP_MS = 24 \* 60 \* 60 \* 1000/);
  // The hourly cadence itself is unchanged: the backstop still runs.
  assert.match(s, /const SWEEP_INTERVAL_MS = 60 \* 60 \* 1000/);
});

test('an unchanged webhook address list costs no Helius API calls', async () => {
  process.env.HELIUS_API_KEY = 'k'.repeat(10);
  process.env.PUBLIC_API_URL = 'https://example.test';
  process.env.HELIUS_WEBHOOK_SECRET = 's'.repeat(10);

  // node-fetch, stubbed before the module is loaded.
  const calls = [];
  const fetchPath = require.resolve('node-fetch');
  const realFetch = require(fetchPath);
  require.cache[fetchPath].exports = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${String(url).split('?')[0]}`);
    const body = String(url).includes('/webhooks/') || opts.method === 'PUT' || opts.method === 'POST'
      ? { webhookID: 'w1', webhookURL: 'https://example.test/api/webhooks/helius', accountAddresses: ['AAA', 'BBB'] }
      : [{ webhookID: 'w1', webhookURL: 'https://example.test/api/webhooks/helius' }];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const modPath = require.resolve('../src/services/heliusWebhooks');
  delete require.cache[modPath];
  const mod = require(modPath);
  assert.equal(mod.isEnabled(), true);

  const addresses = [{ address: 'AAA', coin: 'sol' }, { address: 'BBB', coin: 'usdc' }];
  const supabase = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: addresses, error: null }) }) }) };

  try {
    const first = await mod.sync(supabase);
    assert.equal(first.unchanged, true);
    const n = calls.length;
    assert.ok(n >= 2, 'the first sync reads the webhook');
    const second = await mod.sync(supabase);
    assert.deepEqual(second, { unchanged: true, addresses: 2, cached: true });
    assert.equal(calls.length, n, 'a repeat sync must not call Helius at all');

    // A new address still re-registers.
    addresses.push({ address: 'CCC', coin: 'sol' });
    const third = await mod.sync(supabase);
    assert.ok(third.updated || third.created, 'a changed list must be written');
    assert.ok(calls.length > n);
  } finally {
    require.cache[fetchPath].exports = realFetch;
    delete require.cache[modPath];
  }
});
