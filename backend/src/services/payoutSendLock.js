/**
 * One payout broadcast at a time per wallet, across EVERY server.
 *
 * chainSend queues sends per wallet in memory, which only holds while the
 * backend is one process. With two instances, each has its own queue: two
 * ETH withdrawals on two servers still read the same nonce, and two BTC
 * withdrawals still spend the same outputs.
 *
 * payout_send_locks has the queue key as its PRIMARY KEY, so an INSERT is the
 * lock: one server's insert succeeds and every other gets 23505 and waits.
 * The row is deleted when the broadcast finishes. A crash in between leaves a
 * row behind, so a lock older than STALE_MS is taken over — a broadcast takes
 * seconds, never minutes.
 *
 * payout_nonces keeps each EVM wallet's next nonce, so a server that did not
 * send the previous transaction still knows the number it used, even while
 * the RPC's own pending count has not caught up.
 *
 * Before PENDING_SQL section 29 the tables do not exist. Sends then fall back
 * to the in-memory queue (safe on one server) and say so once in the log.
 */
const crypto = require('crypto');

const STALE_MS    = 2 * 60 * 1000;
const WAIT_MS     = 60 * 1000;
const RETRY_EVERY = 200;

let _client = null;
let _override = null;
function db() {
  if (_override) return _override;
  if (!_client && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  }
  return _client;
}
/** Tests only. */
function _setClient(c) { _override = c; }

const isMissingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205'
  || /payout_send_locks|payout_nonces|does not exist|schema cache/i.test(e.message || ''));

let _warned = false;
function warnMissing(log) {
  if (_warned) return;
  _warned = true;
  log.warn?.('[payout-lock] payout_send_locks / payout_nonces missing — run PENDING_SQL section 29. ' +
    'Payouts are queued in memory only, which is NOT safe on more than one server.');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run fn while holding the database lock for key. Throws if the lock cannot be
 * taken — a payout that cannot confirm it is alone must not broadcast.
 */
async function withPayoutLock(key, fn, { log = console, now = () => Date.now() } = {}) {
  const sb = db();
  if (!sb) { warnMissing(log); return fn({ db: false }); }

  const holder = crypto.randomUUID();
  const deadline = now() + WAIT_MS;
  for (;;) {
    const { error } = await sb.from('payout_send_locks').insert({ key, holder });
    if (!error) break;
    if (isMissingTable(error)) { warnMissing(log); return fn({ db: false }); }
    if (error.code !== '23505') throw new Error(`payout lock unavailable: ${error.message}`);

    const cutoff = new Date(now() - STALE_MS).toISOString();
    const { data: cleared } = await sb.from('payout_send_locks')
      .delete().eq('key', key).lt('created_at', cutoff).select('key');
    if (cleared?.length) {
      log.error?.(`[payout-lock] cleared an abandoned lock on ${key}`);
      continue;
    }
    if (now() > deadline) throw new Error('payout queue busy, try again shortly');
    await sleep(RETRY_EVERY);
  }

  try {
    return await fn({ db: true });
  } finally {
    // Only our own row. Never throws: a release failure clears after STALE_MS.
    try {
      await sb.from('payout_send_locks').delete().eq('key', key).eq('holder', holder);
    } catch (e) {
      log.error?.(`[payout-lock] release failed on ${key}: ${e.message}`);
    }
  }
}

/** The stored next nonce for a wallet, or null if there is none / no table. */
async function readNonce(key) {
  const sb = db();
  if (!sb) return null;
  const { data, error } = await sb.from('payout_nonces').select('next_nonce').eq('key', key).maybeSingle();
  if (error) return null;
  return data ? Number(data.next_nonce) : null;
}

async function writeNonce(key, next, log = console) {
  const sb = db();
  if (!sb) return;
  const { error } = await sb.from('payout_nonces')
    .upsert({ key, next_nonce: next, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error && !isMissingTable(error)) log.error?.(`[payout-lock] could not store nonce for ${key}: ${error.message}`);
}

module.exports = { withPayoutLock, readNonce, writeNonce, STALE_MS, _setClient };
