/**
 * What the tournament screen needs to draw itself.
 *
 * The stakes, what each place pays, and when the next one starts. All of it
 * comes from tournamentFormat rather than being written out again in the
 * frontend: a prize table that disagrees with the one being paid is a support
 * ticket per tournament, and it is the kind of duplication nobody notices
 * until the split changes.
 */
const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const F = require('../services/tournamentFormat');
const { deductCoins } = require('../services/walletService');
const { isDemo, randomFunnyName, disguisedFace, PROFILE_COLORS } = require('../services/demoAccounts');
const { TICKETS_PER_SLOT } = require('../services/tournamentPools');

module.exports = function tournamentRoutes(supabase, io, pools) {
  const router = express.Router();

  // Public: the screen has to render before anyone signs in.
  router.get('/schedule', (req, res) => {
    const now = Date.now();
    const slot = F.slotAt(now);
    const next = F.joinableSlot(now);

    res.json({
      poolSize: F.POOL_SIZE,
      rounds: F.ROUNDS,
      games: F.TOURNAMENT_GAMES,
      feeRate: F.FEE_RATE,
      // Serialised as absolute instants. Sending "four minutes left" instead
      // would be wrong the moment it sat in a cache or the tab slept, and the
      // client can subtract for itself.
      slot: {
        startsAt: slot.startsAt,
        closesAt: slot.closesAt,
        nextStartsAt: slot.nextStartsAt,
        joinOpen: slot.joinOpen,
      },
      joinable: {
        startsAt: next.startsAt,
        closesAt: next.closesAt,
      },
      stakes: F.ENTRY_FEES.map(fee => {
        const { pot, fee: rake, net, prizes } = F.prizesFor(fee);
        return { entryFee: fee, pot, rake, net, prizes };
      }),
    });
  });

  /**
   * Enter the next tournament.
   *
   * The slot's window is when a seat can be taken and when it can no longer
   * be. It is not a start time — a tournament starts when its bracket is
   * full, and one that has not filled by the close is refunded.
   *
   * The entry fee is taken BEFORE the seat is given. Seating first and charging
   * after leaves a player in a bracket they have not paid for if the deduction
   * fails, and there is no way to tell that from a player who has.
   */
  router.post('/join', requireAuth, async (req, res) => {
    const entryFee = Number(req.body?.entryFee);
    const vsBot = !!req.body?.vsBot;
    if (!F.ENTRY_FEES.includes(entryFee)) {
      return res.status(400).json({ error: `Entry is ${F.ENTRY_FEES.join(', ')} coins.` });
    }
    if (!pools) return res.status(503).json({ error: 'Tournaments are not available right now.' });

    const now = Date.now();
    const demo = isDemo(req.user.id);

    // Already in one: hand back the same pool rather than charging twice. A
    // second click is the common case, not an attack.
    const slot = F.joinableSlot(now);
    const existing = pools.entryIn(slot.startsAt, req.user.id);
    if (existing) {
      // Already playing one. Refused rather than answered with the tournament
      // they are in.
      //
      // It used to hand that one back whatever stake had been asked for, so a
      // player who set the slider to ten and pressed Play was taken to their
      // running one-coin bracket, which told them it was a one-coin entry.
      // Nothing was wrong with the bracket; the bet had simply been ignored,
      // silently, and the screen looked like it had lost the stake.
      if (existing.state === 'running') {
        return res.status(400).json({
          error: 'You are still in a tournament. Finish it before entering another.',
          poolId: existing.id,
          inProgress: true,
        });
      }
      // Same stake, still filling: a second click is the common case, not an
      // attack, so it lands them back on the seat they already have.
      if (existing.entryFee === entryFee) {
        return res.json({
          poolId: existing.id, already: true,
          entryFee: existing.entryFee,
          started: existing.state === 'running',
          players: existing.players.length,
          size: F.POOL_SIZE,
          tickets: pools.ticketsLeft(slot.startsAt, req.user.id),
          // When entry CLOSES, not when it starts. Nothing schedules a start:
          // a tournament begins the moment the bracket is full, and a bracket
          // that is not full when this passes is refunded.
          closesAt: existing.slotStart + F.JOIN_WINDOW_MS,
        });
      }
      // A DIFFERENT stake, and nothing has started: move them.
      //
      // One entry per slot at any stake means picking a new amount used to
      // hand back the seat they already had — so the screen said "5 coin
      // entry" however the slider was set, and the only way out was to wait
      // twenty minutes for the slot to pass.
      const left = pools.leave(existing.id, req.user.id);
      if (left.ok && left.refund) await refund(supabase, req.user.id, left.entryFee);
    }

    // Two goes per tournament. Checked before the fee is taken, so a refused
    // entry never has to be refunded.
    if (!vsBot && pools.ticketsLeft(slot.startsAt, req.user.id) <= 0) {
      return res.status(400).json({
        error: 'You have used both your goes at this tournament. The next one resets them.',
        tickets: 0,
      });
    }

    const { data: profile } = await supabase
      .from('profiles').select('username, avatar_url, profile_color, c_coins').eq('id', req.user.id).maybeSingle();

    // A bot tournament costs nothing and pays nothing. It exists to walk the
    // bracket end to end without sixteen people, so charging for it would make
    // testing cost real money.
    const free = vsBot;
    if (!free) {
      const balance = parseFloat(profile?.c_coins) || 0;
      if (balance < entryFee) {
        return res.status(400).json({ error: `You need ${entryFee} coins to enter.` });
      }
      try {
        await deductCoins(supabase, req.user.id, entryFee);
      } catch (e) {
        console.error('[tournament] entry fee failed:', e.message);
        return res.status(500).json({ error: 'Could not take the entry fee.' });
      }
    }

    let pool;
    try {
      ({ pool } = pools.join({
        userId: req.user.id,
        username: profile?.username || 'Player',
        avatarUrl: profile?.avatar_url || null,
        profileColor: profile?.profile_color || null,
        entryFee, now, free,
      }));
    } catch (e) {
      // The seat could not be given, so the fee goes straight back.
      if (!free) await refund(supabase, req.user.id, entryFee);
      return res.status(400).json({ error: e.message });
    }

    // Fill the rest with bots when asked for, and for a demo account.
    //
    // A demo account is a showcase: it is there to be watched filling up and
    // winning, not to sit in a queue for fifteen minutes waiting for fifteen
    // real people who may never arrive.
    // Free is a property of the TOURNAMENT, not of one entry: a bot bracket
    // takes nothing from anyone and pays nothing out, and settlement has to
    // read that from the pool rather than from whoever happened to open it.
    if (vsBot) pool.free = true;
    // Play vs Bot is a test button and starts at once. A demo account is a
    // showcase, so its bracket fills the way a real one does — see below.
    if (vsBot) fillWithBots(pool, now, pools);
    else if (demo) {
      // Marked so the runner can stage one draw for the demo to be shown — see
      // the demo branch in tournamentRunner's onResult.
      pool.demo = true;
      fillWithBots(pool, now, pools, { stagger: true, io });
    }

    // `started` decides whether the client leaves the bet screen. A bot or
    // demo bracket fills instantly and has something to watch; a real entry
    // usually waits for the rest of its sixteen, and a bracket of empty chairs
    // reads as the tournament being broken.
    res.json({
      poolId: pool.id,
      already: false,
      entryFee: pool.entryFee,
      bots: vsBot || demo,
      filling: demo && !vsBot,
      free: !!pool.free,
      started: pool.state === 'running',
      players: pool.players.length,
      size: F.POOL_SIZE,
      // Read AFTER seating, because a bracket that filled on this entry has
      // already spent the ticket.
      tickets: pools.ticketsLeft(pool.slotStart, req.user.id),
      closesAt: pool.slotStart + F.JOIN_WINDOW_MS,
    });
  });

  // How full the pools are right now, so the screen can say "9 of 16 waiting"
  // rather than leaving a player wondering whether anything is happening.
  router.get('/pools', (req, res) => {
    if (!pools) return res.json({ open: [] });
    const now = Date.now();
    const slot = F.joinableSlot(now);
    const open = [...pools.pools.values()]
      .filter(p => p.state === 'filling' && p.slotStart === slot.startsAt)
      .map(p => ({ entryFee: p.entryFee, players: p.players.length, size: F.POOL_SIZE }));
    res.json({ open, slotStartsAt: slot.startsAt });
  });

  // Where a signed-in player currently stands: the pool they are in, the
  // bracket as it looks now, and whose turn it is. One request the bracket
  // screen can poll, and the same shape the socket pushes.
  router.get('/me', requireAuth, (req, res) => {
    if (!pools) return res.json({ pool: null });
    const now = Date.now();
    const slot = F.joinableSlot(now);
    const mine = pools.entryIn(slot.startsAt, req.user.id)
              || [...pools.pools.values()].find(p =>
                   p.state === 'running' && p.players.some(x => x.userId === req.user.id));
    res.json({
      pool: mine ? publicPool(mine) : null,
      tickets: pools.ticketsLeft(slot.startsAt, req.user.id),
      ticketsPerSlot: TICKETS_PER_SLOT,
    });
  });

  /**
   * Give up a seat.
   *
   * Before it starts this is a refund; after it starts it is a forfeit and the
   * opponent goes through. The rule lives in the pool store — see leave().
   */
  router.post('/:id/leave', requireAuth, async (req, res) => {
    if (!pools) return res.status(503).json({ error: 'Tournaments are not available right now.' });
    const result = pools.leave(req.params.id, req.user.id);
    if (!result.ok) return res.status(400).json({ error: 'You are not in that tournament.' });
    if (result.refund) await refund(supabase, req.user.id, result.entryFee);
    res.json({ ok: true, refunded: !!result.refund, forfeited: result.state === 'running' });
  });

  // One pool, by id — what the bracket screen polls.
  //
  // Public rather than requireAuth: a player watching a bracket they were
  // knocked out of is still watching a bracket, and there is nothing here that
  // is not already on everyone else's screen.
  router.get('/:id', optionalAuth, (req, res) => {
    if (!pools) return res.status(404).json({ error: 'Not found' });
    const pool = pools.get(req.params.id);
    if (!pool) return res.status(404).json({ error: 'That tournament has finished or never started.' });
    // Somebody who left a running tournament is out of it. Letting them back
    // onto the bracket reads as though they might still be in it.
    if (req.user && pool.kicked?.has(req.user.id)) {
      return res.status(410).json({ error: 'You left this tournament, so you are out of it.', kicked: true });
    }
    res.json({ pool: publicPool(pool) });
  });

  return router;
};

/**
 * Top the pool up with bots so it starts now.
 *
 * They carry ordinary-looking names and no avatar, because the point of a
 * demo account's tournament is that it looks like a real one. `isBot` never
 * leaves the server — see publicPool.
 *
 * Seated directly into THIS pool rather than through join(). join() picks
 * whichever pool at that stake is taking entries, which is not necessarily
 * this one — so a demo account entering while a real bracket was filling
 * used to pack fifteen bots into the real players' tournament and start it
 * early, with the people who were waiting drawn against bots.
 */
function fillWithBots(pool, now, pools, { stagger = false, io = null } = {}) {
  const one = () => {
    const username = randomFunnyName();
    // A colour derived from the name, which is exactly what a real player with
    // no uploaded picture gets. Without it the bracket drew them as an empty
    // dark circle — every bot identical, and obviously not a person.
    const { profileColor } = disguisedFace(username);
    return pools.seat(pool, {
      userId: `bot:${pool.id}:${pool.players.length}`,
      username,
      avatarUrl: null,
      profileColor,
      isBot: true,
      now: Date.now(),
    });
  };

  if (!stagger) {
    while (pool.state === 'filling' && pool.players.length < F.POOL_SIZE) one();
    return;
  }

  // Arriving one at a time, over about eight seconds.
  //
  // Sixteen players appearing in the same instant does not read as a
  // tournament filling up; it reads as a list being printed. A demo account is
  // there to be shown the real thing, and the real thing is other people
  // turning up one after another — so they do, at an uneven pace, and the
  // bracket is drawn at the moment the sixteenth arrives exactly as it would
  // be for anyone else.
  const seatNext = () => {
    if (pool.state !== 'filling' || pool.players.length >= F.POOL_SIZE) return;
    one();
    if (io) io.emit('tournament_filling', { poolId: pool.id, players: pool.players.length, size: F.POOL_SIZE });
    if (pool.players.length < F.POOL_SIZE) {
      const t = setTimeout(seatNext, 250 + Math.floor(Math.random() * 700));
      if (t.unref) t.unref();
    }
  };
  seatNext();
}

async function refund(supabase, userId, amount) {
  try {
    await supabase.rpc('credit_coins', { user_id: userId, amount });
  } catch (e) {
    // Loud, because this is money the player has paid and not received a seat
    // for. It is the one failure here that cannot be left to a retry.
    console.error(`[tournament] REFUND FAILED for ${userId} (${amount} coins):`, e.message);
  }
}

/**
 * A pool as the client may see it.
 *
 * Never the raw object: it carries join timestamps and bot flags, and the
 * whole point of the bots is that a player cannot tell.
 */
function publicPool(p) {
  return {
    id: p.id,
    state: p.state,
    entryFee: p.entryFee,
    slotStart: p.slotStart,
    size: F.POOL_SIZE,
    round: p.round,
    rounds: p.roundGames?.length ?? F.ROUNDS,
    // Where the runner has got to, and when the next round begins. Both are
    // announced over the socket as they happen; they are here as well because
    // a client that was mid-navigation when one fired never heard it, and a
    // bot bracket starts in the same instant the player is still leaving the
    // bet screen. The socket is the fast path, this is the one always true.
    phase: p.phase || (p.state === 'filling' ? 'filling' : 'idle'),
    nextRoundAt: p.nextRoundAt ?? null,
    reelAt: p.reelAt ?? null,
    // ONLY the rounds that have been drawn.
    //
    // The whole rotation is decided when the pool is created, so that every
    // client is told the same thing and nobody can be shown one game and given
    // another. Sending all of it meant the bracket could name round three's
    // game before round one had been played — and the draw, when it came, had
    // nothing left to reveal. A round the tournament has not reached is not
    // the client's to know.
    roundGames: (p.roundGames || []).slice(0, p.state === 'running' ? p.round + 1 : 0),
    players: p.players.map(x => ({
      userId: x.userId, username: x.username, avatarUrl: x.avatarUrl,
      // The fallback colour for anyone without a picture — real players
      // included. It was left out, so every seat with no upload drew as the
      // same dark circle.
      profileColor: x.profileColor ?? null,
    })),
    bracket: p.bracket,
    // The third-place playoff, drawn beside the final. Off the bracket array
    // on purpose — see the note on placings().
    thirdPlace: p.thirdPlace || null,
    // Where it finished, so a card that missed the socket announcement can
    // still say what was won. See useTournamentResult.
    awards: p.awards || null,
  };
}

module.exports.publicPool = publicPool;
// Exported for the runner's clock, which is what discovers a pool that never
// filled — the routes never see that moment.
module.exports.refundPool = async function refundPool(supabase, pool) {
  if (pool.free || !(pool.entryFee > 0)) return;
  for (const p of pool.players) {
    if (p.isBot) continue;
    await refund(supabase, p.userId, pool.entryFee);
  }
};
