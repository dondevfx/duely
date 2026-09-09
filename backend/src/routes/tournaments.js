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
const { requireAuth } = require('../middleware/auth');
const F = require('../services/tournamentFormat');
const { deductCoins } = require('../services/walletService');
const { isDemo, randomFunnyName, PROFILE_COLORS } = require('../services/demoAccounts');

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
      // Same stake, or it has already started: they are where they belong.
      if (existing.entryFee === entryFee || existing.state !== 'filling') {
        return res.json({
          poolId: existing.id, already: true,
          entryFee: existing.entryFee,
          started: existing.state === 'running',
          players: existing.players.length,
          size: F.POOL_SIZE,
          startsAt: existing.slotStart + F.JOIN_WINDOW_MS,
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

    const { data: profile } = await supabase
      .from('profiles').select('username, avatar_url, c_coins').eq('id', req.user.id).maybeSingle();

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
    else if (demo) fillWithBots(pool, now, pools, { stagger: true, io });

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
      startsAt: pool.slotStart + F.JOIN_WINDOW_MS,
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
    res.json({ pool: mine ? publicPool(mine) : null });
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
  router.get('/:id', (req, res) => {
    if (!pools) return res.status(404).json({ error: 'Not found' });
    const pool = pools.get(req.params.id);
    if (!pool) return res.status(404).json({ error: 'That tournament has finished or never started.' });
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
  const one = () => pools.seat(pool, {
    userId: `bot:${pool.id}:${pool.players.length}`,
    username: randomFunnyName(),
    avatarUrl: null,
    isBot: true,
    now: Date.now(),
  });

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
    roundGames: p.roundGames,
    players: p.players.map(x => ({
      userId: x.userId, username: x.username, avatarUrl: x.avatarUrl,
    })),
    bracket: p.bracket,
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
