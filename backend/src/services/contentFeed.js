/**
 * The public content feed: real Duely numbers, pseudonymous players.
 *
 * Everything that decides WHAT is counted is a pure function over rows, so the
 * rules can be tested without a database. The route (routes/contentFeed.js)
 * only fetches rows and calls buildFeed().
 *
 * Nothing in here returns a row it was given. Every object that leaves is built
 * field by field from an allowlist, and assertPublicSafe() then scans the whole
 * response for anything shaped like an id, an email, a wallet or a token — a
 * hit refuses the response rather than sending it.
 */
const crypto = require('crypto');
const F = require('./tournamentFormat');
const { rankEloBoard } = require('./eloBoard');

// "Today" is the UTC calendar day. The feed is read by a machine once a day;
// a fixed zone is the only definition that means the same thing to both sides.
function utcDayStart(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Settlement writes each result once, but a retried insert or a double
// settlement would write it twice within a few seconds. Identical rows that
// close together are one result.
const DUPLICATE_WINDOW_MS = 10_000;

const RECENT_WINNERS = 5;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LEADERBOARD_SIZE = 5;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ts = (v) => Date.parse(v);

// ── Who may appear ─────────────────────────────────────────────────────────

/**
 * excluded: ids never counted anywhere (demo, admin, test accounts).
 * hidden:   ids counted in totals but never featured by name (private or
 *           banned profiles, and anyone whose profile cannot be found — a
 *           deleted account).
 */
function audience({ demoIds = [], adminId = null, testIds = [], profiles = [] }) {
  const excluded = new Set([...demoIds, ...testIds, adminId].filter(Boolean));
  const featurable = new Set();
  for (const p of profiles) {
    if (!p || excluded.has(p.id)) continue;
    if (p.is_private === true || p.banned === true) continue;
    featurable.add(p.id);
  }
  return { excluded, featurable };
}

// ── Game names ─────────────────────────────────────────────────────────────

const GAME_TYPES = {
  blockBlast: 'Block Burst', scrabble: 'Word VS', coin_flip: 'Coin Flip',
  blackjack: 'Blackjack', carDash: 'Rush Hour', colorRush: 'Color Rush', tower: 'Tower',
};
const TOURNAMENT_GAME_NAMES = {
  'block-blast': 'Block Burst', 'car-dash': 'Rush Hour', 'color-rush': 'Color Rush',
  tower: 'Tower', scrabble: 'Word VS',
};
const PUBLIC_GAME_NAMES = [...new Set(Object.values(GAME_TYPES))];

/**
 * The game a winning transaction was for, from its note.
 *
 * The note is "<Game> vs <opponent username>" and must never be sent; only a
 * known game name that it STARTS with is taken from it. Anything else is not
 * guessed at.
 */
function gameFromNote(notes) {
  if (typeof notes !== 'string') return null;
  if (notes.startsWith('Tournament')) return 'Tournament';
  for (const name of PUBLIC_GAME_NAMES) {
    if (notes === name || notes.startsWith(`${name} vs `)) return name;
  }
  return null;
}

// ── Counting ───────────────────────────────────────────────────────────────

/** Drop rows identical under key() that fall within the duplicate window. */
function dedupe(rows, key, time) {
  const last = new Map();
  const out = [];
  for (const r of [...rows].sort((a, b) => time(a) - time(b))) {
    const k = key(r);
    const prev = last.get(k);
    last.set(k, time(r));
    if (prev !== undefined && time(r) - prev <= DUPLICATE_WINDOW_MS) continue;
    out.push(r);
  }
  return out;
}

/**
 * Coin winnings actually credited: confirmed match_win rows with a coin amount.
 * Covers PvP wins, wins against a bot and tournament prizes. Diamond wins carry
 * amount_c 0 and are not money, so they are not here.
 */
function coinWins(transactions, { excluded }) {
  const valid = (transactions || []).filter(t =>
    t && t.type === 'match_win' && t.status === 'confirmed'
    && t.user_id && !excluded.has(t.user_id)
    && Number(t.amount_c) > 0 && Number.isFinite(ts(t.created_at)));
  return dedupe(valid,
    (t) => [t.user_id, round2(t.amount_c), t.notes ?? ''].join('#'),
    (t) => ts(t.created_at));
}

// ── Pseudonyms ─────────────────────────────────────────────────────────────

const ADJECTIVES = [
  'Blue', 'Neon', 'Shadow', 'Pixel', 'Rapid', 'Silver', 'Golden', 'Crimson',
  'Swift', 'Cosmic', 'Electric', 'Frozen', 'Lucky', 'Midnight', 'Solar', 'Turbo',
  'Iron', 'Velvet', 'Hyper', 'Quiet', 'Stormy', 'Arctic', 'Blazing', 'Clever',
  'Daring', 'Emerald', 'Fierce', 'Gentle', 'Hidden', 'Jade', 'Mighty', 'Noble',
  'Orbit', 'Prism', 'Rogue', 'Scarlet', 'Sonic', 'Stellar', 'Thunder', 'Ultra',
  'Vivid', 'Wild', 'Zen', 'Amber', 'Bold', 'Copper', 'Dusk', 'Echo',
];
const ANIMALS = [
  'Falcon', 'Tiger', 'Ace', 'Wolf', 'Fox', 'Hawk', 'Panther', 'Otter',
  'Raven', 'Lynx', 'Cobra', 'Bison', 'Eagle', 'Shark', 'Viper', 'Badger',
  'Comet', 'Dragon', 'Phoenix', 'Jaguar', 'Koala', 'Mantis', 'Orca', 'Puma',
  'Rhino', 'Stag', 'Toucan', 'Walrus', 'Yak', 'Zebra', 'Gecko', 'Heron',
  'Ibis', 'Jackal', 'Kestrel', 'Lemur', 'Moose', 'Narwhal', 'Owl', 'Pelican',
  'Quokka', 'Rook', 'Sparrow', 'Tortoise', 'Wombat', 'Coyote', 'Dingo', 'Ferret',
];
const MAX_ATTEMPTS = 64;

const hmac = (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest();

/** The stored key for a user: an HMAC, so the table holds no user id. */
function pseudonymDigest(secret, userId) {
  return hmac(secret, `duely-feed-user:${userId}`).toString('hex');
}

/** The attempt-th candidate name for a digest (0 first; later ones on collision). */
function candidateName(secret, digest, attempt) {
  const h = hmac(secret, `duely-feed-name:${digest}:${attempt}`);
  const name = ADJECTIVES[h.readUInt16BE(0) % ADJECTIVES.length] + ANIMALS[h.readUInt16BE(2) % ANIMALS.length];
  // The first attempt is the bare name. Later ones add a number, so the space
  // grows instead of cycling through the same 2,304 pairs.
  return attempt === 0 ? name : `${name}${10 + (h.readUInt16BE(4) % 90)}`;
}

/**
 * Resolve names for a set of user ids.
 *
 * store (optional) persists digest → name with name UNIQUE, which makes a name
 * permanent and impossible to hand to two people:
 *   store.load(digests)          → Map(digest → name)
 *   store.claim(digest, name)    → 'ok' | 'taken' (name belongs to another
 *                                   digest) | 'exists' (digest already named)
 *
 * Without a store (table not migrated) the same deterministic candidates are
 * used and collisions are resolved within the response, which is stable for
 * any user whose first candidate is not shared.
 */
async function resolvePseudonyms(userIds, { secret, store = null, log = console, avoid = new Set() }) {
  if (!secret || secret.length < 32) throw new Error('pseudonym secret missing');
  const ids = [...new Set(userIds.filter(Boolean))];
  const digests = new Map(ids.map(id => [id, pseudonymDigest(secret, id)]));
  const out = new Map();
  const used = new Set();

  let known = new Map();
  if (store) {
    try { known = await store.load([...digests.values()]); }
    catch { log.warn?.('[content-feed] pseudonym store unavailable; using unstored names'); store = null; }
  }
  for (const [id, d] of digests) {
    if (known.has(d)) { out.set(id, known.get(d)); used.add(known.get(d)); }
  }

  // New names are handed out in digest order, so which of two colliding users
  // keeps the bare name does not depend on the order they appeared in.
  const pending = ids.filter(id => !out.has(id)).sort((a, b) => (digests.get(a) < digests.get(b) ? -1 : 1));
  for (const id of pending) {
    const d = digests.get(id);
    let name = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !name; attempt++) {
      const c = candidateName(secret, d, attempt);
      // Never a name some real account is actually called.
      if (used.has(c) || avoid.has(c)) continue;
      if (!store) { name = c; break; }
      let r;
      try { r = await store.claim(d, c); } catch { r = 'error'; }
      if (r === 'ok') name = c;
      else if (r === 'exists') {
        const again = await store.load([d]).catch(() => new Map());
        if (again.has(d)) name = again.get(d);
      } else if (r === 'error') { name = c; }
    }
    if (!name) throw new Error('pseudonym space exhausted');
    out.set(id, name);
    used.add(name);
  }
  return out;
}

// ── Next tournament ────────────────────────────────────────────────────────

/**
 * The next scheduled public tournament.
 *
 * Tournaments run every twenty minutes at three stakes. A slot's brackets are
 * real (not demo, not a free Play-vs-Bot bracket). The busiest bracket filling
 * for the joinable slot is reported; if nobody has entered yet, the smallest
 * stake. Bots are not counted as entrants. Which game a round plays is not
 * revealed before that round starts, on the site or here.
 */
function nextTournament(poolList, now) {
  const slot = F.joinableSlot(now);
  const real = (poolList || []).filter(p =>
    p && p.state === 'filling' && p.slotStart === slot.startsAt
    && !p.demo && !p.free && F.ENTRY_FEES.includes(p.entryFee));
  const withCount = real.map(p => ({ p, entrants: (p.players || []).filter(x => x && !x.isBot).length }))
    .filter(x => x.entrants > 0 && x.entrants <= F.POOL_SIZE)
    .sort((a, b) => b.entrants - a.entrants || a.p.entryFee - b.p.entryFee);
  const fee = withCount[0]?.p.entryFee ?? F.ENTRY_FEES[0];
  const entrants = withCount[0]?.entrants ?? 0;
  const { net } = F.prizesFor(fee);
  return {
    game: null,
    possible_games: F.TOURNAMENT_GAMES.map(g => TOURNAMENT_GAME_NAMES[g]).filter(Boolean),
    start_time: new Date(slot.closesAt).toISOString(),
    entry_fee: fee,
    entrants,
    spots_left: F.POOL_SIZE - entrants,
    prize: round2(net),
  };
}

// ── Periods ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every window is UTC and half-open, [start, end): an event exactly on a
 * boundary belongs to the later period only, so nothing is counted twice.
 *
 *   today           00:00 UTC today -> now
 *   current week    Monday 00:00 UTC -> now            (period_end = next Monday)
 *   previous week   the seven days before that Monday
 *   current month   the 1st 00:00 UTC -> now           (period_end = next 1st)
 *   previous month  the whole calendar month before
 *
 * Comparisons are like-for-like: this period so far against the SAME elapsed
 * span from the start of the previous period (capped at its end), so a
 * Tuesday is not compared against a whole previous week.
 */
function periods(now) {
  const d = new Date(now);
  const dayStart = utcDayStart(now);
  const weekStart = dayStart - ((d.getUTCDay() + 6) % 7) * DAY_MS;
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const prevMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const prevWeekStart = weekStart - 7 * DAY_MS;
  return {
    today: { start: dayStart, end: now },
    week: { start: weekStart, end: now, periodEnd: weekStart + 7 * DAY_MS },
    prevWeekSoFar: { start: prevWeekStart, end: Math.min(prevWeekStart + (now - weekStart), weekStart) },
    month: { start: monthStart, end: now, periodEnd: monthEnd },
    prevMonthSoFar: { start: prevMonthStart, end: Math.min(prevMonthStart + (now - monthStart), monthStart) },
    earliest: Math.min(prevMonthStart, prevWeekStart),
  };
}

const inRange = (t, r) => t >= r.start && t < r.end;

/**
 * Completed player-vs-player results, deduplicated over the whole dataset
 * before any period filter.
 *
 * The matches table only receives a row when a result is decided, so an
 * abandoned or cancelled (refunded) match has no row. Left out: bot matches
 * (one side null), tournament entry rows (game_type 'tournament'), anything
 * involving a demo, admin or test account, and a non-completed status.
 */
function validDuels(matches, { excluded }) {
  const valid = (matches || []).filter(m =>
    m && m.player1_id && m.player2_id && m.player1_id !== m.player2_id
    && GAME_TYPES[m.game_type]
    && !excluded.has(m.player1_id) && !excluded.has(m.player2_id)
    && (m.status === undefined || m.status === null || m.status === 'completed')
    && Number.isFinite(ts(m.played_at)));
  return dedupe(valid,
    (m) => [[m.player1_id, m.player2_id].sort().join('|'), m.game_type,
            Number(m.entry_fee_c) || 0, Number(m.entry_fee_diamonds) || 0].join('#'),
    (m) => ts(m.played_at));
}

function countDuels(matches, { excluded, dayStart }) {
  return validDuels(matches, { excluded }).filter(m => ts(m.played_at) >= dayStart).length;
}

const MONEY_TYPES = new Set(['match_win', 'match_loss', 'match_draw', 'tournament_entry', 'tournament_refund']);

/** Confirmed coin movements that make up a player's results, deduplicated. */
function coinMoves(transactions, { excluded }) {
  const valid = (transactions || []).filter(t =>
    t && MONEY_TYPES.has(t.type) && t.status === 'confirmed'
    && t.user_id && !excluded.has(t.user_id)
    && Number(t.amount_c) > 0 && Number.isFinite(ts(t.created_at)));
  return dedupe(valid,
    (t) => [t.type, t.user_id, round2(t.amount_c), t.notes ?? ''].join('#'),
    (t) => ts(t.created_at));
}

/**
 * A player's net coin result from one movement.
 *   win   payout - stake (a tournament prize counts in full: its entry fee is
 *         the tournament_entry row)
 *   draw  refund - stake
 *   loss  -stake (the per-entrant "Tournament entry" loss row is skipped; the
 *         tournament_entry row already took it)
 */
function netOf(t) {
  const amt = Number(t.amount_c) || 0;
  const stake = Number(t.stake_c) || 0;
  switch (t.type) {
    case 'match_win': return typeof t.notes === 'string' && t.notes.startsWith('Tournament') ? amt : amt - stake;
    case 'match_draw': return amt - stake;
    case 'match_loss': return t.notes === 'Tournament entry' ? 0 : -amt;
    case 'tournament_entry': return -amt;
    case 'tournament_refund': return amt;
    default: return 0;
  }
}

const TOP_WINNERS = 5;
const COMPARED = ['duels', 'paid_out', 'new_players', 'active_players', 'total_wagered'];

function periodStats({ duels, moves, newProfiles, featurable }, range) {
  const d = (duels || []).filter(m => inRange(ts(m.played_at), range));
  const active = new Set();
  const games = new Map();
  let wagered = 0;
  for (const m of d) {
    active.add(m.player1_id); active.add(m.player2_id);
    const g = GAME_TYPES[m.game_type];
    games.set(g, (games.get(g) || 0) + 1);
    wagered += 2 * (Number(m.entry_fee_c) || 0);
  }
  const mv = moves ? moves.filter(t => inRange(ts(t.created_at), range)) : null;
  const wins = mv ? mv.filter(t => t.type === 'match_win') : null;
  const net = new Map();
  for (const t of mv || []) net.set(t.user_id, (net.get(t.user_id) || 0) + netOf(t));
  const biggest = wins && wins.filter(t => featurable.has(t.user_id) && gameFromNote(t.notes))
    .sort((a, b) => Number(b.amount_c) - Number(a.amount_c) || ts(a.created_at) - ts(b.created_at))[0];
  return {
    duels: duels ? d.length : null,
    active_players: duels ? active.size : null,
    total_wagered: duels ? round2(wagered) : null,
    paid_out: wins ? round2(wins.reduce((s, t) => s + Number(t.amount_c), 0)) : null,
    new_players: newProfiles ? newProfiles.filter(p => inRange(ts(p.created_at), range)).length : null,
    _biggest: biggest || null,
    _topWinners: mv ? [...net].filter(([id, n]) => featurable.has(id) && round2(n) > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, TOP_WINNERS) : null,
    _topGames: duels ? [...games].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([game, n]) => ({ game, duels: n })) : null,
  };
}

/** Percent change, one decimal. Null when the earlier period had nothing. */
function percentChange(cur, prev) {
  if (cur === null || prev === null || !(prev > 0)) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

// ── The feed ───────────────────────────────────────────────────────────────

/**
 * rows: { matches, transactions, newProfiles, boardProfiles, featureProfiles, pools }
 * Any rows value may be null when its source failed; its figures are then null.
 */
async function buildFeed(rows, { now = Date.now(), demoIds = [], adminId = null, testIds = [], secret, store, log = console }) {
  const P = periods(now);
  const { excluded, featurable } = audience({ demoIds, adminId, testIds, profiles: rows.featureProfiles || [] });

  const duels = rows.matches ? validDuels(rows.matches, { excluded }) : null;
  const moves = rows.transactions ? coinMoves(rows.transactions, { excluded }) : null;
  const newProfiles = rows.newProfiles
    ? rows.newProfiles.filter(p => p && p.id && !excluded.has(p.id) && Number.isFinite(ts(p.created_at)))
    : null;
  const data = { duels, moves, newProfiles, featurable };

  const today = periodStats(data, P.today);
  const week = periodStats(data, P.week);
  const month = periodStats(data, P.month);
  const prevWeek = periodStats(data, P.prevWeekSoFar);
  const prevMonth = periodStats(data, P.prevMonthSoFar);

  const featured = (moves || []).filter(t => t.type === 'match_win' && featurable.has(t.user_id) && gameFromNote(t.notes));
  const recentRows = featured.filter(t => now - ts(t.created_at) <= RECENT_WINDOW_MS)
    .sort((a, b) => ts(b.created_at) - ts(a.created_at)).slice(0, RECENT_WINNERS);

  let boardRows = null;
  if (rows.boardProfiles) {
    boardRows = rankEloBoard(rows.boardProfiles.filter(p =>
      p && !excluded.has(p.id) && p.is_private !== true && p.banned !== true), { demoIds })
      .slice(0, LEADERBOARD_SIZE);
  }

  // One resolution for everybody, so a player has one name in every section.
  const forbidden = collectForbidden(rows);
  const names = await resolvePseudonyms([
    today._biggest?.user_id, week._biggest?.user_id, month._biggest?.user_id,
    ...recentRows.map(t => t.user_id),
    ...(week._topWinners || []).map(([id]) => id), ...(month._topWinners || []).map(([id]) => id),
    ...(boardRows || []).map(p => p.id),
  ], { secret, store, log, avoid: forbidden });

  const iso = (ms) => new Date(ms).toISOString();
  const win = (t) => t ? { display_name: names.get(t.user_id), game: gameFromNote(t.notes), amount: round2(t.amount_c) } : null;
  const section = (s, range) => ({
    period_start: iso(range.start),
    period_end: iso(range.periodEnd),
    duels: s.duels, paid_out: s.paid_out, new_players: s.new_players,
    active_players: s.active_players, total_wagered: s.total_wagered,
    biggest_win: win(s._biggest),
    top_winners: s._topWinners && s._topWinners.map(([id, n]) => ({ display_name: names.get(id), amount_won: round2(n) })),
    top_games: s._topGames,
  });
  const compare = (cur, prev, range) => ({
    compared_period_start: iso(range.start),
    compared_period_end: iso(range.end),
    ...Object.fromEntries(COMPARED.map(k => [`${k}_percent_change`, percentChange(cur[k], prev[k])])),
  });

  const generated = iso(now);
  // Duely has no player quote or testimonial field, so quote is always null.
  const feed = {
    generated_at: generated,
    updated_at: generated,
    totals: { duels_today: today.duels, paid_out_today: today.paid_out, new_players_today: today.new_players },
    weekly: section(week, P.week),
    monthly: section(month, P.month),
    comparisons: {
      weekly_vs_previous_week: compare(week, prevWeek, P.prevWeekSoFar),
      monthly_vs_previous_month: compare(month, prevMonth, P.prevMonthSoFar),
    },
    biggest_win: today._biggest ? { ...win(today._biggest), quote: null } : null,
    recent_winners: moves ? recentRows.map(t => ({ ...win(t), won_at: iso(ts(t.created_at)), quote: null })) : null,
    leaderboard: boardRows && boardRows.map(p => ({ rank: p.rank, display_name: names.get(p.id), elo: Number(p.elo) })),
    next_tournament: rows.pools ? nextTournament(rows.pools, now) : null,
  };
  assertPublicSafe(feed, { forbidden });
  return feed;
}

// ── The last check ─────────────────────────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const EVM = /0x[0-9a-f]{20,}/i;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
const LONG_TOKEN = /[A-Za-z0-9+/_-]{32,}/;

/** Every username, id and address present in the source rows. */
function collectForbidden(rows) {
  const out = new Set();
  for (const list of Object.values(rows || {})) {
    for (const r of list || []) {
      if (!r || typeof r !== 'object') continue;
      for (const k of ['id', 'user_id', 'player1_id', 'player2_id', 'winner_id', 'username', 'email', 'wallet_address']) {
        if (typeof r[k] === 'string' && r[k].length >= 3) out.add(r[k]);
      }
      for (const x of r.players || []) {
        if (x?.userId) out.add(x.userId);
        if (x?.username && x.username.length >= 3) out.add(x.username);
      }
    }
  }
  return out;
}

/** Throws if anything identifying is in the response. */
function assertPublicSafe(feed, { forbidden = new Set() } = {}) {
  const walk = (v, path) => {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      if (UUID.test(v) || EMAIL.test(v) || EVM.test(v) || JWT.test(v) || LONG_TOKEN.test(v)) {
        throw new Error(`unsafe value at ${path}`);
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/^(id|user_?id|email|wallet|username|token|ip)/i.test(k)) throw new Error(`unsafe key at ${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(feed, 'feed');
  // A real username that happens to look harmless is caught here. Whole-word
  // match, so a username like "Tiger" does not block the pseudonym "NeonTiger".
  const text = JSON.stringify(feed);
  const values = new Set();
  JSON.parse(text, (_k, v) => { if (typeof v === 'string') values.add(v); return v; });
  for (const f of forbidden) if (values.has(f)) throw new Error('unsafe value: source identifier present');
}

module.exports = {
  buildFeed, countDuels, coinWins, validDuels, coinMoves, netOf, periods, periodStats, percentChange, audience, gameFromNote, nextTournament,
  resolvePseudonyms, pseudonymDigest, candidateName, assertPublicSafe, collectForbidden,
  utcDayStart, DUPLICATE_WINDOW_MS, RECENT_WINDOW_MS,
};
