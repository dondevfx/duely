const { Router }  = require('express');
const express     = require('express');
const { verifyWebhook, createPayout, COINS } = require('../services/cryptomusService');
const { createDepositSwap } = require('../services/simpleSwapService');
const { creditCoins, recordDeposit } = require('../services/walletService');
const { watch } = require('../services/swapPoller');

// Our USDC SPL wallet address — SimpleSwap sends converted funds here
const OUR_USDC_ADDRESS = process.env.USDC_SPL_ADDRESS;

// Minimum estimated USD value to bother converting (filters dust / spam)
const MIN_USD = 3.00; // credit floor — matches MIN_CREDIT_USD in blockchainMonitor/swapPoller

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

      const netCrypto    = parseFloat(merchant_amount  || 0);
      const estimatedUsd = parseFloat(payment_amount_usd || 0);
      const coinId       = toCoinId(payer_currency, payer_network);

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

      // ── Claim this uuid BEFORE doing anything irreversible ──────────────
      //
      // This used to SELECT for an existing row, then create the swap, then
      // insert. Gateways retry aggressively, and two retries in flight together
      // both passed the SELECT, both created a swap, and both issued a payout —
      // sending real crypto twice for one deposit.
      //
      // Inserting first turns the check into an atomic claim: the unique index
      // on extra_id means exactly one request can win, and only the winner goes
      // on to move funds. This is the same claim-then-act pattern the chain
      // monitor and swap poller already use.
      //
      // Requires: CREATE UNIQUE INDEX ... ON transactions (extra_id)
      //           WHERE extra_id IS NOT NULL;
      // Without that index this is still a plain insert and the race remains.
      const { error: claimErr } = await supabase.from('transactions').insert({
        user_id:       userId,
        type:          'deposit',
        amount_c:      0,
        crypto_amount: netCrypto,
        crypto_symbol: payer_currency,
        extra_id:      uuid,        // the gateway's id — our idempotency key
        status:        'claiming',
      });
      if (claimErr) {
        // 23505 = unique violation = another delivery of this same webhook has
        // it. Anything else is a real DB fault and must not silently drop a
        // deposit, so it is surfaced for the gateway to retry.
        if (claimErr.code === '23505') {
          console.log(`[cryptomus webhook] uuid=${uuid} already claimed — skipping`);
          return res.json({ ok: true });
        }
        console.error('[cryptomus webhook] claim insert failed:', claimErr.message);
        return res.status(500).json({ error: 'Could not record deposit' });
      }

      // ── Already USDC on Solana: no conversion needed ────────────────────
      //
      // Card purchases settle to us in USDC (see cryptomusService.createInvoice),
      // so routing them through an exchange would swap USDC for USDC and pay a
      // spread and two network fees for nothing. Instead pay it straight to the
      // player's own USDC deposit address — from there blockchainMonitor credits
      // it exactly like any other deposit, on the path that is already audited
      // and idempotent.
      if (coinId === 'usdcspl') {
        let dest;
        try {
          const { getOrCreateAddress } = require('../services/addressService');
          ({ address: dest } = await getOrCreateAddress(userId, 'usdc', supabase));
        } catch (e) {
          console.error('[cryptomus webhook] could not resolve deposit address, releasing claim:', e.message);
          await supabase.from('transactions').delete().eq('extra_id', uuid).eq('status', 'claiming');
          return res.status(500).json({ error: 'Could not resolve destination' });
        }

        try {
          await createPayout({ address: dest, coin: 'usdcspl', amount: netCrypto });
        } catch (payErr) {
          // Funds are sitting in the merchant balance and have not moved. Keep
          // the claim so a retry cannot double-send; this needs a human.
          console.error(`[cryptomus webhook] CRITICAL payout failed uuid=${uuid}:`, payErr.message);
          await supabase.from('transactions')
            .update({ status: 'payout_failed' }).eq('extra_id', uuid);
          return res.status(500).json({ error: 'Payout failed' });
        }

        // The monitor writes the row that actually credits the player, keyed on
        // the on-chain hash. This row is only the idempotency claim, so close it
        // out rather than leaving it stuck at 'claiming'.
        await supabase.from('transactions')
          .update({ status: 'forwarded' }).eq('extra_id', uuid);
        console.log(`[cryptomus webhook] card purchase ${netCrypto} USDC → ${dest} (monitor will credit)`);
        return res.json({ ok: true });
      }

      // Create SimpleSwap exchange: coin → USDC SPL → our wallet
      let swap;
      try {
        swap = await createDepositSwap({
          coin:             coinId,
          amount:           netCrypto,
          ourStableAddress: OUR_USDC_ADDRESS,
          refundAddress:    '',
        });
      } catch (swapErr) {
        // No funds have moved yet, so release the claim and let the gateway
        // retry. Leaving it claimed would strand the deposit permanently.
        console.error('[cryptomus webhook] swap creation failed, releasing claim:', swapErr.message);
        await supabase.from('transactions').delete().eq('extra_id', uuid).eq('status', 'claiming');
        return res.status(500).json({ error: 'Swap creation failed' });
      }

      await supabase.from('transactions')
        .update({ tx_hash: swap.exchangeId, status: 'converting' })
        .eq('extra_id', uuid);

      // Forward received crypto from our Cryptomus balance to SimpleSwap
      try {
        await createPayout({
          address: swap.depositAddress,
          coin:    coinId,
          amount:  netCrypto,
        });
      } catch (payErr) {
        // The claim is deliberately KEPT here. Funds may already be moving, so
        // a retry could double-send; this needs a human, not an automatic retry.
        console.error(`[cryptomus webhook] CRITICAL payout failed after claim uuid=${uuid} exchange=${swap.exchangeId}:`, payErr.message);
        await supabase.from('transactions')
          .update({ status: 'payout_failed' }).eq('extra_id', uuid);
        return res.status(500).json({ error: 'Payout failed' });
      }

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
