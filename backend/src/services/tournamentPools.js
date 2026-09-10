/**
 * Pools: who is in which tournament.
 *
 * A player picks a stake and clicks Play. This finds them a pool for the next
 * startable slot at that stake, or opens one, and holds them there until it
 * fills. When it fills — or when the join window closes with enough players —
 * the bracket is drawn and play begins.
 *
 * State lives in memory. A tournament is a twenty-minute object: it is created,
 * played and settled inside one slot, and a process restart mid-tournament is a
 * refund, not a resume. Persisting it would mean keeping a bracket, sixteen
 * socket identities and four rounds of in-flight game state consistent across a
 * restart, which is a great deal of machinery for a thing whose whole life is
 * shorter than a deploy takes.
 *
 * What that costs is stated rather than hidden: see `drainForShutdown`, which
 * is how the refund happens, and the note on it.
 *
 * The rules — schedule, prizes, rotation, bracket shape — are in
 * tournamentFormat.js and are pure. This is the part that holds state, so it is
 * kept as small as it can be and every function takes `now` rather than reading
 * a clock, so the whole lifecycle can be tested without waiting twenty minutes.
 */
const F = require('./tournamentFormat');

// How many tournaments one account may play per slot. Spent when a bracket
// starts, never when one is merely joined — see spendTickets.
const TICKETS_PER_SLOT = 2;

// The third-place playoff's match index. Negative so it can never be confused
// with a position in a round array — see pendingMatches.
const THIRD_PLACE = -1;

// A tournament starts when the bracket is full. That is the only thing that
// starts one.
//
// The slot and its window are about JOINING and nothing else: they say when a
// seat can be taken and when it can no longer be. A pool that has not filled
// by the time entry closes is not a smaller tournament — it is a tournament
// that did not happen, and everyone in it is refunded.
//
// It used to start short brackets at the close, padding them out with byes.
// That made the clock look like a start time, which it is not, and it meant a
// bracket of five paid three places out of five entries.

let _seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(_seq++).toString(36)}`;

/**
 * A deterministic 0..1 generator from a string seed.
 *
 * The game rotation has to be reproducible from something every server agrees
 * on — the pool's own id — so that two processes, or a reconnecting client,
 * are told the same game for the same round. Math.random would give each of
 * them a different tournament.
 */
function seededRng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createStore() {
  /** @type {Map<string, object>} */
  const pools = new Map();

  /**
   * Two entries per slot, and the ticket is spent when the bracket STARTS.
   *
   * Not when you join. A pool that never fills is refunded and nothing was
   * played, so charging a ticket for it would take away a go at a tournament
   * that did not happen — and the twenty-minute slot is short enough that
   * losing one to a bracket nobody else entered would be most of the window.
   *
   * Keyed by slot, so it resets with every tournament rather than by the hour
   * or by the day: two goes, this tournament, whoever you are.
   *
   * @type {Map<number, Map<string, number>>} slotStart → userId → spent
   */
  const spent = new Map();

  function spentIn(slotStart, userId) {
    return spent.get(slotStart)?.get(userId) ?? 0;
  }

  function ticketsLeft(slotStart, userId) {
    return Math.max(0, TICKETS_PER_SLOT - spentIn(slotStart, userId));
  }

  function spendTickets(pool) {
    let m = spent.get(pool.slotStart);
    if (!m) spent.set(pool.slotStart, m = new Map());
    for (const p of pool.players) {
      if (p.isBot) continue;
      m.set(p.userId, (m.get(p.userId) ?? 0) + 1);
    }
    // Slots older than an hour cannot be joined and cannot be refunded, so
    // their counts are only memory. Swept here because this is the one place
    // that runs every time a tournament begins.
    const cutoff = pool.slotStart - 60 * 60 * 1000;
    for (const key of spent.keys()) if (key < cutoff) spent.delete(key);
  }

  const openPoolsFor = (slotStart, entryFee) =>
    [...pools.values()].filter(p =>
      p.state === 'filling' && p.slotStart === slotStart && p.entryFee === entryFee);

  /** Is this player already entered in this slot, at any stake? */
  function entryIn(slotStart, userId) {
    for (const p of pools.values()) {
      if (p.slotStart !== slotStart) continue;
      if (p.players.some(x => x.userId === userId)) return p;
    }
    return null;
  }

  function createPool(slotStart, entryFee, now) {
    const id = nextId();
    const pool = {
      id,
      slotStart,
      entryFee,
      state: 'filling',
      players: [],
      createdAt: now,
      // Drawn once, from the id, so every client is told the same rotation.
      roundGames: F.pickRoundGames(F.ROUNDS, seededRng(id)),
      bracket: null,
      round: 0,
      startedAt: null,
    };
    pools.set(id, pool);
    return pool;
  }

  /**
   * Put a player in a pool, opening one if every pool at that stake is full.
   *
   * Returns { pool, already } — `already` when they were in one, so a second
   * click lands them back on the same bracket rather than entering twice or
   * being refused.
   */
  function join({ userId, username, avatarUrl, profileColor = null, entryFee, isBot = false, now }) {
    if (!F.ENTRY_FEES.includes(entryFee)) {
      throw new Error(`entry fee must be one of ${F.ENTRY_FEES.join(', ')}`);
    }
    const slot = F.joinableSlot(now);

    // One entry per player per slot, at any stake. Without this a player can
    // sit in three brackets at once and be asked to play three games in the
    // same three minutes — and two of those seats are ones a real entrant
    // could have had.
    const existing = entryIn(slot.startsAt, userId);
    if (existing) return { pool: existing, already: true };

    // At most one pool per stake per slot is ever filling, because a pool
    // starts the instant it reaches sixteen and stops being a candidate. So
    // there is nothing to choose between and no ordering to get right — which
    // is also what makes "as many pools as needed" work: the seventeenth
    // player opens the next one and everyone after joins that.
    const open = openPoolsFor(slot.startsAt, entryFee).filter(p => p.players.length < F.POOL_SIZE);
    const pool = open[0] || createPool(slot.startsAt, entryFee, now);

    seat(pool, { userId, username, avatarUrl, profileColor, isBot, now });
    return { pool, already: false };
  }

  /**
   * Put a player in THIS pool.
   *
   * join() chooses a pool; this one is told which. That distinction matters
   * for the bots that top up a demo bracket: join() hands back whichever pool
   * at that stake is currently taking entries, which is not necessarily the
   * one the demo account just opened — so filling with bots through join()
   * packed fifteen of them into whatever real bracket happened to be waiting,
   * started it early, and drew the people who were waiting against bots.
   */
  function seat(pool, { userId, username, avatarUrl = null, profileColor = null, isBot = false, now }) {
    if (pool.state !== 'filling') return pool;
    if (pool.players.length >= F.POOL_SIZE) return pool;
    if (pool.players.some(p => p.userId === userId)) return pool;
    pool.players.push({ userId, username, avatarUrl: avatarUrl || null, profileColor, isBot, joinedAt: now });
    if (pool.players.length >= F.POOL_SIZE) startPool(pool, now);
    return pool;
  }

  /**
   * Move a winner into their next slot.
   *
   * Shared by reported results AND by byes. Byes used to set a winner without
   * advancing them — the only code that advanced anyone was the result
   * handler — so with five players the three players drawn against nobody won
   * their first round and never appeared in the second. The bracket sat with
   * an empty round two and no match left to report, and the tournament stopped
   * dead with nothing to say what had gone wrong.
   */
  function advanceWinner(pool, roundIndex, matchIndex, winnerId) {
    const next = F.advanceTo(roundIndex, matchIndex);
    if (next.round < pool.bracket.length) {
      pool.bracket[next.round][next.match][next.side] = winnerId;
    } else if (pool.thirdPlace && !pool.thirdPlace.winner) {
      // The final is won, but the playoff beside it is still being played and
      // third place pays. The tournament is not over until both are done.
    } else {
      pool.state = 'complete';
    }
  }

  /** Draw the bracket and begin. */
  function startPool(pool, now) {
    if (pool.state !== 'filling') return pool;
    const n = pool.players.length;
    const size = nextPowerOfTwo(n);
    pool.bracket = F.emptyBracket(size);

    // Byes are SPREAD, one per match, not appended as padding.
    //
    // Padding the seat list to a power of two and pairing off adjacent seats
    // puts every bye at the end, so five players in an eight-bracket produce
    // three real seats, one bye — and one match with nobody in it at all. That
    // match can never be reported, so its round never completes and the
    // tournament stops dead on the first round.
    //
    // Giving the first `byes` matches a single player each guarantees every
    // match has at least one. It always fits: size is the next power of two
    // above n, so byes = size - n is always fewer than the size/2 matches.
    const ids = pool.players.map(p => p.userId);
    const matches = size / 2;
    const byes = size - n;
    let k = 0;
    for (let i = 0; i < matches; i++) {
      const slot = pool.bracket[0][i];
      if (i < byes) {
        slot.a = ids[k++] ?? null;
        slot.b = null;
        // Drawn against nobody: through without playing, and advanced now —
        // nothing will ever report this match.
        if (slot.a) { slot.winner = slot.a; advanceWinner(pool, 0, i, slot.a); }
      } else {
        slot.a = ids[k++] ?? null;
        slot.b = ids[k++] ?? null;
      }
    }

    pool.state = 'running';
    pool.round = 0;
    pool.startedAt = now;
    spendTickets(pool);
    return pool;
  }

  /**
   * Close entry on every pool whose window has passed.
   *
   * Closing entry is all this does. A pool that filled during the window has
   * already started — seat() starts it the moment the sixteenth seat is taken,
   * which is the only way a tournament ever begins. Anything still filling
   * when the window shuts never will, so it is refunded.
   *
   * Returns the refunds, because the caller has to pay them and nothing else
   * knows those pools existed.
   */
  function closeWindow(now) {
    const refunded = [];
    for (const pool of pools.values()) {
      if (pool.state !== 'filling') continue;
      if (now < pool.slotStart + F.JOIN_WINDOW_MS) continue;
      pool.state = 'refunded';
      refunded.push(pool);
    }
    return { refunded };
  }

  /**
   * Record a result and advance the winner.
   *
   * Idempotent on the match: a duplicate report of a match already decided is
   * ignored rather than advancing the same player twice, because two clients
   * reporting the same finish is the normal case, not the exceptional one.
   */
  function reportResult(poolId, roundIndex, matchIndex, winnerId, scores = null) {
    const pool = pools.get(poolId);
    if (!pool || pool.state !== 'running') return null;
    const match = matchAt(pool, roundIndex, matchIndex);
    if (!match) return null;
    if (match.winner) return { pool, match, already: true };
    if (winnerId !== match.a && winnerId !== match.b) return null;

    match.winner = winnerId;
    match.scores = scores;

    // Nobody advances out of the playoff — it decides third and nothing else.
    if (matchIndex !== THIRD_PLACE) advanceWinner(pool, roundIndex, matchIndex, winnerId);
    // The final may already be decided, in which case this was the last thing
    // the tournament was waiting for.
    else if (pool.bracket[pool.round]?.every(m => m.winner)) pool.state = 'complete';
    return { pool, match, already: false };
  }

  /**
   * Every match in the current round that still needs playing.
   *
   * The third-place playoff is one of them, at index -1. It is not in the
   * round array — every round is half the size of the one before it, and the
   * whole of advanceTo depends on that — so it is addressed by a match index
   * that cannot collide with a real one.
   */
  function pendingMatches(pool) {
    const round = pool.bracket?.[pool.round] || [];
    const out = round
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !m.winner && m.a && m.b);
    if (isFinalRound(pool) && pool.thirdPlace && !pool.thirdPlace.winner
        && pool.thirdPlace.a && pool.thirdPlace.b) {
      out.push({ m: pool.thirdPlace, i: THIRD_PLACE });
    }
    return out;
  }

  const isFinalRound = (pool) =>
    !!pool.bracket && pool.round === pool.bracket.length - 1;

  /** The playoff, or null. */
  function matchAt(pool, roundIndex, matchIndex) {
    if (matchIndex === THIRD_PLACE) return pool.thirdPlace || null;
    return pool.bracket?.[roundIndex]?.[matchIndex] || null;
  }

  /**
   * Move to the next round once every match in this one is decided.
   *
   * Moving into the FINAL also draws the third-place playoff, because that is
   * the moment both of its players are known. It is played at the same time as
   * the final and is reported like any other match — see thirdPlace below and
   * the note on placings().
   */
  function advanceRound(pool) {
    const round = pool.bracket?.[pool.round] || [];
    if (round.some(m => !m.winner)) return false;
    if (pool.round + 1 >= pool.bracket.length) {
      // The final is not over until the playoff beside it is.
      if (pool.thirdPlace && !pool.thirdPlace.winner) return false;
      pool.state = 'complete';
      return false;
    }
    pool.round += 1;
    if (pool.round === pool.bracket.length - 1) {
      const losers = F.semiFinalLosers(pool.bracket);
      if (losers) pool.thirdPlace = { a: losers[0], b: losers[1], winner: null, scores: null };
    }
    return true;
  }

  /**
   * Take a player out.
   *
   * What that means depends on whether anything has started:
   *
   *   filling   The seat is given back and so is the entry fee. The pool
   *             returns to taking entries, and the seat it frees is the next
   *             one somebody else takes — which is also what happens when a
   *             full pool loses someone before it begins.
   *
   *   running   A forfeit. The stake stays with the pool and whoever they were
   *             drawn against goes through. Refunding here would make quitting
   *             a losing bracket free, and the opponent has already spent
   *             their round waiting for a game that will not happen.
   *
   * Returns what was done, because the caller has to pay the refund and only
   * this knows whether one is owed.
   */
  function leave(poolId, userId) {
    const pool = pools.get(poolId);
    if (!pool) return { ok: false };

    const idx = pool.players.findIndex(p => p.userId === userId);
    if (idx === -1) return { ok: false };

    if (pool.state === 'filling') {
      pool.players.splice(idx, 1);
      // If everyone has gone, the pool goes with them rather than sitting
      // empty until the window closes and it is "refunded" a second time.
      if (pool.players.length === 0) pools.delete(poolId);
      return { ok: true, refund: !pool.free, entryFee: pool.entryFee, state: 'filling' };
    }

    if (pool.state !== 'running') return { ok: false };

    // Running: forfeit every match they are still in. Only ever one — a player
    // is in exactly one live match at a time — but walking the round is how it
    // finds which, and it costs nothing.
    let forfeited = null;
    const round = pool.bracket[pool.round] || [];
    round.forEach((m, i) => {
      if (m.winner) return;
      if (m.a !== userId && m.b !== userId) return;
      const opponent = m.a === userId ? m.b : m.a;
      if (!opponent) return;         // nobody to advance; leave it for the sweep
      reportResult(poolId, pool.round, i, opponent, { forfeit: userId });
      forfeited = { match: i, winner: opponent };
    });
    return { ok: true, refund: false, state: 'running', forfeited };
  }

  /**
   * Everything still live, for a restart.
   *
   * A tournament does not survive a deploy: its bracket, its sockets and its
   * in-flight rounds are all in this process. Rather than pretend otherwise,
   * this hands back every pool that has taken money and not paid it out, so the
   * caller can refund entries before the process goes. Losing the tournament is
   * acceptable; keeping the entry fee is not.
   */
  function drainForShutdown() {
    const owing = [...pools.values()].filter(p => p.state === 'filling' || p.state === 'running');
    for (const p of owing) p.state = 'abandoned';
    return owing;
  }

  return {
    pools,
    join, seat, leave, startPool, ticketsLeft, spentIn, matchAt, closeWindow, reportResult, pendingMatches, advanceRound,
    drainForShutdown, entryIn,
    get: (id) => pools.get(id) || null,
    clear: () => pools.clear(),
  };
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return Math.max(2, p);
}

module.exports = { createStore, seededRng, nextPowerOfTwo, TICKETS_PER_SLOT, THIRD_PLACE };
