/**
 * heliusWebhooks.js
 *
 * Deposits on Solana, pushed instead of polled.
 *
 * The monitor asks every deposit address ever issued whether anything has
 * arrived, every 45 seconds, forever — whether the account is active, whether
 * it has ever received anything, whether the person signed up once in August
 * and never came back. Cost therefore scales with lifetime signups rather than
 * with actual deposits, and never comes down: each new player adds three
 * Solana addresses and about 5,800 RPC calls a day, permanently. That is what
 * exhausted a month of credits, and no amount of caching fixes it, because the
 * floor is one call per address per pass.
 *
 * A webhook inverts it. Helius watches the addresses and calls US when one
 * receives something, so the steady-state cost of an idle address is zero and
 * detection is immediate rather than up to 45 seconds late. The only recurring
 * work is keeping the watched list in step with the table.
 *
 * This does NOT replace polling — see the sweep interval in blockchainMonitor.
 * A webhook can be missed: a deploy during delivery, a retry budget running
 * out, this service failing to re-register after a Helius-side change. A slow
 * pass over every address a few times a day is the backstop, and at that
 * cadence it costs a rounding error rather than a plan.
 *
 * Solana only. BTC, ETH, LTC, DOGE, BNB and TRX go through BlockCypher,
 * Etherscan and TronGrid, which have their own limits and their own answers.
 */

const fetch = require('node-fetch');

const API = 'https://api.helius.xyz/v0/webhooks';

// The three coins that live at a Solana address. USDC and USDT arrive as SPL
// token transfers to the same wallet, so one registered address covers all
// three — Helius reports the OWNER account for a token transfer, not the
// associated token account.
const SOL_COINS = ['sol', 'usdc', 'usdt'];

function apiKey() {
  return process.env.HELIUS_API_KEY || '';
}

/**
 * Where Helius should deliver. Explicit env first, then Railway's own domain
 * so a deploy there needs one variable rather than two.
 */
function publicUrl() {
  if (process.env.PUBLIC_API_URL) {
    return `${process.env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/webhooks/helius`;
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/webhooks/helius`;
  }
  return '';
}

/**
 * The shared secret Helius sends back in the Authorization header, which is
 * the only thing standing between this endpoint and anyone who can find the
 * URL. Deposits are money, so with no secret configured the feature stays off
 * entirely rather than accepting unauthenticated deposit notifications.
 */
function secret() {
  return process.env.HELIUS_WEBHOOK_SECRET || '';
}

function isEnabled() {
  return !!(apiKey() && publicUrl() && secret());
}

async function heliusFetch(url, opts = {}, ms = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      throw new Error(`Helius API ${res.status}: ${text.trim().slice(0, 200) || '<empty>'}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

/** Every Solana deposit address we have issued. */
async function solanaAddresses(supabase) {
  const { data, error } = await supabase
    .from('deposit_addresses')
    .select('address, coin')
    .in('coin', SOL_COINS);
  if (error) throw new Error(`deposit_addresses query failed: ${error.message}`);
  // One entry per address. A player has a row per coin and all three derive to
  // the same Solana address, so the raw list is three times longer than the
  // number of accounts Helius needs to watch.
  return [...new Set((data || []).map(r => r.address).filter(Boolean))];
}

/**
 * Bring the registered address list in line with the table.
 *
 * Finds our own webhook by its delivery URL rather than storing an id: the id
 * would need somewhere durable to live, and would go stale the moment someone
 * deleted the webhook in the dashboard. The URL is what makes it ours.
 */
async function sync(supabase) {
  if (!isEnabled()) return { skipped: true };

  const url = publicUrl();
  const addresses = await solanaAddresses(supabase);
  if (addresses.length === 0) return { addresses: 0 };

  // Helius caps a webhook's address list. Past the cap the extra addresses
  // stay on the polling backstop rather than being silently dropped — better
  // a slower path for some than a missing one nobody knows about.
  const MAX_ADDRESSES = 100_000;
  const watch = addresses.slice(0, MAX_ADDRESSES);
  if (addresses.length > watch.length) {
    console.warn(`[helius] ${addresses.length} addresses exceeds the ${MAX_ADDRESSES} cap — ` +
                 `${addresses.length - watch.length} left to the polling backstop`);
  }

  const existing = await heliusFetch(`${API}?api-key=${apiKey()}`);
  const mine = (existing || []).find(w => w.webhookURL === url);

  const payload = {
    webhookURL:       url,
    transactionTypes: ['Any'],
    accountAddresses: watch,
    webhookType:      'enhanced',
    authHeader:       secret(),
  };

  if (!mine) {
    await heliusFetch(`${API}?api-key=${apiKey()}`, { method: 'POST', body: JSON.stringify(payload) });
    console.log(`[helius] webhook created for ${watch.length} address(es)`);
    return { created: true, addresses: watch.length };
  }

  // Skip the write when nothing changed. This runs on every boot and after
  // every new address, and an unchanged PUT is a request that buys nothing.
  const before = new Set(mine.accountAddresses || []);
  const same = before.size === watch.length && watch.every(a => before.has(a));
  if (same) return { unchanged: true, addresses: watch.length };

  await heliusFetch(`${API}/${mine.webhookID}?api-key=${apiKey()}`,
    { method: 'PUT', body: JSON.stringify(payload) });
  console.log(`[helius] webhook updated: ${before.size} -> ${watch.length} address(es)`);
  return { updated: true, addresses: watch.length };
}

/**
 * Re-sync, coalesced.
 *
 * Called whenever an address is issued, and addresses are issued in bursts —
 * a player opening the deposit page creates one per coin back to back. Sending
 * a full list rewrite for each would be three identical writes, so the work is
 * deferred and collapsed into one.
 */
let _pending = null;
const COALESCE_MS = 10_000;

function scheduleSync(supabase) {
  if (!isEnabled() || _pending) return;
  _pending = setTimeout(() => {
    _pending = null;
    sync(supabase).catch(e => console.error('[helius] sync failed:', e.message));
  }, COALESCE_MS);
  // Never hold the process open for a re-registration.
  if (_pending.unref) _pending.unref();
}

function init(supabase) {
  if (!isEnabled()) {
    const missing = [
      !apiKey()     && 'HELIUS_API_KEY',
      !publicUrl()  && 'PUBLIC_API_URL (or RAILWAY_PUBLIC_DOMAIN)',
      !secret()     && 'HELIUS_WEBHOOK_SECRET',
    ].filter(Boolean);
    console.log(`[helius] webhooks off — set ${missing.join(', ')}. Solana deposits stay on polling.`);
    return;
  }
  // After boot, not during it: this is a network round trip and nothing about
  // it needs to delay the server accepting requests.
  const t = setTimeout(() => {
    sync(supabase)
      .then(r => { if (r?.unchanged) console.log(`[helius] webhook already covers ${r.addresses} address(es)`); })
      .catch(e => console.error('[helius] initial sync failed:', e.message));
  }, 15_000);
  if (t.unref) t.unref();
}

module.exports = { init, sync, scheduleSync, isEnabled, publicUrl, secret, SOL_COINS };
