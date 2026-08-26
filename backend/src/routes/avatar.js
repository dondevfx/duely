const express = require('express');
const { requireAuth } = require('../middleware/auth');
const moderation = require('../services/imageModeration');

/**
 * Profile pictures.
 *
 * Ordering here is the whole point: moderate, THEN store. An image that
 * reaches storage has a public URL, and a public URL has already been served
 * to somebody by the time any after-the-fact job looks at it.
 *
 * Uploaded as base64 JSON rather than multipart. An avatar is capped at a few
 * hundred KB, base64 costs ~33% on the wire, and the alternative is adding a
 * multipart dependency and a second body-parsing path to a server that
 * currently has exactly one. Not the right trade for large files; fine for
 * this one.
 */

const BUCKET = 'avatars';

// 3MB of decoded image. Generous for an avatar, small enough that a bad
// upload cannot tie up the request path, and well inside Sightengine's limit.
const MAX_BYTES = 3 * 1024 * 1024;

const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

// The first bytes of a file, which say what it actually IS. A client-supplied
// content type is a claim, not a fact — checking the magic number is what
// stops something that is not an image being handed to storage with an
// image/jpeg label on it.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

module.exports = function avatarRoutes(supabase) {
  const router = express.Router();

  router.post('/', requireAuth, async (req, res) => {
    const userId = req.user.id;

    // Revoked uploaders are stopped here, server-side. Hiding the button in
    // the UI is a courtesy; this is the actual rule.
    const { data: profile, error: pErr } = await supabase
      .from('profiles').select('avatar_banned, avatar_url').eq('id', userId).single();
    if (pErr) {
      if (/avatar_banned|avatar_url/.test(pErr.message || '')) {
        return res.status(503).json({ error: 'Profile pictures are not enabled yet.' });
      }
      return res.status(500).json({ error: pErr.message });
    }
    if (profile?.avatar_banned) {
      return res.status(403).json({
        error: 'Your profile picture privileges were removed by a moderator.',
      });
    }

    const raw = String(req.body?.image || '');
    const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    if (!b64) return res.status(400).json({ error: 'No image supplied.' });

    let buf;
    try { buf = Buffer.from(b64, 'base64'); }
    catch { return res.status(400).json({ error: 'That file could not be read.' }); }

    if (!buf.length) return res.status(400).json({ error: 'That file could not be read.' });
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: 'That image is too large. Maximum size is 3MB.' });
    }

    const mime = sniff(buf);
    if (!mime || !ALLOWED[mime]) {
      return res.status(400).json({ error: 'Please upload a JPEG, PNG or WebP image.' });
    }

    // ── Moderate BEFORE storing ──────────────────────────────────────────
    let verdict;
    try {
      verdict = await moderation.checkImage(buf, `avatar.${ALLOWED[mime]}`);
    } catch (e) {
      if (e.notConfigured) {
        // Fails closed. Accepting uploads with the content check switched off
        // is worse than not offering the feature.
        return res.status(503).json({ error: 'Profile pictures are temporarily unavailable.' });
      }
      console.error('[avatar] moderation error:', e.message);
      return res.status(502).json({ error: 'Could not check that image. Try again shortly.' });
    }

    if (!verdict.ok) {
      console.warn(`[avatar] rejected for ${userId}: ${verdict.worst?.path} @ ${verdict.worst?.score}`);
      return res.status(422).json({ error: verdict.reason });
    }

    // Path includes the user id so an admin can trace an image back to an
    // account from storage alone, and a timestamp so a replaced avatar gets a
    // new URL rather than being masked by a CDN cache of the old one.
    const key = `${userId}/${Date.now()}.${ALLOWED[mime]}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET).upload(key, buf, { contentType: mime, upsert: false });

    if (upErr) {
      console.error('[avatar] upload failed:', upErr.message);
      return res.status(500).json({ error: 'Could not save that image.' });
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(key);
    const url = pub?.publicUrl;
    if (!url) return res.status(500).json({ error: 'Could not save that image.' });

    const { error: setErr } = await supabase
      .from('profiles').update({ avatar_url: url }).eq('id', userId);

    if (setErr) {
      console.error('[avatar] stored but not linked:', setErr.message);
      return res.status(500).json({ error: 'Could not save that image.' });
    }

    // Best-effort tidy-up of the previous file. A failure here leaks one
    // orphaned object, which is not worth failing an otherwise good upload.
    if (profile?.avatar_url) {
      const oldKey = profile.avatar_url.split(`/${BUCKET}/`)[1];
      if (oldKey) supabase.storage.from(BUCKET).remove([oldKey]).then(() => {}, () => {});
    }

    res.json({ avatar_url: url });
  });

  // Clearing your own picture. Not a moderation action — that lives in the
  // admin routes and additionally revokes the right to upload again.
  router.delete('/', requireAuth, async (req, res) => {
    const { data: profile } = await supabase
      .from('profiles').select('avatar_url').eq('id', req.user.id).single();

    const { error } = await supabase
      .from('profiles').update({ avatar_url: null }).eq('id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });

    if (profile?.avatar_url) {
      const key = profile.avatar_url.split(`/${BUCKET}/`)[1];
      if (key) supabase.storage.from(BUCKET).remove([key]).then(() => {}, () => {});
    }
    res.json({ ok: true });
  });

  return router;
};

module.exports.sniff = sniff;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports.ALLOWED = ALLOWED;
module.exports.BUCKET = BUCKET;
