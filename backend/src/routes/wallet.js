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
const { sendCrypto, checkSolanaSignature } = require('../services/chainSend');
const { createWithdrawalSwap, estimateWithdrawal, getWithdrawalMinUsd, SS_TICKERS } = require('../services/simpleSwapService');
const { isValidAddressFor } = require('../services/addressValidator');
const { swapUsdcToSol, swapUsdcToUsdt } = require('../services/jupiterService');
const { isLocked } = require('../services/lockService');
const cryptomus = require('../services/cryptomusService');
const fiatPay = require('../services/fiatPayouts');
const fiatCfg = require('../services/fiatConfig');
const payoutWatcher = require('../services/payoutWatcher');
const { validateBankDetails, maskAccountNumber } = require('../services/bankValidator');

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

// Per-coin withdrawal minimums.
//
// $5 everywhere except BTC, whose network fee is a real fraction of a small
// payout — at $5 the player would receive noticeably less than they asked for.
//
// These are OUR floors. ChangeNow has its own, per coin, and it moves with
// network fees — it is routinely higher than $5 for ETH. Lowering our floor
// without checking theirs would just move the failure later, into a payout that
// deducts, fails and refunds. So the handler asks them before taking any coins.
const WITHDRAW_MINS = {
  btc:     10,
  default: 5,   // SOL, USDC, ETH, BNB, LTC, TRX, DOGE
};

// Shared with the blockchain monitor, so disabling a coin stops the poller
// too rather than leaving it warning about an address nobody can deposit to.
const { DEPOSIT_COINS } = require('../services/coinConfig');

// Paid out by us, on Solana, with no exchange in the path:
//   SOL   USDC → SOL on Jupiter, then send
//   USDC  sent straight from the payout wallet
//   USDT  USDC → USDT on Jupiter, then send
//
// These skip ChangeNow's minimum check entirely. Enforcing an exchange's floor
// on a payout that never touches that exchange would reject withdrawals for no
// reason — their USDC→coin minimum is about their costs, not ours.
const DIRECT_PAYOUT_COINS = new Set(['sol', 'usdc', 'usdt']);

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
  usdt:    5,   // same — a dollar stablecoin on the same chain
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
  // ── Guards every withdrawal shares, whatever the rail ────────────────────
  //
  // One implementation, used by both the crypto and the fiat route. These are
  // the checks that decide whether this person may take money out AT ALL —
  // they have nothing to do with which rail carries it, so a second copy would
  // only ever be a second thing to keep in step. Two near-identical copies of
  // one rule is how ETH and BNB ended up on different API keys.
  //
  // Returns null when everything passes, or an object to send back.
  async function withdrawalGuards(req) {
    if (isDemo(req.user.id)) {
      return { status: 403, body: { error: 'Demo accounts cannot withdraw.' } };
    }
    if (!req.user.email_confirmed_at) {
      return { status: 403, body: { error: 'Please verify your email before withdrawing.' } };
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
          return { status: 403, body: { error: 'Verify with your authenticator app to withdraw.', mfaRequired: true } };
        }
      }
    } catch (e) {
      console.error('[withdraw] MFA/aal check error (allowing):', e.message);
    }

    if (isLocked(req.user.id)) {
      return { status: 400, body: { error: 'Cannot withdraw while in a queue or active match' } };
    }
    if (activeWithdrawals.has(req.user.id)) {
      return { status: 429, body: { error: 'A withdrawal is already in progress' } };
    }
    return null;
  }

  router.post('/withdraw', requireAuth, async (req, res) => {
    const blocked = await withdrawalGuards(req);
    if (blocked) return res.status(blocked.status).json(blocked.body);

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

      // ── ChangeNow's own floor ────────────────────────────────────────
      //
      // Ours is $5 for most coins; theirs moves with the destination network's
      // fees and is routinely higher for ETH. Without this, dropping our floor
      // to $5 would not make small withdrawals work — it would make them fail
      // LATER, after the coins had been deducted, in the payout path that then
      // has to refund. The player would see "Payout failed" and a raw provider
      // error for something we could have told them up front.
      //
      // Asked before anything is deducted, so a rejection costs nothing.
      //
      // Fails OPEN: getWithdrawalMinUsd returns 0 when it cannot find out, and
      // 0 means "no opinion". A ChangeNow outage must not block withdrawals
      // across the whole site — the payout path still refunds if it turns out
      // to be under after all.
      const liveMin = DIRECT_PAYOUT_COINS.has(coin.toLowerCase())
        ? 0
        : await getWithdrawalMinUsd(coin.toLowerCase()).catch(() => 0);
      if (liveMin > 0 && amount < liveMin) {
        return res.status(400).json({
          error: `${coin.toUpperCase()} withdrawals need at least $${liveMin.toFixed(2)} right now — ` +
                 `network fees set this and it changes. Try a larger amount, or withdraw USDC or SOL instead.`,
        });
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

      let payoutId   = null;
      let cryptoAmt  = null;
      // Set only on the ChangeNow path. The direct payouts (SOL, USDC, USDT)
      // are delivered by the time their send returns, so there is nothing left
      // to watch and nothing that can fail afterwards.
      let exchangeId = null;

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

        } else if (coin.toLowerCase() === 'usdt') {
          // Two steps, both on Solana and both ours.
          //
          // Jupiter's output goes to the ADMIN wallet's USDT account, not the
          // player's — a swap cannot be relied on to create a token account for
          // an arbitrary destination, and a swap that lands nowhere is worse
          // than one extra transaction. sendSplToken creates the recipient's
          // account if they have never held USDT.
          //
          // The player is sent what the swap ACTUALLY produced, not what they
          // asked for. On a stablecoin pair those are near-identical, but
          // sending the requested figure would mean covering the difference out
          // of the bank on every single withdrawal.
          const swapped = await swapUsdcToUsdt(privKey, amount);
          const sendTx = await sendCrypto({
            coin:      'usdt',
            privKey,
            toAddress: address.trim(),
            amount:    swapped.usdtReceived,
          });
          payoutId  = sendTx;
          cryptoAmt = swapped.usdtReceived;
          console.log(`[withdraw] USDC → USDT ${amount} → ${swapped.usdtReceived} → ${address.trim()} tx=${sendTx}`);

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
          // Kept so the conversion can be WATCHED. Handing USDC to ChangeNow is
          // not delivery — they still have to convert and send. Until now the
          // row was marked confirmed here and forgotten, so a conversion that
          // failed left the coins deducted, nothing delivered, and our records
          // saying it went fine.
          exchangeId = swap.exchangeId;
          console.log(`[withdraw] ChangeNow payout ${amount} USDC → ${coin} → ${address.trim()} exchange=${swap.exchangeId}`);
        }

      } catch (payoutErr) {
        console.error(`[withdraw] payout failed user=${req.user.id} amount=${amount}:`, payoutErr.message);

        // ── Did it actually fail? ──────────────────────────────────────────
        //
        // A Solana send broadcasts first and confirms second, so a confirmation
        // timeout is NOT proof the money stayed put. Refunding on the error
        // alone therefore paid the player on-chain and gave their coins back —
        // a double-spend anyone could fish for by retrying withdrawals during
        // congestion until a confirmation happened to time out.
        //
        // So we ask the chain before touching the balance.
        const sig = payoutErr.signature || null;
        if (sig) {
          const state = await checkSolanaSignature(sig).catch(() => 'unknown');

          if (state === 'confirmed') {
            // It landed. The player has been paid; the only thing that failed
            // was our confidence. Record it as the successful withdrawal it is
            // and do NOT refund.
            console.log(`[withdraw] confirmation timed out but tx ${sig} landed — treating as paid`);
            await supabase.from('transactions').insert({
              user_id: req.user.id, type: 'withdrawal', amount_c: amount,
              crypto_amount: cryptoAmt, crypto_symbol: coin.toUpperCase(),
              tx_hash: String(sig), extra_id: memo?.trim() || null,
              status: 'confirmed', notes: 'confirmed late after timeout',
            }).then().catch(e => console.error('[withdraw] late-confirm row failed:', e.message));
            await recordWithdrawal(supabase, req.user.id, amount, 'crypto').catch(() => {});
            const bal = await getBalance(supabase, req.user.id);
            return res.json({ success: true, new_balance: bal, tx: sig });
          }

          if (state === 'unknown') {
            // We could not find out. Refunding might pay them twice; not
            // refunding might rob them. Neither is ours to guess, so the money
            // stays deducted, the row is flagged, and a human decides. This is
            // in alertService's CRITICAL list.
            console.error(`CRITICAL: withdrawal outcome unknown user=${req.user.id} amount=${amount} sig=${sig} — manual review required`);
            await supabase.from('transactions').insert({
              user_id: req.user.id, type: 'withdrawal', amount_c: amount,
              crypto_symbol: coin.toUpperCase(), tx_hash: String(sig),
              status: 'payout_uncertain',
              notes: `could not determine on-chain outcome: ${String(payoutErr.message).slice(0, 200)}`,
            }).then().catch(e => console.error('[withdraw] uncertain row failed:', e.message));
            return res.status(500).json({
              error: 'Your withdrawal is being verified. Your balance will be corrected within a few minutes — please do not retry.',
            });
          }
          // 'failed' or 'missing' — the money never left. Refund below.
        }

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
      //
      // Checked, for the same reason the deposit path now is: an insert whose
      // result is discarded can fail in total silence, and that is exactly how
      // a live BTC deposit went missing — a unique index on extra_id rejected
      // the row and nothing anywhere said so. This row also writes extra_id.
      //
      // Unlike the deposit case there is nothing to undo: the payout has
      // already gone on-chain by this point, so a failure here costs the audit
      // trail rather than the money. It still needs a human, because the
      // withdrawal will not appear in the player's history or count toward
      // their withdrawn total.
      // 'confirmed' means DELIVERED. A ChangeNow withdrawal is not delivered
      // when we send the USDC — it is delivered when they convert and pay out,
      // which can still fail. Those rows are 'converting' until the poller sees
      // a terminal status, and tx_hash carries the EXCHANGE id so the poller
      // and support can both find it. A direct payout has already landed, so it
      // keeps the on-chain hash and is confirmed immediately.
      const pending = Boolean(exchangeId);
      const { error: recErr } = await supabase.from('transactions').insert({
        user_id:       req.user.id,
        type:          'withdrawal',
        amount_c:      amount,
        crypto_amount: cryptoAmt,
        crypto_symbol: coin.toUpperCase(),
        tx_hash:       String(pending ? exchangeId : payoutId),
        extra_id:      memo?.trim() || null,
        status:        pending ? 'converting' : 'confirmed',
        notes:         pending ? `USDC sent to ChangeNow tx=${payoutId}` : null,
      });
      if (recErr) {
        console.error(
          `CRITICAL: withdrawal PAID but not recorded — user=${req.user.id} amount=${amount} ` +
          `coin=${coin.toUpperCase()} tx=${payoutId} — the money has gone, the row has not:`, recErr.message);
      }

      // Watch the conversion. Only meaningful once the row exists — the poller
      // claims that row before refunding, so without it a failure could refund
      // repeatedly.
      if (pending && !recErr) {
        try {
          require('../services/swapPoller').watchWithdrawal(exchangeId, req.user.id);
        } catch (e) {
          console.error(`[withdraw] could not watch exchange ${exchangeId}:`, e.message);
        }
      }

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

  // ── Fiat withdrawal ───────────────────────────────────────────────────
  //
  // Bank, PayPal and Venmo. Shares every guard with the crypto route above and
  // differs only in what it validates and what it hands the money to.
  //
  // Nothing can pay out today: fiatConfig.ENABLED is empty and both provider
  // adapters throw. That is deliberate — the route exists so it can be written
  // and tested before an approval lands, and so enabling a rail later is a
  // config change against tested code rather than new code written in a hurry.

  // Where the money is going, per method. A bank account and a PayPal address
  // have nothing in common, so this cannot be one shape.
  function validateDestination(method, destination) {
    const d = destination || {};
    if (method === 'bank') {
      const v = validateBankDetails(d);
      return v.ok ? { ok: true, summary: maskAccountNumber(d.accountNumber) } : v;
    }
    if (method === 'paypal' || method === 'venmo') {
      const email = String(d.email || '').trim().toLowerCase();
      // Deliberately loose. An address that looks wrong is worth rejecting; an
      // address that looks right is still only proven by the payout landing,
      // which is what the unclaimed state exists to report.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        return { ok: false, error: `Enter the email address on the ${method === 'venmo' ? 'Venmo' : 'PayPal'} account.` };
      }
      return { ok: true, summary: email };
    }
    return { ok: false, error: 'Unsupported withdrawal method' };
  }

  // Identity has to be verified before money leaves by a fiat rail — every
  // provider requires it and so does the tax reporting.
  //
  // Fails CLOSED. A missing column, an unreadable profile or an error all mean
  // "not verified", because the alternative is paying out to someone we cannot
  // identify on the one path where that is not recoverable.
  async function kycApproved(userId) {
    try {
      const { data } = await supabase
        .from('profiles').select('kyc_status').eq('id', userId).single();
      return data?.kyc_status === 'approved';
    } catch {
      return false;
    }
  }

  router.post('/withdraw-fiat', requireAuth, async (req, res) => {
    const blocked = await withdrawalGuards(req);
    if (blocked) return res.status(blocked.status).json(blocked.body);

    const method = String(req.body?.method || '').toLowerCase();

    // Validation before the in-flight lock, for the reason the crypto route
    // documents: a rejected request that leaked the lock would bar the player
    // from withdrawing until the process restarted.
    if (!fiatCfg.canWithdraw(method)) {
      return res.status(400).json({
        error: fiatCfg.METHODS[method]
          ? `${fiatCfg.METHODS[method].label} withdrawals are not available yet.`
          : 'Unsupported withdrawal method',
      });
    }

    const dest = validateDestination(method, req.body?.destination);
    if (!dest.ok) return res.status(400).json({ error: dest.error });

    const min = fiatCfg.minFor(method, 'withdraw');
    let amount;
    try { amount = sanitizeAmount(req.body?.amount, min, MAX_SINGLE_AMOUNT); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    activeWithdrawals.add(req.user.id);
    try {
      const lastWit = await getLastWithdrawal(supabase, req.user.id);
      if (lastWit && Date.now() - new Date(lastWit).getTime() < WITHDRAW_COOLDOWN_MS) {
        const waitSec = Math.ceil((WITHDRAW_COOLDOWN_MS - (Date.now() - new Date(lastWit).getTime())) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSec}s before withdrawing again` });
      }

      const balance = await getBalance(supabase, req.user.id);
      if (balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

      if (!(await kycApproved(req.user.id))) {
        return res.status(403).json({
          error: 'Verify your identity before withdrawing to a bank or wallet.',
          kycRequired: true,
        });
      }

      // Deducted before the send, so the balance cannot be spent while a payout
      // is in flight. Same ordering as the crypto route.
      await deductCoins(supabase, req.user.id, amount);

      let payoutId;
      try {
        const result = await fiatPay.providerFor(method).send({
          method, amount, destination: req.body.destination, userId: req.user.id,
        });
        payoutId = result?.payoutId;
        if (!payoutId) throw new fiatPay.PayoutSubmitError('provider returned no payout id', undefined);
      } catch (e) {
        // submitted === false is the ONLY case where nothing left. Anything
        // else — a timeout, an ambiguous error, a missing id — might have
        // created a real payout, and refunding on top of that pays twice.
        if (e.submitted === false) {
          try {
            await creditCoins(supabase, req.user.id, amount);
          } catch (refundErr) {
            console.error(
              `CRITICAL: fiat payout refund failed user=${req.user.id} amount=${amount} ` +
              `method=${method} — manual credit required:`, refundErr.message);
            await supabase.from('transactions').insert({
              user_id: req.user.id, type: 'withdrawal', amount_c: amount,
              crypto_symbol: method.toUpperCase(), status: 'refund_failed',
              notes: `payout not submitted: ${String(e.message).slice(0, 150)} | refund failed: ${String(refundErr.message).slice(0, 150)}`,
            }).then().catch(() => {});
            return res.status(500).json({ error: 'Payout failed and the refund failed — contact support.' });
          }
          return res.status(503).json({ error: `${fiatCfg.METHODS[method].label} payouts are unavailable right now. Nothing was taken.` });
        }

        // Unknown. Coins stay deducted and a person decides — the same call the
        // ChangeNow path makes, for the same reason.
        console.error(
          `CRITICAL: fiat payout outcome unknown user=${req.user.id} amount=${amount} ` +
          `method=${method} payoutId=${e.payoutId || 'none'} — NOT refunded:`, e.message);
        await supabase.from('transactions').insert({
          user_id: req.user.id, type: 'withdrawal', amount_c: amount,
          crypto_symbol: method.toUpperCase(), tx_hash: e.payoutId || null,
          status: 'payout_uncertain',
          notes: `Could not confirm whether this payout was submitted: ${String(e.message).slice(0, 200)}`,
        }).then().catch(() => {});
        return res.status(500).json({
          error: 'Your withdrawal is being verified. Your balance will be corrected shortly — please do not retry.',
        });
      }

      // 'sending', not 'confirmed'. Handing a payout to a provider is not
      // delivery — the watcher decides which it becomes.
      const { error: recErr } = await supabase.from('transactions').insert({
        user_id: req.user.id, type: 'withdrawal', amount_c: amount,
        crypto_amount: amount, crypto_symbol: method.toUpperCase(),
        tx_hash: String(payoutId), status: 'sending',
        notes: `${fiatCfg.METHODS[method].label} → ${dest.summary}`,
      });
      if (recErr) {
        console.error(
          `CRITICAL: fiat payout SUBMITTED but not recorded — user=${req.user.id} ` +
          `amount=${amount} method=${method} payout=${payoutId}:`, recErr.message);
      }

      // Only watch a payout that has a row: the watcher claims that row before
      // acting, so without it a failure would have nothing to claim.
      if (!recErr) {
        try { payoutWatcher.watch(String(payoutId), req.user.id, method); }
        catch (e) { console.error(`[withdraw] could not watch payout ${payoutId}:`, e.message); }
      }

      await recordWithdrawal(supabase, req.user.id, amount, 'fiat').catch(e =>
        console.error('recordWithdrawal failed:', e.message));

      const newBalance = await getBalance(supabase, req.user.id);
      res.json({ success: true, new_balance: newBalance, payoutId, status: 'sending' });

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

    // Demo accounts use this form to set their own balance (see below), so they
    // have no recipient to name.
    const demoSetter = isDemo(req.user.id);

    if (!demoSetter && (!recipientUsername || typeof recipientUsername !== 'string')) {
      return res.status(400).json({ error: 'recipientUsername required' });
    }

    let tipAmount;
    try {
      // The tip ceiling exists to bound what one real account can hand another.
      // A demo is setting its own play money, so that ceiling has nothing to do
      // with it — a $1,000 cap would make it useless for demonstrating the
      // higher stakes. Still bounded, so a typo cannot write nonsense.
      const coinMax = demoSetter ? 1_000_000 : MAX_TIP_COINS;
      tipAmount = isDiamonds
        ? sanitizeDiamondAmount(req.body.amount, demoSetter ? 0 : 1, MAX_TIP_DIAMONDS)
        : sanitizeAmount(req.body.amount, demoSetter ? 0 : 0.01, coinMax);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // ── Demo accounts: tip sets your own balance ────────────────────────────
    //
    // A demo account cannot deposit, so there is otherwise no way to put it at a
    // chosen balance for a walkthrough. Rather than build a second admin screen,
    // the tip form doubles as a balance setter: type a number, press Tip, that
    // becomes the balance.
    //
    // Handled before the recipient lookup, so the field can be left empty — the
    // recipient is meaningless here.
    //
    // This writes the balance directly instead of crediting, and so must never
    // be reachable by a real account: it would be minting. isDemo is an explicit
    // allowlist from DEMO_ACCOUNT_IDS, not a flag on the row, so it cannot be
    // set by anything a user controls.
    if (isDemo(req.user.id)) {
      const column = isDiamonds ? 'diamonds' : 'c_coins';
      const value  = isDiamonds ? Math.round(tipAmount) : tipAmount;
      const { error } = await supabase.from('profiles')
        .update({ [column]: value }).eq('id', req.user.id);
      if (error) return res.status(500).json({ error: error.message });
      console.log(`[demo] balance set ${column}=${value} for ${req.user.id}`);
      return res.json({ success: true, demoBalanceSet: true, amount: value, currency });
    }

    const { data: recipient } = await supabase
      .from('profiles').select('id, username').eq('username', recipientUsername.trim()).single();
    if (!recipient) return res.status(404).json({ error: 'User not found' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'You cannot tip yourself' });
    // A real account still cannot tip a demo, or the demo's fake balance would
    // become real money in someone's pocket.
    if (isDemo(recipient.id)) return res.status(403).json({ error: 'Demo accounts cannot send or receive tips.' });

    // A tip is two independent writes: take from the sender, give to the
    // recipient. If the second fails the first has already happened, and the
    // sender's coins are simply gone — nothing refunds them and the only trace
    // is a 500. So the credit is wrapped and the deduction reversed on failure.
    //
    // If the reversal ALSO fails the money really is lost, which is why that
    // case gets its own log line and its own error: it is the one outcome that
    // needs a human. Same shape as the withdrawal refund path.
    const undoTip = async (err) => {
      try {
        if (isDiamonds) await creditDiamonds(supabase, req.user.id, tipAmount);
        else            await creditCoins(supabase, req.user.id, tipAmount);
      } catch (refundErr) {
        console.error(`CRITICAL: tip refund failed user=${req.user.id} amount=${tipAmount} ${currency} — manual credit required:`, refundErr.message);
        throw new Error('Tip failed and the refund failed — contact support.');
      }
      throw new Error(`Tip failed: ${err.message}`);
    };

    try {
      if (isDiamonds) {
        await deductDiamonds(supabase, req.user.id, tipAmount);
        try {
          await creditDiamonds(supabase, recipient.id, tipAmount);
        } catch (e) { await undoTip(e); }
        supabase.from('transactions').insert([
          { user_id: req.user.id,   type: 'tip_sent',     amount_c: 0, crypto_amount: tipAmount, crypto_symbol: 'diamonds', status: 'confirmed' },
          { user_id: recipient.id,  type: 'tip_received', amount_c: 0, crypto_amount: tipAmount, crypto_symbol: 'diamonds', status: 'confirmed' },
        ]).then().catch(e => console.error('[tx] diamond tip insert failed:', e.message));
      } else {
        await deductCoins(supabase, req.user.id, tipAmount);
        try {
          await creditCoins(supabase, recipient.id, tipAmount);
        } catch (e) { await undoTip(e); }
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
