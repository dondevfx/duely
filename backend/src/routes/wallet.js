const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  getBalance, creditCoins, deductCoins,
  getDiamondBalance, creditDiamonds, deductDiamonds,
  sanitizeAmount, sanitizeDiamondAmount,
  VALID_COINS, MAX_SINGLE_AMOUNT,
  recordWithdrawal, getWithdrawable,
} = require('../services/walletService');
const { getOrCreateAddress } = require('../services/addressService');
const { sendCrypto }         = require('../services/chainSend');
const { createWithdrawalSwap, estimateWithdrawal, SS_TICKERS } = require('../services/simpleSwapService');
const { isLocked } = require('../services/lockService');

const WITHDRAW_COOLDOWN_MS = 60 * 1000;   // 60s between withdrawals
const DEPOSIT_MAX_SINGLE   = 50_000;      // $50k hard cap per deposit
const MIN_WITHDRAWAL       = 5;           // $5 minimum

// Coins accepted for deposit (Plisio supports all of these)
const DEPOSIT_COINS = new Set(['btc','eth','sol','ltc','trx','doge','bnb','usdc']);

// Per-coin deposit minimums enforced by our platform
const DEPOSIT_MINS = {
  usdttrc20: 10,   // $10 — USDT TRC-20 cross-network swap is expensive
  default:    5,   // $5 for all other coins
};

// Basic address validation — Plisio/SimpleSwap do real validation
const ADDRESS_RE = /^[a-zA-Z0-9_:.\-]{10,128}$/;
function validateAddress(addr) {
  return addr && typeof addr === 'string' && ADDRESS_RE.test(addr.trim());
}
function validateMemo(val) {
  if (!val) return true;
  return /^[a-zA-Z0-9_.\-]{1,64}$/.test(String(val).trim());
}

async function getLastWithdrawal(supabase, userId) {
  const { data } = await supabase
    .from('transactions')
    .select('created_at')
    .eq('user_id', userId)
    .eq('type', 'withdrawal')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0]?.created_at || null;
}

module.exports = function walletRoutes(supabase) {
  const router = Router();

  // ── Withdrawable amounts per source ──────────────────────────────────
  router.get('/withdrawable', requireAuth, async (req, res) => {
    try {
      const w = await getWithdrawable(supabase, req.user.id);
      res.json(w);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Balance ───────────────────────────────────────────────────────────
  router.get('/balance', requireAuth, async (req, res) => {
    try {
      const balance = await getBalance(supabase, req.user.id);
      res.json({ c_coins: balance });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get deposit address (Plisio permanent address) ────────────────────
  // Returns the same address every time for a given user + coin — no expiry.
  // Player sends any amount; webhook credits what arrives after fees.
  router.post('/get-address', requireAuth, async (req, res) => {
    const { coin } = req.body;
    if (!coin || !DEPOSIT_COINS.has(coin.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid or unsupported coin' });
    }
    try {
      const result = await getOrCreateAddress(req.user.id, coin.toLowerCase(), supabase);
      res.json({
        address:  result.address,
        memo:     result.memo || null,
        coin:     coin.toLowerCase(),
        min_usd:  DEPOSIT_MINS[coin.toLowerCase()] ?? DEPOSIT_MINS.default,
      });
    } catch (err) {
      console.error(`[deposit] get-address failed coin=${coin}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Deposit minimums (static — no API call needed) ────────────────────
  router.get('/min-deposit', requireAuth, async (req, res) => {
    const coin = req.query.coin?.toLowerCase();
    if (!coin || !DEPOSIT_COINS.has(coin)) {
      return res.status(400).json({ error: 'Invalid coin' });
    }
    res.json({ min_usd: DEPOSIT_MINS[coin] ?? DEPOSIT_MINS.default });
  });

  // ── Withdraw via SimpleSwap (any coin → player's address) ─────────────
  router.post('/withdraw', requireAuth, async (req, res) => {
    if (!req.user.email_confirmed_at) {
      return res.status(403).json({ error: 'Please verify your email before withdrawing.' });
    }
    if (isLocked(req.user.id)) {
      return res.status(400).json({ error: 'Cannot withdraw while in a queue or active match' });
    }

    const { coin, address, memo } = req.body;

    // Validate coin — any SimpleSwap-supported coin
    if (!coin || !SS_TICKERS[coin.toLowerCase()]) {
      return res.status(400).json({ error: 'Invalid or unsupported withdrawal coin' });
    }
    if (!validateAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }
    if (!validateMemo(memo)) {
      return res.status(400).json({ error: 'Invalid memo / destination tag' });
    }

    let amount;
    try { amount = sanitizeAmount(req.body.amountUsd, MIN_WITHDRAWAL, MAX_SINGLE_AMOUNT); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    if (amount < MIN_WITHDRAWAL) {
      return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WITHDRAWAL}.` });
    }

    try {
      // ── Rate limit ───────────────────────────────────────────────────
      const lastWit = await getLastWithdrawal(supabase, req.user.id);
      if (lastWit && Date.now() - new Date(lastWit).getTime() < WITHDRAW_COOLDOWN_MS) {
        const waitSec = Math.ceil(
          (WITHDRAW_COOLDOWN_MS - (Date.now() - new Date(lastWit).getTime())) / 1000
        );
        return res.status(429).json({ error: `Please wait ${waitSec}s before withdrawing again` });
      }

      // ── Source limit ─────────────────────────────────────────────────
      const withdrawable = await getWithdrawable(supabase, req.user.id);
      if (amount > withdrawable.crypto) {
        return res.status(400).json({
          error: `Crypto withdrawable: $${withdrawable.crypto.toFixed(2)}. Non-crypto balance cannot be withdrawn to crypto.`,
        });
      }

      // ── Balance check ────────────────────────────────────────────────
      const balance = await getBalance(supabase, req.user.id);
      if (balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // ── Create SimpleSwap exchange (USDC SPL → player's coin) ────────
      // We tell SimpleSwap to swap `amount` USDC → player's coin.
      // SimpleSwap takes ~0.5% + network fee from the output — player receives less.
      // Plisio also takes 0.5% on the outgoing USDC payout — also comes from amount.
      // We deduct the full `amount` from the player's balance.
      // After both fees: player receives roughly `amount * 0.990` worth of coin.
      const swap = await createWithdrawalSwap({
        coin:          coin.toLowerCase(),
        amountUsd:     amount,
        playerAddress: address.trim(),
        playerMemo:    memo?.trim() || '',
      });

      // Deduct the full amount from player balance
      await deductCoins(supabase, req.user.id, amount);

      // ── Send our USDC to SimpleSwap from our self-hosted USDC wallet ────
      const usdcAddr = process.env.USDC_SPL_ADDRESS;
      let payoutId = null;
      try {
        const { getAddress } = require('../services/addressService');
        const { privKey: usdcPrivKey } = getAddress(process.env.ADMIN_USER_ID, 'sol');
        const sendTx = await sendCrypto({
          coin:      'sol',       // USDC is on SOL network
          privKey:   usdcPrivKey,
          toAddress: swap.depositAddress,
          amount:    amount,
        });
        payoutId = sendTx;
      } catch (payoutErr) {
        // Payout failed — refund the deducted balance immediately
        await creditCoins(supabase, req.user.id, amount).catch(e =>
          console.error(`CRITICAL: refund failed user=${req.user.id} amount=${amount}:`, e.message)
        );
        return res.status(500).json({ error: `Payout failed: ${payoutErr.message}` });
      }

      // ── Record transaction ───────────────────────────────────────────
      await supabase.from('transactions').insert({
        user_id:        req.user.id,
        type:           'withdrawal',
        amount_c:       amount,
        crypto_amount:  swap.expectedOutput,
        crypto_symbol:  coin.toUpperCase(),
        tx_hash:        payoutId ? String(payoutId) : swap.exchangeId,
        extra_id:       memo?.trim() || null,
        status:         'pending',
      });

      await recordWithdrawal(supabase, req.user.id, amount, 'crypto').catch(e =>
        console.error('recordWithdrawal failed:', e.message)
      );

      const newBalance = await getBalance(supabase, req.user.id);
      res.json({
        success:         true,
        expected_output: swap.expectedOutput,
        coin:            coin.toUpperCase(),
        new_balance:     newBalance,
      });

    } catch (err) {
      const isBalanceError = err.message?.includes('Insufficient');
      res.status(isBalanceError ? 400 : 500).json({ error: err.message });
    }
  });

  // ── Estimate withdrawal output ────────────────────────────────────────
  router.get('/estimate-withdrawal', requireAuth, async (req, res) => {
    const coin = req.query.coin?.toLowerCase();
    if (!coin || !SS_TICKERS[coin]) {
      return res.status(400).json({ error: 'Invalid coin' });
    }
    let amount;
    try { amount = sanitizeAmount(req.query.amountUsd, 0.01, DEPOSIT_MAX_SINGLE); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const estimated = await estimateWithdrawal(coin, amount);
      res.json({ estimated_amount: estimated, coin });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tip ───────────────────────────────────────────────────────────────
  router.post('/tip', requireAuth, async (req, res) => {
    if (isLocked(req.user.id)) {
      return res.status(400).json({ error: 'Cannot tip while in a queue or active match' });
    }
    const { recipientUsername, currency = 'coins' } = req.body;
    const isDiamonds = currency === 'diamonds';

    if (!recipientUsername || typeof recipientUsername !== 'string') {
      return res.status(400).json({ error: 'recipientUsername required' });
    }

    let tipAmount;
    try {
      tipAmount = isDiamonds
        ? sanitizeDiamondAmount(req.body.amount, 1, 1_000_000)
        : sanitizeAmount(req.body.amount, 0.01, MAX_SINGLE_AMOUNT);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { data: recipient } = await supabase
      .from('profiles').select('id, username').eq('username', recipientUsername.trim()).single();
    if (!recipient) return res.status(404).json({ error: 'User not found' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'You cannot tip yourself' });

    try {
      if (isDiamonds) {
        await deductDiamonds(supabase, req.user.id, tipAmount);
        await creditDiamonds(supabase, recipient.id, tipAmount);
        supabase.from('transactions').insert([
          { user_id: req.user.id,   type: 'tip_sent',     amount_c: 0, crypto_amount: tipAmount, crypto_symbol: 'diamonds', status: 'confirmed' },
          { user_id: recipient.id,  type: 'tip_received', amount_c: 0, crypto_amount: tipAmount, crypto_symbol: 'diamonds', status: 'confirmed' },
        ]).then().catch(e => console.error('[tx] diamond tip insert failed:', e.message));
      } else {
        await deductCoins(supabase, req.user.id, tipAmount);
        await creditCoins(supabase, recipient.id, tipAmount);
        supabase.from('transactions').insert([
          { user_id: req.user.id,   type: 'tip_sent',     amount_c: tipAmount, status: 'confirmed' },
          { user_id: recipient.id,  type: 'tip_received', amount_c: tipAmount, status: 'confirmed' },
        ]).then().catch(e => console.error('[tx] coin tip insert failed:', e.message));
      }
      res.json({ success: true, recipient: recipient.username, amount: tipAmount, currency });
    } catch (err) {
      const isBalanceError = err.message?.includes('Insufficient');
      res.status(isBalanceError ? 400 : 500).json({ error: err.message });
    }
  });

  // ── Transaction history ───────────────────────────────────────────────
  router.get('/transactions', requireAuth, async (req, res) => {
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit)  || 200));
    const offset = Math.max(0,              parseInt(req.query.offset) || 0);
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  return router;
};
