const { Router }  = require('express');
const express     = require('express');
const { verifyWebhook, PLISIO_COINS, getUsdRate, createPayout: plisioPayout } = require('../services/plisioService');
const { createDepositSwap } = require('../services/simpleSwapService');
const { creditCoins, recordDeposit } = require('../services/walletService');
const { watch } = require('../services/swapPoller');

// Our USDC SPL wallet address — SimpleSwap sends converted funds here
const OUR_USDC_ADDRESS = process.env.USDC_SPL_ADDRESS;

// Minimum USD to credit after all fees settle
const MIN_CREDIT = 4.50;

// Reverse map: Plisio psys_cid → our internal coin id
const PLISIO_TO_COIN = Object.fromEntries(
  Object.entries(PLISIO_COINS).map(([coin, psys]) => [psys, coin])
);

module.exports = function webhookRoutes(supabase) {
  const router = Router();

  // ── Plisio IPN ────────────────────────────────────────────────────────
  router.post('/plisio', express.json(), async (req, res) => {
    try {
      const body = req.body;
      console.log('[plisio webhook] received:', JSON.stringify(body));

      // Verify HMAC signature
      if (!verifyWebhook(body)) {
        console.warn('[plisio webhook] invalid signature — rejecting');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const {
        status,     // 'completed' | 'pending' | 'new' | 'expired' | 'error'
        txn_id,     // Plisio transaction ID
        uid,        // userId we set when creating the deposit address
        amount,     // gross crypto received on-chain
        fee,        // blockchain network fee in crypto units
        psys_cid,   // Plisio coin ID e.g. 'SOL', 'USDT_TRX', 'BTC'
      } = body;

      // Only process fully completed transactions
      if (status !== 'completed') {
        console.log(`[plisio webhook] status=${status} — ignoring`);
        return res.json({ ok: true });
      }

      if (!uid || !txn_id || !psys_cid) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Idempotency — don't process the same transaction twice
      const { data: dup } = await supabase
        .from('transactions')
        .select('id')
        .eq('tx_hash', String(txn_id))
        .maybeSingle();
      if (dup) {
        console.log(`[plisio webhook] txn_id=${txn_id} already processed — skipping`);
        return res.json({ ok: true });
      }

      const grossCrypto = parseFloat(amount || 0);
      const networkFee  = parseFloat(fee    || 0);
      // Net = what we actually have in our Plisio wallet to forward
      const netCrypto   = Math.max(0, grossCrypto - networkFee);

      console.log(`[plisio webhook] uid=${uid} coin=${psys_cid} gross=${grossCrypto} fee=${networkFee} net=${netCrypto}`);

      // ── All deposits — forward to SimpleSwap → USDC SPL, credit when done ──
      // Every coin (including USDT TRC-20) is converted to USDC SPL so the
      // entire site float lives in one wallet. Withdrawals always pull from USDC.
      // We do NOT credit yet. We forward the crypto to SimpleSwap, and the
      // swapPoller credits the player with the exact USDC that arrives.
      if (!OUR_USDC_ADDRESS) {
        // Fallback if USDC_SPL_ADDRESS isn't configured yet — credit at spot price
        console.warn('[plisio webhook] USDC_SPL_ADDRESS not set — falling back to spot price credit');
        const priceUsd = await getUsdRate(psys_cid);
        const usdValue = Math.floor(netCrypto * priceUsd * 100) / 100;
        if (usdValue < MIN_CREDIT) return res.json({ ok: true });
        await creditCoins(supabase, uid, usdValue);
        await recordDeposit(supabase, uid, usdValue, 'crypto');
        await supabase.from('transactions').insert({
          user_id:       uid, type: 'deposit', amount_c: usdValue,
          crypto_amount: netCrypto, crypto_symbol: psys_cid,
          tx_hash:       String(txn_id), status: 'confirmed',
        });
        return res.json({ ok: true });
      }

      // Sanity check on net amount using price (catches obviously broken deposits)
      const priceUsd = await getUsdRate(psys_cid);
      const estimatedUsd = netCrypto * priceUsd;
      if (estimatedUsd < MIN_CREDIT) {
        console.warn(`[plisio webhook] estimated $${estimatedUsd.toFixed(2)} below minimum — skipping`);
        return res.json({ ok: true });
      }

      // Create the SimpleSwap conversion: coin → USDC SPL
      const coinId = PLISIO_TO_COIN[psys_cid] || psys_cid.toLowerCase();
      const swap = await createDepositSwap({
        coin:            coinId,
        amount:          netCrypto,
        ourStableAddress: OUR_USDC_ADDRESS,
        refundAddress:   '',  // no refund address — if swap fails, marked in DB
      });

      // Insert transaction as 'converting' — swapPoller will update to 'confirmed'
      // and credit the player once SimpleSwap finishes
      await supabase.from('transactions').insert({
        user_id:       uid,
        type:          'deposit',
        amount_c:      0,              // will be updated by swapPoller with exact amount
        crypto_amount: netCrypto,
        crypto_symbol: psys_cid,
        tx_hash:       swap.exchangeId, // SimpleSwap exchange ID for polling
        status:        'converting',
      });

      // Send the crypto from our Plisio wallet to SimpleSwap's deposit address
      await plisioPayout({
        address: swap.depositAddress,
        coin:    coinId,
        amount:  netCrypto,
      });

      // Start polling SimpleSwap for this exchange
      watch(swap.exchangeId, uid);

      console.log(`[plisio webhook] forwarding ${netCrypto} ${psys_cid} to SimpleSwap exchange ${swap.exchangeId}`);
      res.json({ ok: true });

    } catch (err) {
      console.error('[plisio webhook] error:', err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
