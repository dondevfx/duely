const { Router }  = require('express');
const express     = require('express');
const { verifyWebhook, createPayout, COINS } = require('../services/cryptomusService');
const { createDepositSwap } = require('../services/simpleSwapService');
const { creditCoins, recordDeposit } = require('../services/walletService');
const { watch } = require('../services/swapPoller');
const { USDC_MINT, USDT_MINT } = require('../services/chainSend');
const didit = require('../services/diditService');
const helius = require('../services/heliusWebhooks');
const { processDeposit } = require('../services/blockchainMonitor');

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

  // ── Didit identity verification ───────────────────────────────────────
  //
  // Didit decides, then tells us. This turns its answer into kyc_status, which
  // is what the bank-withdrawal gate reads.
  //
  // express.raw, not express.json: the signature is computed over the body, so
  // it has to be verified before anything is allowed to re-encode it.
  router.post('/didit', express.raw({ type: '*/*' }), async (req, res) => {
    const check = didit.verifyWebhook(req.body, req.headers);
    if (!check.ok) {
      // 401, not 400. A rejected webhook is an authentication failure, and
      // saying which part failed to an unauthenticated caller tells a forger
      // how close they got — so the detail is logged, not returned.
      console.warn('[didit webhook] rejected:', check.reason);
      return res.status(401).json({ error: 'invalid signature' });
    }

    const p = check.payload;

    // A sandbox event must never touch a real player. Without this check,
    // anyone who obtained the sandbox secret could approve production accounts.
    if (p.environment && p.environment !== didit.ENVIRONMENT) {
      console.warn(`[didit webhook] ignoring ${p.environment} event (we are ${didit.ENVIRONMENT})`);
      return res.json({ ignored: true });
    }

    const userId    = p.vendor_data;
    const sessionId = p.session_id;
    const status    = didit.mapStatus(p.status);

    if (!userId || !sessionId) {
      console.error('[didit webhook] no vendor_data or session_id — cannot match a player');
      return res.json({ ignored: true });
    }

    // Acknowledge fast. Didit retries on a non-2xx, and a slow database write
    // would earn duplicate deliveries on top of the work already in flight.
    res.json({ ok: true });

    try {
      // Out-of-order delivery is real: a retried "In Progress" can arrive after
      // "Approved". created_at is when the record actually changed, so an event
      // older than what we already hold is dropped rather than applied.
      const eventAt = Number(p.created_at || p.timestamp || 0);

      const { data: existing } = await supabase
        .from('kyc_submissions')
        .select('id, didit_updated_at')
        .eq('didit_session_id', sessionId)
        .maybeSingle();

      if (existing && Number(existing.didit_updated_at || 0) > eventAt) {
        console.log(`[didit webhook] stale event for ${sessionId} — ignored`);
        return;
      }

      const row = {
        user_id:           userId,
        didit_session_id:  sessionId,
        didit_status:      p.status,
        didit_updated_at:  eventAt,
        status:            status === 'approved' ? 'approved'
                         : status === 'rejected' ? 'rejected' : 'pending',
        decision:          p.decision ?? null,
        reviewed_at:       new Date().toISOString(),
      };

      if (existing) {
        await supabase.from('kyc_submissions').update(row).eq('id', existing.id);
      } else {
        await supabase.from('kyc_submissions').insert(row);
      }

      // The gate moves last, and only for a decision we understand. 'pending'
      // deliberately writes 'pending' rather than leaving a stale 'approved' in
      // place — Kyc Expired has to be able to close the gate again.
      const reason = status === 'rejected'
        ? (p.decision?.reason || 'Your verification was not approved.')
        : null;

      const { error: gateErr } = await supabase
        .from('profiles')
        .update({
          kyc_status:           status,
          kyc_reviewed_at:      new Date().toISOString(),
          kyc_rejection_reason: reason,
        })
        .eq('id', userId);

      if (gateErr) {
        console.error(`[didit webhook] CRITICAL: decision ${p.status} recorded for ${userId} but the gate did not move:`, gateErr.message);
        return;
      }

      console.log(`[didit webhook] ${userId} -> ${p.status} (${status})`);
    } catch (e) {
      console.error('[didit webhook] processing failed:', e.message);
    }
  });

  // ── Helius: a Solana deposit, pushed ──────────────────────────────────
  //
  // The polling monitor asks every address ever issued whether anything has
  // arrived, every 45 seconds, forever. This is the same information arriving
  // the other way round: Helius watches the addresses and calls us when one
  // receives something, so an idle address costs nothing and a real deposit is
  // seen immediately instead of up to 45 seconds later.
  //
  // Deliberately thin. Everything downstream — idempotency, the gas reserve,
  // the swap, the credit — is processDeposit, exactly as the poller uses it.
  // Two paths into money with two sets of rules is how a deposit gets credited
  // twice; this one only decides WHICH deposit, never what happens to it.
  router.post('/helius', express.json({ limit: '2mb' }), async (req, res) => {
    // Constant-time-ish comparison is overkill for a bearer token compared
    // against a fixed-length secret, but the check itself is not optional: the
    // URL is the only other thing protecting an endpoint that credits money,
    // and a URL is not a secret.
    const auth = req.get('authorization') || '';
    const expected = helius.secret();
    if (!expected || auth !== expected) {
      // 401 without detail. A caller who guessed the URL learns nothing about
      // whether the secret is set, wrong, or merely malformed.
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Acknowledge first, work after.
    //
    // Helius retries on a non-2xx, and processing a deposit means a swap and
    // an on-chain forward — far longer than any delivery timeout. Holding the
    // response open would earn a retry for a deposit already being handled.
    // Duplicate delivery is safe regardless (processDeposit dedupes on the tx
    // hash), but not inviting it is better than relying on that.
    res.json({ ok: true });

    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const ev of events) {
      try {
        await handleHeliusEvent(ev);
      } catch (e) {
        console.error('[helius webhook] event failed:', e.message);
      }
    }
  });

  // Mints, as base58 strings — the webhook payload carries a string, and
  // chainSend holds these as PublicKey objects.
  const MINT_TO_COIN = {
    [USDC_MINT.toBase58()]: 'usdc',
    [USDT_MINT.toBase58()]: 'usdt',
  };

  async function handleHeliusEvent(ev) {
    const signature = ev?.signature;
    if (!signature) return;

    // Every credit this event describes, as { address, coin, amount }. Read
    // from the enriched payload rather than the raw transaction, which is the
    // point of using the enhanced webhook type — the alternative is parsing
    // instructions here, a second copy of what the poller already does.
    const credits = [];

    for (const t of ev.nativeTransfers || []) {
      // lamports. A transfer TO one of our addresses only; the same event also
      // describes the sender's side, and the sweep we make afterwards.
      if (!t?.toUserAccount || !(t.amount > 0)) continue;
      credits.push({ address: t.toUserAccount, coin: 'sol', amount: t.amount / 1e9 });
    }

    for (const t of ev.tokenTransfers || []) {
      const coin = MINT_TO_COIN[t?.mint];
      if (!coin || !t?.toUserAccount) continue;
      // toUserAccount is the OWNER wallet, not the associated token account,
      // which is why registering the wallet address covers SPL as well as SOL.
      const amount = Number(t.tokenAmount);
      if (!(amount > 0)) continue;
      credits.push({ address: t.toUserAccount, coin, amount });
    }

    if (credits.length === 0) return;

    // One lookup for the addresses this event actually touched, rather than
    // per credit — a single transaction can carry several.
    const wanted = [...new Set(credits.map(c => c.address))];
    const { data: rows, error } = await supabase
      .from('deposit_addresses')
      .select('user_id, coin, address')
      .in('address', wanted);
    if (error) {
      // Thrown, not swallowed: a lookup failure means we do not know whether
      // this was a deposit, and the polling backstop is what catches it.
      throw new Error(`address lookup failed: ${error.message}`);
    }

    const owners = new Map();
    for (const r of rows || []) owners.set(r.address, r.user_id);

    for (const c of credits) {
      const userId = owners.get(c.address);
      // Not one of ours. Helius reports the whole transaction, so this is the
      // normal case for the other side of any transfer.
      if (!userId) continue;
      await processDeposit(supabase, {
        userId,
        coin:    c.coin,
        address: c.address,
        txHash:  signature,
        amount:  c.amount,
      });
    }
  }

  return router;
};
