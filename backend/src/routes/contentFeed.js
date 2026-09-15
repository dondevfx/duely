/**
 * GET /api/v1/content-feed — the read-only public content feed.
 *
 * One route, one method, one key. See docs/CONTENT_FEED_API.md.
 *
 * The key (CONTENT_FEED_API_KEY) is checked here and nowhere else. It is not a
 * Supabase credential and not a session: every other route authenticates with
 * a Supabase-signed JWT, which this key is not, so it opens nothing else. This
 * router answers GET on one path and refuses every other method before the key
 * is even looked at, and the handler only ever SELECTs named columns.
 */
const { Router } = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { buildFeed } = require('../services/contentFeed');
const { DEMO_IDS } = require('../services/demoAccounts');

const CACHE_MS = 10 * 60 * 1000;
const MIN_KEY_LENGTH = 32;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time: hashes first so length differences leak nothing either. */
function keyMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (expected.length < MIN_KEY_LENGTH) return false;
  return crypto.timingSafeEqual(sha(presented), sha(expected));
}

function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(h.trim());
  return m ? m[1] : null;
}

const listIds = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

/** Persisted pseudonyms (PENDING_SQL section 27). Stores only HMAC digests. */
function supabaseStore(supabase) {
  return {
    async load(digests) {
      if (!digests.length) return new Map();
      const { data, error } = await supabase.from('content_pseudonyms').select('digest, name').in('digest', digests);
      if (error) throw new Error('store');
      return new Map((data || []).map(r => [r.digest, r.name]));
    },
    async claim(digest, name) {
      const { error } = await supabase.from('content_pseudonyms').insert({ digest, name });
      if (!error) return 'ok';
      if (error.code !== '23505') throw new Error('store');
      return /digest|pkey/i.test(error.message || '') ? 'exists' : 'taken';
    },
  };
}

module.exports = function contentFeedRoutes(supabase, {
  pools = null,
  env = process.env,
  now = () => Date.now(),
  limiter = null,
  log = console,
} = {}) {
  const router = Router();

  // 30 an hour per address, counted BEFORE the key is checked, so guessing
  // keys is throttled as hard as reading.
  const limit = limiter || rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  let cache = null; // { at, body }

  const noStore = (res) => res.set('Cache-Control', 'private, no-store');

  router.all('/', limit, (req, res, next) => {
    noStore(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!keyMatches(bearer(req), env.CONTENT_FEED_API_KEY)) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }, async (_req, res) => {
    const secret = env.CONTENT_FEED_PSEUDONYM_SECRET;
    if (!secret || secret.length < MIN_KEY_LENGTH) {
      log.error?.('[content-feed] CONTENT_FEED_PSEUDONYM_SECRET is not set; refusing to serve names.');
      return res.status(503).json({ error: 'Feed unavailable' });
    }
    const t = now();
    if (cache && t - cache.at < CACHE_MS) return res.json(cache.body);

    try {
      const body = await buildFeed(await fetchRows(supabase, pools, t, log), {
        now: t,
        demoIds: DEMO_IDS,
        adminId: env.ADMIN_USER_ID || null,
        testIds: listIds(env.CONTENT_FEED_EXCLUDE_USER_IDS),
        secret,
        store: supabaseStore(supabase),
        log,
      });
      cache = { at: t, body };
      return res.json(body);
    } catch (e) {
      // No message, no stack, no ids: just that it failed.
      log.error?.('[content-feed] build failed:', e?.name || 'Error');
      return res.status(500).json({ error: 'Feed unavailable' });
    }
  });

  return router;
};

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The rows, each source independent: a failed one becomes null and its section
 * is null in the feed, rather than failing the whole response.
 *
 * Column lists are explicit. Nothing selects username, email, wallet or any
 * balance, so none of it is in memory to leak.
 */
async function fetchRows(supabase, pools, now, log) {
  const d = new Date(now);
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  const since = new Date(Math.min(Date.parse(dayStart), now - RECENT_MS)).toISOString();

  const safe = async (name, fn) => {
    try {
      const { data, error } = await fn();
      if (error) throw error;
      return data || [];
    } catch {
      log.warn?.(`[content-feed] ${name} unavailable`);
      return null;
    }
  };
  const pageAll = async (build) => {
    const out = [];
    for (let from = 0; from < 50_000; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) return { data: null, error };
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return { data: out, error: null };
  };

  const [matches, transactions, newProfiles, board] = await Promise.all([
    safe('matches', () => pageAll(() => supabase.from('matches')
      .select('player1_id, player2_id, winner_id, game_type, entry_fee_c, entry_fee_diamonds, played_at')
      .gte('played_at', dayStart).not('player2_id', 'is', null).order('played_at'))),
    safe('transactions', () => pageAll(() => supabase.from('transactions')
      .select('user_id, type, amount_c, status, notes, created_at')
      .eq('type', 'match_win').eq('status', 'confirmed').gt('amount_c', 0)
      .gte('created_at', since).order('created_at'))),
    safe('profiles (new)', () => pageAll(() => supabase.from('profiles')
      .select('id, created_at').gte('created_at', dayStart).order('created_at'))),
    safe('profiles (board)', async () => {
      // Same query as GET /api/leaderboard, without the display columns.
      const run = (cols) => supabase.from('profiles').select(cols)
        .order('elo', { ascending: false }).limit(500)
        .neq('id', process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000')
        .neq('is_private', true);
      let r = await run('id, elo, wins, losses, is_private, banned');
      if (r.error && /banned/.test(r.error.message || '')) r = await run('id, elo, wins, losses, is_private');
      return r;
    }),
  ]);

  // Privacy flags for every winner who could be featured.
  let featureProfiles = null;
  if (transactions) {
    const ids = [...new Set(transactions.map(t => t.user_id).filter(Boolean))];
    featureProfiles = ids.length ? await safe('profiles (winners)', async () => {
      const run = (cols) => supabase.from('profiles').select(cols).in('id', ids);
      let r = await run('id, is_private, banned');
      if (r.error && /banned/.test(r.error.message || '')) r = await run('id, is_private');
      return r;
    }) : [];
  }

  let poolList = null;
  try { poolList = pools ? [...pools.pools.values()] : []; } catch { poolList = null; }

  return {
    matches, transactions, newProfiles, boardProfiles: board,
    // A failed lookup features nobody, rather than everybody.
    featureProfiles: featureProfiles || [],
    pools: poolList,
  };
}

module.exports.keyMatches = keyMatches;
module.exports.fetchRows = fetchRows;
