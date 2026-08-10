const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const TIER_PRIZES = {
  bronze:   [1000,  2000,  0, 2000,  5000,  2000,  10000, 1000],
  silver:   [2000,  5000,  0, 5000,  12000, 5000,  25000, 2000],
  gold:     [3000,  8000,  0, 8000,  20000, 8000,  50000, 3000],
  diamond:  [5000,  15000, 0, 15000, 40000, 15000, 75000, 5000],
  champion: [10000, 25000, 0, 25000, 60000, 25000, 100000, 10000],
};

const TIER_MIN_ELO = {
  bronze: 0, silver: 1100, gold: 1300, diamond: 1500, champion: 1900,
};

const TIER_IDS = ['bronze', 'silver', 'gold', 'diamond', 'champion'];

const COL_NAME = tier => `last_spin_${tier}`;

// Weighted roll — index 2 is coin slot (weight=0, never selected)
const WEIGHTS = [20, 15, 0, 15, 10, 15, 5, 20]; // total = 100

function rollPrize(tier) {
  const prizes = TIER_PRIZES[tier];
  if (!prizes) return 1000;
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < prizes.length; i++) {
    r -= WEIGHTS[i];
    if (r < 0) return prizes[i];
  }
  return prizes[0];
}

function getTierForElo(elo) {
  if (elo >= 1900) return 'champion';
  if (elo >= 1500) return 'diamond';
  if (elo >= 1300) return 'gold';
  if (elo >= 1100) return 'silver';
  return 'bronze';
}

module.exports = function rewardsRoutes(supabase) {
  const router = Router();

  // Referral progress for the rewards page.
  router.get('/referrals', requireAuth, async (req, res) => {
    try {
      const { getReferralStats } = require('../services/referralService');
      res.json(await getReferralStats(supabase, req.user.id));
    } catch (err) {
      console.error('[referral] stats:', err.message);
      res.status(500).json({ error: 'Could not load referrals' });
    }
  });

  // Collect matured referral rewards into the coin balance.
  router.post('/referrals/collect', requireAuth, async (req, res) => {
    try {
      const { collectReferralEarnings, getReferralStats } = require('../services/referralService');
      const collected = await collectReferralEarnings(supabase, req.user.id);
      // Return fresh stats too, so the card updates from one round trip and
      // cannot briefly show a balance it has already banked.
      const stats = await getReferralStats(supabase, req.user.id);
      res.json({ collected, ...stats });
    } catch (err) {
      console.error('[referral] collect:', err.message);
      res.status(500).json({ error: 'Could not collect earnings' });
    }
  });

  // GET /api/rewards/spin-status
  // Returns per-tier spin status for all tiers the user has unlocked
  router.get('/spin-status', requireAuth, async (req, res) => {
    try {
      const cols = TIER_IDS.map(t => COL_NAME(t)).join(', ');
      const { data, error } = await supabase
        .from('profiles')
        .select(`elo, ${cols}`)
        .eq('id', req.user.id)
        .single();

      if (error) return res.status(500).json({ error: error.message });

      const elo = data?.elo ?? 1000;
      const now = Date.now();

      const tiers = {};
      for (const tierId of TIER_IDS) {
        const col = COL_NAME(tierId);
        const lastSpin = data?.[col] ? new Date(data[col]).getTime() : 0;
        const canSpin = now - lastSpin >= COOLDOWN_MS;
        tiers[tierId] = {
          canSpin,
          nextSpinAt: canSpin ? null : new Date(lastSpin + COOLDOWN_MS).toISOString(),
        };
      }

      return res.json({ tiers, elo, activeTier: getTierForElo(elo) });
    } catch (err) {
      console.error('[rewards] spin-status error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/rewards/spin
  // Body: { tier: 'bronze'|'silver'|'gold'|'diamond'|'champion' }
  // Player must have elo >= tier's minElo to spin it
  router.post('/spin', requireAuth, async (req, res) => {
    try {
      const { tier } = req.body;
      if (!TIER_IDS.includes(tier)) {
        return res.status(400).json({ error: 'Invalid tier' });
      }

      const col = COL_NAME(tier);
      const { data, error } = await supabase
        .from('profiles')
        .select('elo')
        .eq('id', req.user.id)
        .single();

      if (error) return res.status(500).json({ error: error.message });

      const elo = data?.elo ?? 1000;

      // Check player has reached this tier
      if (elo < TIER_MIN_ELO[tier]) {
        return res.status(403).json({ error: `Reach ${TIER_MIN_ELO[tier]} ELO to spin the ${tier} wheel` });
      }

      // Atomic cooldown claim: stamp only if the cooldown has elapsed. The WHERE
      // guard + row lock serialize concurrent requests, closing the
      // read-check-then-stamp race that let a wheel be double-spun.
      const now = new Date();
      const threshold = new Date(Date.now() - COOLDOWN_MS).toISOString();
      const { data: claimed, error: stampErr } = await supabase
        .from('profiles')
        .update({ [col]: now.toISOString() })
        .eq('id', req.user.id)
        .or(`${col}.is.null,${col}.lt.${threshold}`)
        .select('id');

      if (stampErr) return res.status(500).json({ error: stampErr.message });
      if (!claimed || claimed.length === 0) {
        return res.status(400).json({ error: 'Already spun this wheel today' });
      }

      // Roll prize
      const prize = rollPrize(tier);
      const nextSpinAt = new Date(now.getTime() + COOLDOWN_MS).toISOString();

      // Helper: reset cooldown so user can retry if credit fails
      async function resetCooldown() {
        await supabase.from('profiles').update({ [col]: null }).eq('id', req.user.id).then().catch(() => {});
      }

      // Try RPC first (atomic increment)
      let credited = false;
      const { error: rpcErr } = await supabase.rpc('credit_diamonds', {
        user_id: req.user.id,
        amount: prize,
      });
      if (!rpcErr) {
        credited = true;
      } else {
        console.error('[rewards] credit_diamonds RPC failed:', rpcErr.message);
        // Fallback: direct atomic-ish update
        const { data: cur, error: readErr } = await supabase
          .from('profiles')
          .select('diamonds')
          .eq('id', req.user.id)
          .single();
        if (!readErr && cur != null) {
          const { error: updErr } = await supabase
            .from('profiles')
            .update({ diamonds: (cur.diamonds || 0) + prize })
            .eq('id', req.user.id);
          if (!updErr) credited = true;
          else console.error('[rewards] diamond direct update failed:', updErr.message);
        }
      }

      if (!credited) {
        // Reset cooldown so user can try again
        await resetCooldown();
        return res.status(500).json({ error: 'Could not credit diamonds. Please try again.' });
      }

      supabase
        .from('transactions')
        .insert({
          user_id: req.user.id,
          type: 'rewards_spin',
          amount_c: 0,
          crypto_amount: prize,
          crypto_symbol: 'diamonds',
          status: 'confirmed',
        })
        .then()
        .catch(e => console.error('[rewards] tx insert failed:', e.message));

      return res.json({ success: true, prize, tier, nextSpinAt });
    } catch (err) {
      console.error('[rewards] spin error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
