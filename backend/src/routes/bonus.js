const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

const COIN_BONUS       = 1;
const COIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const DIAMOND_BONUS       = 500;
const DIAMOND_COOLDOWN_MS = 1 * 60 * 1000;

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
    // Atomic claim: only stamp the cooldown if it has actually elapsed. The
    // WHERE guard + Postgres row lock serialize concurrent requests, so exactly
    // one can win — closing the read-check-then-stamp race that let two
    // simultaneous requests both pass the cooldown and double-credit.
    const threshold = new Date(Date.now() - DIAMOND_COOLDOWN_MS).toISOString();
    const { data: claimed, error: stampErr } = await supabase
      .from('profiles')
      .update({ last_diamond_bonus: new Date().toISOString() })
      .eq('id', req.user.id)
      .or(`last_diamond_bonus.is.null,last_diamond_bonus.lt.${threshold}`)
      .select('id');
    if (stampErr) return res.status(500).json({ error: stampErr.message });
    if (!claimed || claimed.length === 0) {
      return res.status(400).json({ error: 'Already claimed' });
    }

    const { error: credErr } = await supabase.rpc('credit_diamonds', { user_id: req.user.id, amount: DIAMOND_BONUS });
    if (credErr) {
      // Credit failed — clear the stamp so the user can retry (they got nothing).
      await supabase.from('profiles').update({ last_diamond_bonus: null }).eq('id', req.user.id).then().catch(() => {});
      return res.status(500).json({ error: credErr.message });
    }

    supabase.from('transactions').insert({
      user_id: req.user.id, type: 'diamond_bonus', amount_c: 0,
      crypto_amount: DIAMOND_BONUS, crypto_symbol: 'diamonds', status: 'confirmed',
    }).then().catch(e => console.error('[tx] diamond bonus insert failed:', e.message));
    const { data: updated } = await supabase.from('profiles').select('diamonds').eq('id', req.user.id).single();
    res.json({ success: true, credited: DIAMOND_BONUS, diamonds: updated?.diamonds });
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
        console.error('[bonus] credit_diamonds RPC failed:', credErr.message);
        // Reset cooldown so user can try again — they got nothing.
        await supabase.from('profiles')
          .update({ last_spin_claimed: null }).eq('id', req.user.id).then().catch(() => {});
        return res.status(500).json({ error: 'Could not credit diamonds. Please try again.' });
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
