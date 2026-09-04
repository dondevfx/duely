const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { creditCoins } = require('../services/walletService');

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

// Weighted roll among the seven diamond segments — index 2 is the coin slot
// and is NOT in this array. It never was reachable through this pool (weight
// 0 before, absent now); it is handled as its own roll below, before this one
// even runs. Untouched otherwise — every diamond tier keeps exactly the odds
// it always had.
const WEIGHTS = [20, 15, 15, 10, 15, 5, 20]; // total = 100
const DIAMOND_IDX = [0, 1, 3, 4, 5, 6, 7]; // tier-array indices these weights line up with (skips 2)

// The coin segment is drawn on every wheel and has sat at literal zero odds —
// index 2's weight was 0, and the frontend separately excluded index 2 from
// ever being the landing segment. Both of those still made it impossible, not
// just rare, which is different from what was asked for: real odds, just
// vanishingly small, with no floor or pity timer forcing it to ever land.
//
// 1 in 100,000,000. At one spin a day that is an average wait of about
// 274,000 years — a genuine probability rather than a disguised "never", and
// small enough that it will not visibly move the story of this feature.
//
// Well inside what Math.random can express: its resolution is about 2^-53, so
// 1e-8 is roughly 45 million times coarser than the floor. The roll is not
// crypto-grade, which is the standard this codebase holds money outcomes to —
// worth knowing, though at these odds the practical exposure is a rounding
// error against the diamond prizes it sits beside.
const COIN_ODDS = 1 / 100_000_000;

// { kind: 'coins', amount: 1, segIdx: 2 } | { kind: 'diamonds', amount, segIdx }
//
// The type is explicit rather than inferred from the amount. A coin win pays
// 1 — a value that happens not to collide with any diamond prize today, but
// inferring the currency from a number that could collide by a future tier
// change is exactly the kind of bug that pays out the wrong currency.
function rollPrize(tier) {
  const prizes = TIER_PRIZES[tier];
  if (!prizes) return { kind: 'diamonds', amount: 1000, segIdx: 0 };

  if (Math.random() < COIN_ODDS) {
    return { kind: 'coins', amount: 1, segIdx: 2 };
  }

  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WEIGHTS.length; i++) {
    r -= WEIGHTS[i];
    if (r < 0) {
      const segIdx = DIAMOND_IDX[i];
      return { kind: 'diamonds', amount: prizes[segIdx], segIdx };
    }
  }
  return { kind: 'diamonds', amount: prizes[0], segIdx: 0 };
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

  // The caller's invite code, or null if they have not chosen one yet.
  //
  // Separate from /referrals so the app can warm the code at boot without
  // pulling reward stats it is not going to show — otherwise the code only
  // exists once a ReferralCard has mounted and answered, and a share button
  // elsewhere has nothing to build a link from.
  router.get('/referral-code', requireAuth, async (req, res) => {
    try {
      const { getReferralCode } = require('../services/referralService');
      res.json({ code: await getReferralCode(supabase, req.user.id) });
    } catch (err) {
      console.error('[referral] code:', err.message);
      res.status(500).json({ error: 'Could not load your referral code' });
    }
  });

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
      const roll = rollPrize(tier);
      const nextSpinAt = new Date(now.getTime() + COOLDOWN_MS).toISOString();

      // Helper: reset cooldown so user can retry if credit fails
      async function resetCooldown() {
        await supabase.from('profiles').update({ [col]: null }).eq('id', req.user.id).then().catch(() => {});
      }

      // credit_diamonds (or creditCoins on the rare coin roll) only — no manual
      // read-add-write fallback. That fallback used to sit here: read the
      // balance, add the prize in JS, write it back. Not row-locked like the
      // cooldown stamp above it, so two requests hitting the fallback in the
      // same instant could read the same starting balance and one prize would
      // vanish, or double-credit if a "failed" RPC had actually partly gone
      // through. Fail closed instead and let the player retry — the same
      // pattern the cooldown stamp already uses correctly.
      let credErr;
      if (roll.kind === 'coins') {
        try { await creditCoins(supabase, req.user.id, roll.amount); }
        catch (e) { credErr = e; }
      } else {
        ({ error: credErr } = await supabase.rpc('credit_diamonds', {
          user_id: req.user.id,
          amount: roll.amount,
        }));
      }

      if (credErr) {
        console.error(`[rewards] credit failed (${roll.kind}):`, credErr.message || credErr);
        await resetCooldown();
        return res.status(500).json({ error: 'Could not credit your prize. Please try again.' });
      }

      supabase
        .from('transactions')
        .insert(roll.kind === 'coins'
          ? { user_id: req.user.id, type: 'rewards_spin', amount_c: roll.amount, status: 'confirmed' }
          : { user_id: req.user.id, type: 'rewards_spin', amount_c: 0, crypto_amount: roll.amount, crypto_symbol: 'diamonds', status: 'confirmed' })
        .then()
        .catch(e => console.error('[rewards] tx insert failed:', e.message));

      return res.json({
        success: true,
        prize:   roll.amount,
        currency: roll.kind,   // 'coins' | 'diamonds' — the frontend must not infer this from the amount
        segIdx:  roll.segIdx,  // which wedge actually won, so the wheel lands where it truly landed
        tier, nextSpinAt,
      });
    } catch (err) {
      console.error('[rewards] spin error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
