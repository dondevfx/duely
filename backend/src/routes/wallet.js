const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  getBalance, creditCoins, deductCoins,
  getDiamondBalance, creditDiamonds, deductDiamonds,
  sanitizeAmount, sanitizeDiamondAmount,
  VALID_COINS, MAX_SINGLE_AMOUNT,
  recordWithdrawal, getWithdrawable,
} = require('../services/walletService');
const { createPayment, getEstimate, createPayout, getMinAmount, getCoinUsdEstimate } = require('../services/nowPaymentsService');
const { isLocked } = require('../services/lockService');

const WITHDRAW_COOLDOWN_MS    = 60 * 1000;    // 60 seconds between withdrawals
const DEPOSIT_MAX_SINGLE      = 50000;        // $50,000 hard cap per deposit

// Basic address sanity check — non-empty, reasonable length, no whitespace/injections.
// NOWPayments does the real validation; this just blocks obviously bad input.
const ADDRESS_RE = /^[a-zA-Z0-9_:.\-]{10,128}$/;

function validateAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  return ADDRESS_RE.test(addr.trim());
}

function validateExtraId(val) {
  if (!val) return true; // optional
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

// Returns NowPayments' real minimum deposit in USD for a coin (+10% buffer)
async function getRealMinUsd(coin) {
  const minData = await getMinAmount(coin);
  const minCoin = parseFloat(minData.min_amount ?? 0);
  if (!minCoin || minCoin <= 0) return 5;
  const usdData = await getCoinUsdEstimate(minCoin, coin);
  return Math.ceil(parseFloat(usdData.estimated_amount ?? 5) * 1.1);
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

  // ── Create crypto deposit (NOWPayments) ───────────────────────────────
  router.post('/create-payment', requireAuth, async (req, res) => {
    const { coin, amountUsd } = req.body;

    if (!coin || !VALID_COINS.has(coin)) {
      return res.status(400).json({ error: 'Invalid or unsupported coin' });
    }

    const orderId = `dep_${req.user.id}_${Date.now()}`;
    try {
      // Use NowPayments' real minimum for this coin so the order never gets rejected.
      // is_fixed_rate:false means the user can send any amount above this minimum —
      // the webhook credits outcome_amount (what actually arrives).
      let minUsd = 5;
      try { minUsd = await getRealMinUsd(coin); } catch (_) { /* fall back to $5 */ }

      const payment = await createPayment({ amountUsd: minUsd, coin, orderId });
      res.json({
        payment_id:   payment.payment_id,
        pay_address:  payment.pay_address,
        pay_amount:   payment.pay_amount,
        pay_currency: payment.pay_currency,
        extra_id:     payment.extra_id || null,
        expires_at:   payment.expiration_estimate_date || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Withdraw via NOWPayments payout ───────────────────────────────────
  router.post('/withdraw', requireAuth, async (req, res) => {
    if (!req.user.email_confirmed_at) {
      return res.status(403).json({ error: 'Please verify your email before withdrawing.' });
    }
    if (isLocked(req.user.id)) {
      return res.status(400).json({ error: 'Cannot withdraw while in a queue or active match' });
    }
    const { coin, address, extraId } = req.body;

    // Validate coin
    if (!coin || !VALID_COINS.has(coin)) {
      return res.status(400).json({ error: 'Invalid or unsupported coin' });
    }

    // Validate address
    if (!validateAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Validate extraId (XRP tag / ADA memo)
    if (!validateExtraId(extraId)) {
      return res.status(400).json({ error: 'Invalid destination tag or memo' });
    }

    // Validate amount
    let amount;
    try { amount = sanitizeAmount(req.body.amountUsd, 5, MAX_SINGLE_AMOUNT); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    if (amount < 5) return res.status(400).json({ error: 'Minimum withdrawal is 5 coins.' });

    try {
      // ── Rate limit: 60-second cooldown ──────────────────────────────
      const lastWit = await getLastWithdrawal(supabase, req.user.id);
      if (lastWit && Date.now() - new Date(lastWit).getTime() < WITHDRAW_COOLDOWN_MS) {
        const waitSec = Math.ceil((WITHDRAW_COOLDOWN_MS - (Date.now() - new Date(lastWit).getTime())) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSec}s before withdrawing again` });
      }

      // ── Source limit: can only withdraw up to what was crypto-deposited ──
      const withdrawable = await getWithdrawable(supabase, req.user.id);
      if (amount > withdrawable.crypto) {
        return res.status(400).json({
          error: `Crypto withdrawable: $${withdrawable.crypto.toFixed(2)}. Card deposits must be withdrawn to your bank account.`,
        });
      }

      // ── Balance check ────────────────────────────────────────────────
      const balance = await getBalance(supabase, req.user.id);
      if (balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // ── Get crypto estimate ──────────────────────────────────────────
      const estimate = await getEstimate(amount, coin);
      const cryptoAmount = parseFloat(estimate.estimated_amount);
      if (!cryptoAmount || cryptoAmount <= 0) {
        return res.status(400).json({ error: 'Could not estimate payout amount' });
      }

      // ── Deduct coins atomically (DB throws if balance is now insufficient) ──
      await deductCoins(supabase, req.user.id, amount);

      // ── Process payout via NOWPayments ───────────────────────────────
      let payoutId = null;
      try {
        const payout = await createPayout({
          address:  address.trim(),
          coin,
          amount:   cryptoAmount,
          extraId:  extraId?.trim() || undefined,
        });
        payoutId = payout?.withdrawals?.[0]?.id || payout?.id || null;
      } catch (payoutErr) {
        // Deduction happened but payout failed — refund immediately
        await creditCoins(supabase, req.user.id, amount).catch(refundErr => {
          console.error(`CRITICAL: refund failed for user ${req.user.id} amount ${amount}:`, refundErr.message);
        });
        return res.status(500).json({ error: `Payout failed: ${payoutErr.message}` });
      }

      await supabase.from('transactions').insert({
        user_id:       req.user.id,
        type:          'withdrawal',
        amount_c:      amount,
        crypto_amount: cryptoAmount,
        crypto_symbol: coin.toUpperCase(),
        tx_hash:       payoutId ? String(payoutId) : null,
        extra_id:      extraId?.trim() || null,
        status:        payoutId ? 'pending' : 'pending_manual',
      });

      await recordWithdrawal(supabase, req.user.id, amount, 'crypto').catch(e =>
        console.error('recordWithdrawal(crypto) failed:', e.message)
      );

      const newBalance = await getBalance(supabase, req.user.id);
      res.json({ success: true, crypto_amount: cryptoAmount, coin, new_balance: newBalance });

    } catch (err) {
      const isBalanceError = err.message?.includes('Insufficient');
      res.status(isBalanceError ? 400 : 500).json({ error: err.message });
    }
  });

  // ── Minimum deposit in USD for a given coin ──────────────────────────
  router.get('/min-deposit', requireAuth, async (req, res) => {
    const { coin } = req.query;
    if (!coin || !VALID_COINS.has(coin)) {
      return res.status(400).json({ error: 'Invalid coin' });
    }
    try {
      const minUsd = await getRealMinUsd(coin);
      res.json({ min_usd: minUsd });
    } catch {
      res.json({ min_usd: 5 });
    }
  });

  // ── Get crypto estimate (frontend preview) ────────────────────────────
  router.get('/estimate', requireAuth, async (req, res) => {
    const { coin } = req.query;
    if (!coin || !VALID_COINS.has(coin)) {
      return res.status(400).json({ error: 'Invalid coin' });
    }
    let amount;
    try { amount = sanitizeAmount(req.query.amountUsd, 0.01, DEPOSIT_MAX_SINGLE); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const data = await getEstimate(amount, coin);
      res.json({ estimated_amount: data.estimated_amount, coin });
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
          { user_id: req.user.id, type: 'tip_sent',     amount_c: 0, crypto_amount: tipAmount, crypto_symbol: 'diamonds', status: 'confirmed' },
          { user_id: recipient.id, type: 'tip_received', amount_c: 0, crypto_amount: tipAmount, crypto_symbol: 'diamonds', status: 'confirmed' },
        ]).then().catch(e => console.error('[tx] diamond tip insert failed:', e.message));
      } else {
        await deductCoins(supabase, req.user.id, tipAmount);
        await creditCoins(supabase, recipient.id, tipAmount);
        supabase.from('transactions').insert([
          { user_id: req.user.id,  type: 'tip_sent',     amount_c: tipAmount, status: 'confirmed' },
          { user_id: recipient.id, type: 'tip_received', amount_c: tipAmount, status: 'confirmed' },
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
