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
      return res.json({
        poolId: existing.id, already: true,
        started: existing.state === 'running',
        players: existing.players.length,
        size: F.POOL_SIZE,
        startsAt: existing.slotStart + F.JOIN_WINDOW_MS,
      });
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
    if (vsBot || demo) fillWithBots(pool, now, pools);

    // `started` decides whether the client leaves the bet screen. A bot or
    // demo bracket fills instantly and has something to watch; a real entry
    // usually waits for the rest of its sixteen, and a bracket of empty chairs
    // reads as the tournament being broken.
    res.json({
      poolId: pool.id,
      already: false,
      bots: vsBot || demo,
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
 */
function fillWithBots(pool, now, pools) {
  while (pool.state === 'filling' && pool.players.length < F.POOL_SIZE) {
    pools.join({
      userId: `bot:${pool.id}:${pool.players.length}`,
      username: randomFunnyName(),
      avatarUrl: null,
      entryFee: pool.entryFee,
      isBot: true,
      free: true,
      now,
    });
  }
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
