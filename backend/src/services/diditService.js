const crypto = require('node:crypto');

/**
 * Didit — identity verification.
 *
 * Two directions. We ASK for a verification session and send the player to it;
 * Didit CALLS BACK when it has decided. This file owns both halves plus the
 * translation between Didit's vocabulary and ours.
 *
 * Only bank withdrawals are gated on this. Crypto withdrawals are deliberately
 * not — a verification costs real money past the free monthly allowance, so
 * players verify at the moment they actually need to and never again.
 */

const API_BASE       = process.env.DIDIT_API_BASE   || 'https://verification.didit.me';
const API_KEY        = process.env.DIDIT_API_KEY    || '';
const WORKFLOW_ID    = process.env.DIDIT_WORKFLOW_ID || '';
const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET || '';
// 'sandbox' until the real thing is live. A sandbox event must never be able to
// approve a real player, so this is compared against the webhook's own field.
const ENVIRONMENT    = process.env.DIDIT_ENVIRONMENT || 'sandbox';

const isConfigured = () => Boolean(API_KEY && WORKFLOW_ID);

/**
 * Didit's ten statuses, mapped to our four.
 *
 * The one that matters is "In Review": it is neither a pass nor a fail — a
 * human at Didit is looking at it. Treating it as approved would let an
 * unverified player take money out; treating it as declined rejects somebody
 * who is probably fine. It is 'pending', and a person waits. This is the same
 * distinction PayPal's UNCLAIMED needed in the payout watcher, and the same
 * one that made the ChangeNow refund logic wrong the first time.
 *
 * "Kyc Expired" is the other one worth naming: a previously APPROVED
 * verification that has lapsed. It moves a player back out of 'approved', so
 * the gate has to be able to close again, not only open.
 *
 * Expired and Abandoned mean the player never finished. They are not failures
 * and must not read as rejections — the player simply starts again.
 */
const STATUS_MAP = {
  'Approved':      'approved',
  'Declined':      'rejected',
  'In Review':     'pending',
  'Not Started':   'pending',
  'In Progress':   'pending',
  'Awaiting User': 'pending',
  'Resubmitted':   'pending',
  'Expired':       'unverified',
  'Abandoned':     'unverified',
  'Kyc Expired':   'unverified',
};

// Status strings are case-sensitive and contain spaces. An unknown one must not
// silently become 'approved', so anything unrecognised is treated as pending
// and logged — a new status from Didit is a thing to look at, not to guess at.
function mapStatus(diditStatus) {
  const mapped = STATUS_MAP[diditStatus];
  if (!mapped) {
    console.warn(`[didit] unrecognised status "${diditStatus}" — holding as pending`);
    return 'pending';
  }
  return mapped;
}

/**
 * Starts a verification and returns { sessionId, url }.
 *
 * `vendor_data` carries our user id. It is how the webhook knows which account
 * a decision belongs to — without it a result matches no player.
 */
async function createSession(userId, { callbackUrl } = {}) {
  if (!isConfigured()) {
    const err = new Error('Identity verification is not configured yet.');
    err.notConfigured = true;
    throw err;
  }

  const res = await fetch(`${API_BASE}/v2/session/`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow_id: WORKFLOW_ID,
      vendor_data: userId,
      ...(callbackUrl ? { callback: callbackUrl } : {}),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.detail || body?.message || `Didit session failed (${res.status})`);
  }

  const sessionId = body.session_id || body.id;
  const url       = body.url || body.session_url || body.verification_url;
  if (!sessionId || !url) {
    throw new Error('Didit did not return a session id and url');
  }
  return { sessionId, url };
}

/**
 * Verifies a webhook came from Didit and is not a replay.
 *
 * X-Signature-V2 is HMAC-SHA256 over the canonical (key-sorted) JSON, which is
 * the variant that survives any middleware that re-encodes the body. Compared
 * in constant time, because a byte-by-byte comparison leaks how much of a
 * forged signature was correct.
 */
const MAX_SKEW_SEC = 300;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = sortKeys(value[k]);
      return acc;
    }, {});
  }
  return value;
}

function verifyWebhook(rawBody, headers) {
  if (!WEBHOOK_SECRET) return { ok: false, reason: 'no webhook secret configured' };

  const timestamp = String(headers['x-timestamp'] || '');
  const signature = String(headers['x-signature-v2'] || headers['x-signature'] || '');
  if (!timestamp || !signature) return { ok: false, reason: 'missing signature headers' };

  const skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SEC) {
    return { ok: false, reason: `timestamp is ${skew}s out — outside the ${MAX_SKEW_SEC}s replay window` };
  }

  let parsed;
  try { parsed = JSON.parse(rawBody.toString('utf8')); }
  catch { return { ok: false, reason: 'body is not JSON' }; }

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(sortKeys(parsed)), 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true, payload: parsed };
}

module.exports = {
  isConfigured,
  createSession,
  verifyWebhook,
  mapStatus,
  STATUS_MAP,
  ENVIRONMENT,
  sortKeys,
};
