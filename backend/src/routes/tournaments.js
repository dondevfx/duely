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

  return router;
};

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
