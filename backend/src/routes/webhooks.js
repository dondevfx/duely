const { Router } = require('express');
const express  = require('express');
const crypto   = require('crypto');
const { creditCoins, recordDeposit } = require('../services/walletService');

// Sort object keys recursively (required for NOWPayments HMAC verification)
function sortKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)])
  );
}

module.exports = function webhookRoutes(supabase) {
  const router = Router();

  // ── NOWPayments IPN (deposit confirmations + payout updates) ─────────
  router.post('/nowpayments', express.json(), async (req, res) => {
    try {
      // Verify HMAC-SHA512 signature
      const sig = req.headers['x-nowpayments-sig'];
      if (process.env.NOWPAYMENTS_IPN_SECRET) {
        // Secret is configured — REQUIRE a valid signature. Reject if missing or wrong.
        if (!sig) return res.status(401).json({ error: 'Missing IPN signature' });
        const hmac = crypto
          .createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET)
          .update(JSON.stringify(sortKeys(req.body)))
          .digest('hex');
        if (hmac !== sig) return res.status(401).json({ error: 'Invalid IPN signature' });
      }

      const {
        payment_status,
        order_id,
        payment_id,
        outcome_amount,
        price_amount,
        actually_paid,
        pay_currency,
        type,       // 'payment' or 'payout'
      } = req.body;

      // Payout updates — just log, no balance change needed
      if (type === 'payout') {
        await supabase
          .from('transactions')
          .update({ status: payment_status === 'FINISHED' ? 'confirmed' : payment_status?.toLowerCase() || 'pending' })
          .eq('tx_hash', String(payment_id));
        return res.json({ ok: true });
      }

      // Credit on finished/confirmed. Also credit partially_paid if outcome_amount exists
      // (user sent any amount — we use what actually arrived in USDT)
      const creditableStatuses = ['finished', 'confirmed', 'partially_paid'];
      if (!creditableStatuses.includes(payment_status)) {
        return res.json({ ok: true });
      }

      // order_id format: "dep_{userId}_{timestamp}"
      const userId = order_id?.split('_')[1];
      if (!userId) return res.status(400).json({ error: 'Invalid order_id' });

      // outcome_amount = USDT received after conversion (most accurate)
      const cCoins = parseFloat(outcome_amount ?? price_amount ?? 0);
      if (cCoins <= 0) return res.status(400).json({ error: 'Zero amount' });

      // Enforce minimum deposit AFTER fees — if they sent $5 but fees ate some,
      // still credit them as long as at least $4.50 arrived (10% below minimum).
      // This protects against micro-deposits while not penalising borderline senders.
      const MIN_DEPOSIT = 4.5;
      if (cCoins < MIN_DEPOSIT) {
        console.warn(`[webhook] deposit below minimum: $${cCoins} for user ${userId} — skipping credit`);
        return res.json({ ok: true }); // ack to NOWPayments but don't credit
      }

      // Idempotency check
      const { data: dup } = await supabase
        .from('transactions')
        .select('id')
        .eq('tx_hash', String(payment_id))
        .maybeSingle();
      if (dup) return res.json({ ok: true });

      await creditCoins(supabase, userId, cCoins);
      await recordDeposit(supabase, userId, cCoins, 'crypto');
      await supabase.from('transactions').insert({
        user_id:       userId,
        type:          'deposit',
        amount_c:      cCoins,
        crypto_amount: parseFloat(actually_paid ?? 0),
        crypto_symbol: (pay_currency || '').toUpperCase(),
        tx_hash:       String(payment_id),
        status:        'confirmed',
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('NOWPayments webhook error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
