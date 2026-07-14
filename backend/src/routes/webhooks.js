const { Router }  = require('express');
const express     = require('express');
const { verifyWebhook, createPayout, COINS } = require('../services/cryptomusService');
const { createDepositSwap } = require('../services/simpleSwapService');
const { creditCoins, recordDeposit } = require('../services/walletService');
const { watch } = require('../services/swapPoller');

// Our USDC SPL wallet address — SimpleSwap sends converted funds here
const OUR_USDC_ADDRESS = process.env.USDC_SPL_ADDRESS;

// Minimum estimated USD value to bother converting (filters dust / spam)
const MIN_USD = 4.50;

// Map Cryptomus currency+network back to our internal coin id
function toCoinId(currency, network) {
  for (const [id, def] of Object.entries(COINS)) {
    if (def.currency === currency && def.network === network) return id;
  }
  // Fallback: lowercase currency
  return currency.toLowerCase();
}

module.exports = function webhookRoutes(supabase) {
  const router = Router();

  // ── Cryptomus IPN ─────────────────────────────────────────────────────
  // Fired whenever a static wallet receives a deposit (any amount).
  // body fields we care about:
  //   order_id       — 'dep_{userId}_{coin}'  (we set this when creating the wallet)
  //   status         — 'paid' | 'paid_over' | 'wrong_amount' | 'cancel' | 'fail'
  //   payer_currency — coin the player actually sent (e.g. 'SOL')
  //   payer_network  — network (e.g. 'SOL', 'TRON')
  //   payment_amount — raw crypto amount received on-chain (before Cryptomus fee)
  //   merchant_amount— net crypto after Cryptomus fee (what we can spend)
  //   payment_amount_usd — USD value Cryptomus calculated
  //   uuid           — Cryptomus unique transaction UUID (use for idempotency)
  router.post('/cryptomus', express.json(), async (req, res) => {
    try {
      const body = req.body;
      console.log('[cryptomus webhook] received:', JSON.stringify(body));

      // Verify HMAC signature
      if (!verifyWebhook(body)) {
        console.warn('[cryptomus webhook] invalid signature — rejecting');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const {
        uuid,
        order_id,
        status,
        payer_currency,
        payer_network,
        merchant_amount,      // net after Cryptomus fee
        payment_amount_usd,   // USD value from Cryptomus
        type,
      } = body;

      // Only process incoming payments, not payout callbacks
      if (type === 'payout') {
        console.log('[cryptomus webhook] payout callback — ignoring');
        return res.json({ ok: true });
      }

      // Only credit completed payments
      if (status !== 'paid' && status !== 'paid_over') {
        console.log(`[cryptomus webhook] status=${status} — ignoring`);
        return res.json({ ok: true });
      }

      // Extract userId from order_id: 'dep_{userId}_{coin}'
      const parts  = (order_id || '').split('_');
      const userId = parts[1] || null;   // UUID is parts[1], coin is parts[2]

      if (!userId || !uuid) {
        console.error('[cryptomus webhook] missing userId or uuid', { order_id, uuid });
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Idempotency — don't process the same Cryptomus transaction twice.
      // The deposit row stores the SimpleSwap exchangeId in tx_hash, so we key
      // dedup on the Cryptomus uuid saved in extra_id (below). Previously this
      // matched on tx_hash, which never held the uuid, so a webhook retry would
      // re-process — creating a duplicate swap + payout.
      const { data: dup } = await supabase
        .from('transactions')
        .select('id')
        .eq('extra_id', uuid)
        .maybeSingle();
      if (dup) {
        console.log(`[cryptomus webhook] uuid=${uuid} already processed — skipping`);
        return res.json({ ok: true });
      }

      const netCrypto   = parseFloat(merchant_amount  || 0);
      const estimatedUsd = parseFloat(payment_amount_usd || 0);
      const coinId      = toCoinId(payer_currency, payer_network);

      console.log(`[cryptomus webhook] userId=${userId} coin=${coinId} net=${netCrypto} ~$${estimatedUsd}`);

      // Reject dust deposits
      if (estimatedUsd < MIN_USD) {
        console.warn(`[cryptomus webhook] $${estimatedUsd} below minimum — skipping`);
        return res.json({ ok: true });
      }

      if (!OUR_USDC_ADDRESS) {
        console.error('[cryptomus webhook] USDC_SPL_ADDRESS not configured');
        return res.status(500).json({ error: 'Server misconfigured' });
      }

      // Create SimpleSwap exchange: coin → USDC SPL → our wallet
      const swap = await createDepositSwap({
        coin:             coinId,
        amount:           netCrypto,
        ourStableAddress: OUR_USDC_ADDRESS,
        refundAddress:    '',
      });

      // Record as 'converting' — swapPoller updates to 'confirmed' when done
      await supabase.from('transactions').insert({
        user_id:       userId,
        type:          'deposit',
        amount_c:      0,
        crypto_amount: netCrypto,
        crypto_symbol: payer_currency,
        tx_hash:       swap.exchangeId,
        extra_id:      uuid,   // Cryptomus uuid — used for webhook idempotency
        status:        'converting',
      });

      // Forward received crypto from our Cryptomus balance to SimpleSwap
      await createPayout({
        address: swap.depositAddress,
        coin:    coinId,
        amount:  netCrypto,
      });

      // Start polling SimpleSwap — credits player when USDC arrives
      watch(swap.exchangeId, userId);

      console.log(`[cryptomus webhook] forwarding ${netCrypto} ${coinId} to SimpleSwap exchange ${swap.exchangeId}`);
      res.json({ ok: true });

    } catch (err) {
      console.error('[cryptomus webhook] error:', err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
