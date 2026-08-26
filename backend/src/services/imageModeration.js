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
 */
function flattenScores(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out[path] = v;
    else if (v && typeof v === 'object') flattenScores(v, path, out);
  }
  return out;
}

// The paths that actually mean "this image breaks the rules".
//
// This is an ALLOW-LIST of violations, and the earlier version was not — it
// walked every number in the response and treated anything above the
// threshold as a violation, with only 'none'/'safe' excluded. That rejected
// a cartoon monkey avatar, because Sightengine returns descriptive metadata
// alongside its actual scores:
//
//   gore.type.animated        0.97  "this is a drawing"      NOT a violation
//   nudity.context.indoor_other 0.9  "looks like indoors"    NOT a violation
//   nudity.suggestive_classes.*      which garment is visible
//   weapon.classes.firearm_toy       a toy, explicitly not a real weapon
//
// The original reasoning was that walking everything cannot MISS a
// violation. True, but it also cannot tell a violation from a description,
// and on a real response the descriptive fields are the ones most likely to
// be near 1.0 — so the check rejected almost everything. Being deliberate
// about which paths are violations is the only version that works.
//
// New model classes therefore need adding here. That is the trade: a missed
// new class is caught by the report button and a human, whereas the previous
// behaviour made the whole feature unusable.
const VIOLATION_PATHS = [
  // nudity-2.1 — the graded classes, most severe first.
  'nudity.sexual_activity',
  'nudity.sexual_display',
  'nudity.erotica',
  'nudity.very_suggestive',
  // gore-2.0 — prob is the overall score; the classes are the specifics.
  // gore.type.{animated,fake,real} is deliberately absent: it describes the
  // STYLE of the image, not whether there is gore in it.
  'gore.prob',
  'gore.classes.very_bloody',
  'gore.classes.body_organ',
  'gore.classes.serious_injury',
  // offensive-2.0 — hate symbols and gestures.
  'offensive.prob',
  'offensive.nazi',
  'offensive.supremacist',
  'offensive.terrorist',
  'offensive.middle_finger',
  // weapon — real weapons only. firearm_toy and firearm_gesture are
  // explicitly NOT weapons and must not reject a photo.
  'weapon.classes.firearm',
  'weapon.classes.knife',
];

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

  // Only the paths that genuinely mean a violation. Everything else in the
  // response is descriptive — see VIOLATION_PATHS.
  let worst = null;
  for (const path of VIOLATION_PATHS) {
    const score = scores[path];
    if (typeof score !== 'number') continue;   // model not requested, or renamed
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

module.exports = { checkImage, isConfigured, flattenScores, REJECT_AT, MODELS, VIOLATION_PATHS };
