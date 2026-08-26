/**
 * Sightengine image moderation, for profile pictures.
 *
 * Avatars are the first user-generated content on the platform, so this is
 * the first thing standing between an upload and every other player seeing
 * it. It runs BEFORE the image is stored, not after — an image that reaches
 * storage has already been served to somebody by the time a background job
 * gets to it.
 *
 * ── What this catches, and what it does not ──
 *
 * Automated moderation is reliable on explicit nudity and gore. It is much
 * weaker on things that are also problems here: a photo of a real person used
 * to impersonate them, a hate symbol it has not seen, a screenshot of
 * something offensive. Those need the report button and a human. This is the
 * floor, not the ceiling — see the report routes in routes/reports.js.
 */

const API_URL = 'https://api.sightengine.com/1.0/check.json';

const API_USER   = process.env.SIGHTENGINE_API_USER   || '';
const API_SECRET = process.env.SIGHTENGINE_API_SECRET || '';

const isConfigured = () => Boolean(API_USER && API_SECRET);

// The models worth paying attention to for an avatar. Ordered by how likely
// each is to matter in practice, which is also roughly how confident the
// model is at each.
const MODELS = 'nudity-2.1,gore-2.0,offensive-2.0,weapon';

// A class is refused at or above this confidence.
//
// 0.5 rather than something stricter: these scores are probabilities, and the
// cost of the two mistakes is not symmetric. A false reject is a player
// picking a different picture; a false accept is explicit content on a
// profile every other player can see. But set too low, ordinary photos of
// people start failing, which makes the feature feel broken and is its own
// kind of failure. 0.5 is the point Sightengine's own guidance treats as a
// genuine positive rather than a hint.
const REJECT_AT = 0.5;

/**
 * Pulls every leaf number out of a nested object, keyed by dotted path.
 *
 * Written this way ON PURPOSE rather than reading known field names.
 * Sightengine's response shape differs per model and per model VERSION
 * (nudity-2.1 nests differently from nudity-2.0), and a hardcoded path that
 * silently misses would mean an unchecked image passing as clean — a
 * moderation check that fails open is worse than none, because it is
 * trusted. Walking everything means a renamed or newly added class is still
 * seen.
 */
function flattenScores(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out[path] = v;
    else if (v && typeof v === 'object') flattenScores(v, path, out);
  }
  return out;
}

// Leaves that are NOT violations, so a high score on them means the image is
// fine. 'none' is the big one: nudity.none = 0.99 means "definitely not
// nudity", and treating it as a violation score would reject every clean
// photo — the exact inversion this list exists to prevent.
//
// 'prob' is deliberately NOT here, though it looks like it belongs. For the
// gore and offensive models the response is { gore: { prob: 0.97 } } and that
// number IS the violation score — listing it as safe let gore through
// entirely. Caught by running a realistic response through this before
// wiring anything to it.
const SAFE_LEAF = /(^|\.)(none|safe)$/i;

/**
 * @returns {{ ok: boolean, reason?: string, worst?: {path,score}, scores?: object }}
 */
async function checkImage(buffer, filename = 'avatar.jpg') {
  if (!isConfigured()) {
    // Fails CLOSED. An unconfigured moderation service must not mean
    // "everything is allowed" — that is how a feature ships to production
    // with its safety check quietly doing nothing.
    const err = new Error('Image moderation is not configured.');
    err.notConfigured = true;
    throw err;
  }

  const form = new FormData();
  form.append('media', new Blob([buffer]), filename);
  form.append('models', MODELS);
  form.append('api_user', API_USER);
  form.append('api_secret', API_SECRET);

  const res = await fetch(API_URL, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));

  if (!res.ok || body.status === 'failure') {
    throw new Error(body.error?.message || body.error || `moderation failed (${res.status})`);
  }

  // Only the model results, never the envelope — request_id, operations and
  // media.uri are not scores and must not be treated as any.
  const { status, request, media, ...models } = body;
  const scores = flattenScores(models);

  let worst = null;
  for (const [path, score] of Object.entries(scores)) {
    if (SAFE_LEAF.test(path)) continue;
    if (score >= REJECT_AT && (!worst || score > worst.score)) worst = { path, score };
  }

  if (worst) {
    return {
      ok: false,
      reason: 'That image was rejected by our content check. Please choose another.',
      worst,
      scores,
    };
  }
  return { ok: true, scores };
}

module.exports = { checkImage, isConfigured, flattenScores, REJECT_AT, MODELS, SAFE_LEAF };
