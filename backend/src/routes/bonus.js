const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

const COIN_BONUS       = 1;
const COIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const DIAMOND_BONUS       = 500;
const DIAMOND_COOLDOWN_MS = 1 * 60 * 1000;

// One-off welcome grant, claimed from a popup the first time a new account
// loads the site. No cooldown — profiles.signup_bonus_claimed_at is null
// exactly once per account, which is the whole guard.
const SIGNUP_BONUS = 5000;

const SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SPIN_PRIZES = [
  { prize: 1000,  weight: 59 },
  { prize: 5000,  weight: 35 },
  { prize: 20000, weight: 5  },
  { prize: 50000, weight: 1  },
];

function rollSpinPrize() {
  const total = SPIN_PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.floor(Math.random() * total);
  for (const p of SPIN_PRIZES) {
    r -= p.weight;
    if (r < 0) return p.prize;
  }
  return 1000;
}

module.exports = function bonusRoutes(supabase) {
  const router = Router();

  // ── C Coin daily bonus ─────────────────────────────────────────────
  router.get('/status', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles').select('last_bonus_claimed').eq('id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'Profile not found' });

    const last     = data.last_bonus_claimed ? new Date(data.last_bonus_claimed).getTime() : 0;
    const canClaim = Date.now() - last >= COIN_COOLDOWN_MS;
    res.json({
      canClaim,
      nextClaimAt: canClaim ? null : new Date(last + COIN_COOLDOWN_MS).toISOString(),
      bonusAmount: COIN_BONUS,
    });
  });

  // Atomic claim — uses a Postgres function that checks + credits in one SQL statement.
  // Two concurrent requests serialize at the row lock; the second sees the updated
  // timestamp and gets 'already_claimed' from the DB, never double-crediting.
  router.post('/claim', requireAuth, async (req, res) => {
    // Retired. claim_daily_bonus adds a coin to c_coins with no deposit behind
    // it, and coins may only enter through the treasury. The site stopped
    // calling this long ago, but the route still answered: any account could
    // POST it for a free coin a day, and a farm of accounts could play those
    // coins through against each other and withdraw them. Refused before the
    // database is touched. (Audit #2, finding V1.)
    return res.status(410).json({ error: 'This bonus is no longer available.' });
    // eslint-disable-next-line no-unreachable
    const { data, error } = await supabase.rpc('claim_daily_bonus', {
      p_user_id: req.user.id,
    });
    if (error) {
      const alreadyClaimed = error.message?.includes('already_claimed');
      return res.status(alreadyClaimed ? 400 : 500).json({ error: alreadyClaimed ? 'Already claimed today' : error.message });
    }
    supabase.from('transactions').insert({
      user_id: req.user.id, type: 'daily_bonus', amount_c: COIN_BONUS, status: 'confirmed',
    }).then().catch(e => console.error('[tx] bonus insert failed:', e.message));
    const { data: updated } = await supabase.from('profiles').select('c_coins').eq('id', req.user.id).single();
    res.json({ success: true, credited: COIN_BONUS, new_balance: updated?.c_coins });
  });

  // ── Diamond 5-min bonus ───────────────────────────────────────────
  router.get('/diamond-status', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles').select('last_diamond_bonus, diamonds').eq('id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'Profile not found' });

    const last     = data.last_diamond_bonus ? new Date(data.last_diamond_bonus).getTime() : 0;
    const canClaim = Date.now() - last >= DIAMOND_COOLDOWN_MS;
    res.json({
      canClaim,
      nextClaimAt: canClaim ? null : new Date(last + DIAMOND_COOLDOWN_MS).toISOString(),
      bonusAmount: DIAMOND_BONUS,
      // Sent so the page can label itself. It used to hardcode "250 every 5
      // minutes" in three places, which is three things to remember when the
      // numbers change and three ways to advertise the wrong offer.
      cooldownMs:  DIAMOND_COOLDOWN_MS,
      diamonds:    data.diamonds || 0,
    });
  });

  router.post('/diamond-claim', requireAuth, async (req, res) => {
    // One statement: stamp the cooldown AND credit, or do neither.
    //
    // This used to stamp the cooldown, credit separately, and — if the credit
    // reported an error — clear the stamp so the player could try again. The
    // stamp itself was race-safe, but the retry path was not: a credit that
    // COMMITTED and then failed to report (a dropped response between here and
    // Postgres is enough) cleared the cooldown on money that had already been
    // paid, and the next claim paid it a second time. Every claim path in this
    // codebase had some version of that shape.
    //
    // claim_diamond_bonus does both halves in a single UPDATE guarded by the
    // cooldown, so there is nothing to roll back and no window to roll it back
    // in. The amount is a server constant; the client sends nothing at all.
    const { error } = await supabase.rpc('claim_diamond_bonus', {
      p_user_id: req.user.id,
      p_amount:  DIAMOND_BONUS,
    });
    if (error) {
      if (/already_claimed/.test(error.message || '')) {
        return res.status(400).json({ error: 'Already claimed' });
      }
      console.error('[bonus] diamond claim failed:', error.message);
      return res.status(500).json({ error: 'Could not claim the bonus.' });
    }

    supabase.from('transactions').insert({
      user_id: req.user.id, type: 'diamond_bonus', amount_c: 0,
      crypto_amount: DIAMOND_BONUS, crypto_symbol: 'diamonds', status: 'confirmed',
    }).then().catch(e => console.error('[tx] diamond bonus insert failed:', e.message));

    const { data: updated } = await supabase.from('profiles').select('diamonds').eq('id', req.user.id).single();
    res.json({ success: true, credited: DIAMOND_BONUS, diamonds: updated?.diamonds });
  });

  // ── One-time signup reward ────────────────────────────────────────
  // Run in Supabase SQL editor:
  //   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS signup_bonus_claimed_at timestamptz;
  //   UPDATE profiles SET signup_bonus_claimed_at = now()
  //     WHERE signup_bonus_claimed_at IS NULL AND created_at < now();
  //
  // That second statement matters. Without it the column is null for every
  // account that already exists, so shipping this would pop a 5,000 diamond
  // gift in front of the entire userbase at once — a welcome bonus handed to
  // people who have been here for months. Backfilling marks them claimed, and
  // only accounts created after the migration see the popup.

  router.get('/signup-status', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles').select('signup_bonus_claimed_at').eq('id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'Profile not found' });
    res.json({
      canClaim:    !data.signup_bonus_claimed_at,
      bonusAmount: SIGNUP_BONUS,
    });
  });

  router.post('/signup-claim', requireAuth, async (req, res) => {
    // Same atomic shape as every other claim here: the conditional UPDATE is
    // the guard, not a preceding SELECT. .is(null) plus the row lock means two
    // simultaneous requests serialize and exactly one comes back with a row —
    // the loser sees a stamped column and is turned away, so the grant cannot
    // be taken twice however fast the button is pressed.
    const { data: claimed, error: stampErr } = await supabase
      .from('profiles')
      .update({ signup_bonus_claimed_at: new Date().toISOString() })
      .eq('id', req.user.id)
      .is('signup_bonus_claimed_at', null)
      .select('id');
    if (stampErr) return res.status(500).json({ error: stampErr.message });
    if (!claimed || claimed.length === 0) {
      return res.status(400).json({ error: 'Already claimed' });
    }

    const { error: credErr } = await supabase.rpc('credit_diamonds', {
      user_id: req.user.id, amount: SIGNUP_BONUS,
    });
    if (credErr) {
      // The stamp STAYS. An error does not prove the credit failed: a response
      // lost after Postgres committed reports an error for diamonds that
      // landed, and clearing the stamp then pays the grant twice. Logged for a
      // person instead, like every other claim. (Audit #2, finding V4.)
      console.error(`[bonus] SIGNUP CLAIM UNRESOLVED user=${req.user.id} amount=${SIGNUP_BONUS} — ` +
        `stamped, credit reported "${credErr.message}". Check the balance before re-granting.`);
      return res.status(500).json({ error: 'Could not credit your diamonds. Support has been notified.' });
    }

    supabase.from('transactions').insert({
      user_id: req.user.id, type: 'diamond_bonus', amount_c: 0,
      crypto_amount: SIGNUP_BONUS, crypto_symbol: 'diamonds', status: 'confirmed',
    }).then().catch(e => console.error('[tx] signup bonus insert failed:', e.message));

    const { data: updated } = await supabase.from('profiles').select('diamonds').eq('id', req.user.id).single();
    res.json({ success: true, credited: SIGNUP_BONUS, diamonds: updated?.diamonds });
  });

  // ── Daily spin wheel ──────────────────────────────────────────────
  // Cooldown stored in profiles.last_spin_claimed (timestamptz).
  // Run in Supabase SQL editor: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_spin_claimed timestamptz;

  async function getSpinProfile(userId) {
    const { data } = await supabase
      .from('profiles').select('last_spin_claimed').eq('id', userId).single();
    return data;
  }

  router.get('/spin-status', requireAuth, async (req, res) => {
    try {
      const data    = await getSpinProfile(req.user.id);
      const last    = data?.last_spin_claimed ? new Date(data.last_spin_claimed).getTime() : 0;
      const canSpin = Date.now() - last >= SPIN_COOLDOWN_MS;
      res.json({ canSpin, nextSpinAt: canSpin ? null : new Date(last + SPIN_COOLDOWN_MS).toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/spin', requireAuth, async (req, res) => {
    try {
      // Atomic claim: stamp only if the cooldown has elapsed (row-lock serializes
      // concurrent requests), closing the read-check-then-stamp double-spin race.
      const threshold = new Date(Date.now() - SPIN_COOLDOWN_MS).toISOString();
      const { data: claimed, error: stampErr } = await supabase
        .from('profiles')
        .update({ last_spin_claimed: new Date().toISOString() })
        .eq('id', req.user.id)
        .or(`last_spin_claimed.is.null,last_spin_claimed.lt.${threshold}`)
        .select('id');
      if (stampErr) return res.status(500).json({ error: stampErr.message });
      if (!claimed || claimed.length === 0)
        return res.status(400).json({ error: 'Already spun today — come back tomorrow!' });

      const prize = rollSpinPrize();

      // credit_diamonds only. The old fallback here read the balance, added the
      // prize in JS, and wrote it back — not atomic, unlike the row-locked stamp
      // above it. Two spins whose RPC both failed in the same instant could read
      // the same starting balance and one prize would vanish, or double-add if a
      // credit succeeded but reported an error the caller mis-read. Diamonds
      // aren't withdrawable, which is the only reason this sat unfixed as long as
      // it did — it is still a real balance, and "small blast radius" was true
      // right up until it wasn't. Fail closed and let them retry, same as the
      // diamond-claim handler above.
      const { error: credErr } = await supabase.rpc('credit_diamonds', {
        user_id: req.user.id,
        amount:  prize,
      });

      if (credErr) {
        // The cooldown STAYS stamped: clearing it after a credit that committed
        // but reported an error re-arms a repeatable spin. See the signup claim.
        console.error(`[bonus] SPIN UNRESOLVED user=${req.user.id} prize=${prize} — ` +
          `stamped, credit reported "${credErr.message}". Check the balance before re-granting.`);
        return res.status(500).json({ error: 'Could not credit your prize. Support has been notified.' });
      }

      supabase.from('transactions').insert({
        user_id: req.user.id, type: 'diamond_bonus', amount_c: 0,
        crypto_amount: prize, crypto_symbol: 'diamonds', status: 'confirmed',
      }).then().catch(e => console.error('[tx] spin bonus insert failed:', e.message));

      const now = new Date();
      const nextSpinAt = new Date(now.getTime() + SPIN_COOLDOWN_MS).toISOString();
      res.json({ success: true, prize, nextSpinAt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
