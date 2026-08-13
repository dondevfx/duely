const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { isDemo } = require('../services/demoAccounts');
const {
  getBalance, creditCoins, deductCoins,
  getDiamondBalance, creditDiamonds, deductDiamonds,
  sanitizeAmount, sanitizeDiamondAmount,
  MAX_SINGLE_AMOUNT,
  recordWithdrawal, getWithdrawable,
} = require('../services/walletService');
const { getOrCreateAddress } = require('../services/addressService');
const { sendCrypto }         = require('../services/chainSend');
const { createWithdrawalSwap, estimateWithdrawal, SS_TICKERS } = require('../services/simpleSwapService');
const { isValidAddressFor } = require('../services/addressValidator');
const { swapUsdcToSol }      = require('../services/jupiterService');
const { isLocked } = require('../services/lockService');
const cryptomus = require('../services/cryptomusService');

const WITHDRAW_COOLDOWN_MS = 60 * 1000;   // 60s between withdrawals
const activeWithdrawals = new Set();       // in-memory per-user lock to prevent concurrent withdrawals
const DEPOSIT_MAX_SINGLE   = 50_000;      // $50k hard cap per deposit

// ── Tip ceilings ──────────────────────────────────────────────────────────
// Diamonds are not withdrawable — getWithdrawable only ever reads c_coins — so
// a diamond tip cannot become money and the ceiling is a UX choice, not a
// safety one.
//
// Coins ARE withdrawable, and a tip is the softest path out of an account:
// withdrawals require a verified email, an MFA-elevated session when MFA is
// enabled, and a 60s cooldown, while a tip requires none of those. Whoever
// takes over an account can move the balance to one they control and withdraw
// from there under their own MFA, so this ceiling is the blast radius of a
// single compromised request. The largest coin match is $100; $1,000 leaves
// generous headroom for real tipping while cutting that radius tenfold.
const MAX_TIP_COINS    = 1_000;
const MAX_TIP_DIAMONDS = 100_000_000;

// Per-coin withdrawal minimums
// SOL/USDC go direct (Jupiter / SPL send) — no ChangeNow minimum
// Everything else goes through ChangeNow — keep $5 to cover their minimums
const WITHDRAW_MINS = {
  sol:     5,
  usdc:    5,
  default: 10,  // BTC, ETH, BNB, LTC, TRX, DOGE — ChangeNow minimum
};
const MIN_WITHDRAWAL = 10;   // fallback

// Coins accepted for deposit (Plisio supports all of these)
const DEPOSIT_COINS = new Set(['btc','eth','sol','ltc','trx','doge','bnb','usdc']);

// Per-coin deposit minimums shown in UI (must match the frontend coin grid).
// Actual crediting is more generous — anything that nets >= $3 in USDC is
// credited (see MIN_CREDIT_USD in blockchainMonitor / swapPoller).
// Set from the real numbers rather than by feel. Three things eat a deposit:
// the gas reserve held back to forward it, ChangeNow's spread and output fee
// (~3%), and their swap minimum — which measured at about $2 per coin, far
// below any figure here. The binding constraint is MIN_CREDIT_USD ($3): land
// under it and the player is credited NOTHING, so a minimum must clear $3 with
// room to spare.
//
// At $5, after gas and ~3%, each credits: ETH $4.12, LTC $4.81, DOGE $4.78,
// TRX $4.20 (with the reduced reserve), BNB $4.55, SOL $4.73.
//
// BTC stays at $10. Its reserve alone is ~$1.27, so $5 would credit ~$3.62 —
// 60c above the floor, and both BTC's price and its fee rate move enough to
// close that gap. A deposit that credits zero is the worst outcome available.
const DEPOSIT_MINS = {
  sol:     5,
  usdc:    5,   // direct credit, no swap in the path
  btc:     10,
  default: 5,   // ETH, BNB, LTC, TRX, DOGE
};

// Basic address validation — Plisio/SimpleSwap do real validation
// Address validation is per-chain and checksum-verified — see addressValidator.
// The old check was a single character-class regex, which happily accepted a
// Bitcoin address as a Solana destination or an address with a typo in it.
function validateAddress(addr, coin) {
  return isValidAddressFor(coin, addr);
}
function validateMemo(val) {
  if (!val) return true;
  return /^[a-zA-Z0-9_.\-]{1,64}$/.test(String(val).trim());
}

// Read the AAL (authenticator assurance level) claim from a Bearer token.
// 'aal2' means the session passed an MFA challenge; 'aal1' means password-only.
function tokenAal(authHeader) {
  try {
    const token = (authHeader || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.aal || null;
  } catch { return null; }
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

module.exports = function walletRoutes(supabase, io) {
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

  // ── Card on-ramp ──────────────────────────────────────────────────────
  //
  // Nothing is credited here. The provider sends USDC on-chain to the player's
  // own deposit address and blockchainMonitor credits it on its next poll, like
  // any other deposit — so a new provider only ever needs a URL builder, never
  // a new money path.
  //
  // Whichever provider has keys wins; none configured means the button never
  // renders. MoonPay was removed after they declined onboarding.
  function onrampProvider() {
    if (cryptomus.isConfigured()) return 'cryptomus';
    return null;
  }

  router.get('/onramp-config', requireAuth, async (req, res) => {
    const provider = onrampProvider();
    res.json({
      enabled:  Boolean(provider) && !isDemo(req.user.id),
      provider,
      minUsd:   DEPOSIT_MINS.usdc,
    });
  });

  router.get('/onramp-url', requireAuth, async (req, res) => {
    if (isDemo(req.user.id)) return res.status(403).json({ error: 'Demo accounts cannot deposit.' });
    const provider = onrampProvider();
    if (!provider) return res.status(501).json({ error: 'Card deposits are not enabled yet.' });

    let amountUsd = null;
    if (req.query.amountUsd != null && req.query.amountUsd !== '') {
      try { amountUsd = sanitizeAmount(req.query.amountUsd, DEPOSIT_MINS.usdc, DEPOSIT_MAX_SINGLE); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }

    // FRONTEND_URL is a comma-separated CORS allowlist, so take the first origin
    // or the return URL is malformed whenever more than one is listed.
    const returnUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL.split(',')[0]}/wallet` : undefined;

    try {
      const { url } = await cryptomus.createInvoice({
        // Cryptomus prices the checkout up front, so an amount is required.
        amountUsd: amountUsd || DEPOSIT_MINS.usdc,
        userId: req.user.id,
        returnUrl,
      });
      res.json({ url, provider, minUsd: DEPOSIT_MINS.usdc });
    } catch (err) {
      console.error('[onramp] url build failed:', err.message);
      res.status(500).json({ error: 'Could not start card purchase.' });
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
    if (isDemo(req.user.id)) return res.status(403).json({ error: 'Demo accounts cannot withdraw.' });
    if (!req.user.email_confirmed_at) {
      return res.status(403).json({ error: 'Please verify your email before withdrawing.' });
    }

    // MFA step-up enforcement: if the account has a verified authenticator, the
    // withdrawal must come from an MFA-elevated (aal2) session. Without this the
    // client-side MFA prompt is bypassable — a stolen aal1 token could withdraw
    // directly via the API. Fails open on lookup error (defense-in-depth; the
    // JWT auth is still required) so a transient error can't hard-block payouts.
    try {
      if (tokenAal(req.headers.authorization) !== 'aal2') {
        const { data: u } = await supabase.auth.admin.getUserById(req.user.id);
        const hasMfa = (u?.user?.factors || []).some(f => f.status === 'verified');
        if (hasMfa) {
          return res.status(403).json({ error: 'Verify with your authenticator app to withdraw.', mfaRequired: true });
        }
      }
    } catch (e) {
      console.error('[withdraw] MFA/aal check error (allowing):', e.message);
    }
    if (isLocked(req.user.id)) {
      return res.status(400).json({ error: 'Cannot withdraw while in a queue or active match' });
    }
    if (activeWithdrawals.has(req.user.id)) {
      return res.status(429).json({ error: 'A withdrawal is already in progress' });
    }

    const { coin, address, memo } = req.body;

    // Validate coin — any SimpleSwap-supported coin.
    // NOTE: all of these early-return validations run BEFORE the in-flight lock
    // is acquired below. Acquiring the lock earlier leaked it on every validation
    // failure (no delete on those returns), permanently locking the user out of
    // withdrawing until server restart. These checks are synchronous, so no
    // concurrent request can slip through before the lock is set.
    if (!coin || !SS_TICKERS[coin.toLowerCase()]) {
      return res.status(400).json({ error: 'Invalid or unsupported withdrawal coin' });
    }
    if (!validateAddress(address, coin)) {
      return res.status(400).json({
        error: `That does not look like a valid ${coin.toUpperCase()} address. Check it and try again.`,
      });
    }
    if (!validateMemo(memo)) {
      return res.status(400).json({ error: 'Invalid memo / destination tag' });
    }

    const coinMin = WITHDRAW_MINS[coin.toLowerCase()] ?? WITHDRAW_MINS.default;

    let amount;
    try { amount = sanitizeAmount(req.body.amountUsd, coinMin, MAX_SINGLE_AMOUNT); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    if (amount < coinMin) {
      return res.status(400).json({ error: `Minimum withdrawal is $${coinMin}.` });
    }

    // Acquire the in-flight lock only after all validation has passed, so a
    // rejected request never leaves the user locked. Released in `finally`.
    activeWithdrawals.add(req.user.id);

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

      // ── Decode admin private key ─────────────────────────────────────
      const bs58 = require('bs58');
      const phantomKey = process.env.ADMIN_PHANTOM_PRIVATE_KEY;
      if (!phantomKey) throw new Error('ADMIN_PHANTOM_PRIVATE_KEY not set');
      const decoded = (bs58.default?.decode ?? bs58.decode)(phantomKey);
      const privKey = Buffer.from(decoded).slice(0, 32);

      // Deduct upfront so coins can't be used while payout is in flight.
      // If payout fails we refund immediately. If the refund itself fails we
      // throw so the outer handler returns 500 — the CRITICAL log stays for
      // manual recovery, but the user sees an error rather than silent loss.
      await deductCoins(supabase, req.user.id, amount);

      let payoutId  = null;
      let cryptoAmt = null;

      try {
        if (coin.toLowerCase() === 'sol') {
          const { txHash, solReceived } = await swapUsdcToSol(privKey, amount, address.trim());
          payoutId  = txHash;
          cryptoAmt = solReceived;
          console.log(`[withdraw] Jupiter SOL payout ${amount} USDC → ${solReceived} SOL → ${address.trim()} tx=${txHash}`);

        } else if (coin.toLowerCase() === 'usdc') {
          const sendTx = await sendCrypto({
            coin:      'usdc',
            privKey,
            toAddress: address.trim(),
            amount,
          });
          payoutId  = sendTx;
          cryptoAmt = amount;
          console.log(`[withdraw] Direct USDC send ${amount} → ${address.trim()} tx=${sendTx}`);

        } else {
          const swap = await createWithdrawalSwap({
            coin:          coin.toLowerCase(),
            amountUsd:     amount,
            playerAddress: address.trim(),
            playerMemo:    memo?.trim() || '',
          });
          cryptoAmt = swap.estimatedOutput;

          const sendTx = await sendCrypto({
            coin:      'usdc',
            privKey,
            toAddress: swap.depositAddress,
            amount,
          });
          payoutId = sendTx || swap.exchangeId;
          console.log(`[withdraw] ChangeNow payout ${amount} USDC → ${coin} → ${address.trim()} exchange=${swap.exchangeId}`);
        }

      } catch (payoutErr) {
        console.error(`[withdraw] payout failed user=${req.user.id} amount=${amount}:`, payoutErr.message);

        // A failed withdrawal must leave a ROW, not just a log line.
        //
        // Previously the only trace was console output: the refund path wrote
        // nothing, so a withdrawal that failed was invisible to any query and
        // recoverable only by scrolling Railway logs. Which also meant the
        // admin dashboard's "pending withdrawals" counter — which looks for
        // status 'pending' — was permanently zero, because nothing ever wrote
        // that status.
        //
        // Best-effort inserts: if the database is itself the reason the payout
        // failed, this will not land either. The console line therefore stays
        // as the last resort.
        const recordFailure = (status, err) =>
          supabase.from('transactions').insert({
            user_id:       req.user.id,
            type:          'withdrawal',
            amount_c:      amount,
            crypto_symbol: coin.toUpperCase(),
            extra_id:      address.trim().slice(0, 64),
            status,
            notes:         String(err).slice(0, 300),
          }).then().catch(e => console.error('[withdraw] failure row insert failed:', e.message));

        try {
          await creditCoins(supabase, req.user.id, amount);
          // Refunded — the player is whole. Recorded so support can explain
          // what happened rather than guessing from a missing row.
          await recordFailure('failed', payoutErr.message);
        } catch (refundErr) {
          // The bad one: coins deducted, payout failed, refund failed. This is
          // real money owed to a real person, so it gets its own status and
          // shows at the top of the admin attention queue.
          console.error(`CRITICAL: refund failed user=${req.user.id} amount=${amount} — manual credit required:`, refundErr.message);
          await recordFailure('refund_failed', `payout: ${payoutErr.message} | refund: ${refundErr.message}`);
          throw new Error(`Payout failed and refund failed — contact support. Payout error: ${payoutErr.message}`);
        }
        return res.status(500).json({ error: `Payout failed: ${payoutErr.message}` });
      }

      // ── Record transaction ───────────────────────────────────────────
      await supabase.from('transactions').insert({
        user_id:       req.user.id,
        type:          'withdrawal',
        amount_c:      amount,
        crypto_amount: cryptoAmt,
        crypto_symbol: coin.toUpperCase(),
        tx_hash:       String(payoutId),
        extra_id:      memo?.trim() || null,
        status:        'confirmed',
      });

      await recordWithdrawal(supabase, req.user.id, amount, 'crypto').catch(e =>
        console.error('recordWithdrawal failed:', e.message)
      );

      const newBalance = await getBalance(supabase, req.user.id);
      res.json({ success: true, new_balance: newBalance });

    } catch (err) {
      const isBalanceError = err.message?.includes('Insufficient');
      res.status(isBalanceError ? 400 : 500).json({ error: err.message });
    } finally {
      activeWithdrawals.delete(req.user.id);
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
        ? sanitizeDiamondAmount(req.body.amount, 1, MAX_TIP_DIAMONDS)
        : sanitizeAmount(req.body.amount, 0.01, MAX_TIP_COINS);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { data: recipient } = await supabase
      .from('profiles').select('id, username').eq('username', recipientUsername.trim()).single();
    if (!recipient) return res.status(404).json({ error: 'User not found' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'You cannot tip yourself' });
    if (isDemo(req.user.id) || isDemo(recipient.id)) return res.status(403).json({ error: 'Demo accounts cannot send or receive tips.' });

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
      // Notify recipient in real time if they're connected
      if (io) {
        for (const [, sock] of io.sockets.sockets) {
          if (sock._authenticatedUserId === recipient.id) {
            sock.emit('tip_received', { amount: tipAmount, currency, from: req.user.username || 'Someone' });
            break;
          }
        }
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
