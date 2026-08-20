/**
 * Fiat payment methods — one source of truth, read by the route and the page.
 *
 * The crypto side learned this the hard way. DEPOSIT_COINS lived in the HTTP
 * route, the blockchain monitor had its own idea of which coins existed, and
 * disabling BNB stopped new addresses being issued while leaving the poller
 * warning about the old ones every 45 seconds forever. Same shape of bug is
 * available here: a page offering a payout method the server rejects is a
 * button that looks live and cannot work.
 *
 * ── The rule that matters most ──
 *
 * Direction is per method and is NOT symmetric. Cash App can take money and can
 * never send it — no third-party payout API exists — and Apple Pay is the same.
 * A player who funds with either has to withdraw somewhere else, and that has to
 * be enforced in code rather than remembered, because the failure mode is a
 * player who deposits expecting to cash out the same way.
 */

// ── Method table ────────────────────────────────────────────────────────────
//
// `deposit` and `withdraw` are capability, not preference: false means the rail
// genuinely cannot do it, so turning one on is not a config change but an
// integration that does not exist.
//
// Minimums follow the fee shape. Flat-fee rails are wrong for small amounts and
// right for large ones; percentage rails are the reverse. This is the same
// reasoning that gives BTC a $10 floor against $5 for everything else in
// WITHDRAW_MINS — the network fee is a real fraction of a small payout.
const METHODS = {
  bank: {
    label:       'Bank transfer',
    deposit:     true,
    withdraw:    true,
    minDeposit:  10,
    minWithdraw: 10,   // flat fee, so it is the wrong rail for a $3 cashout
    feeShape:    'flat',
    instant:     false, // 1-3 business days
  },
  card: {
    label:       'Debit or credit card',
    deposit:     true,
    withdraw:    false, // card PUSH payouts are a separate rail we are not on
    minDeposit:  10,
    minWithdraw: null,
    feeShape:    'percent',
    instant:     true,
  },
  apple_pay: {
    label:       'Apple Pay',
    deposit:     true,
    withdraw:    false, // a wallet presenting a card; there is nothing to pay back to
    minDeposit:  10,
    minWithdraw: null,
    feeShape:    'percent',
    instant:     true,
  },
  cash_app: {
    label:       'Cash App',
    deposit:     true,
    withdraw:    false, // no third-party payout API exists. Not a toggle.
    minDeposit:  10,
    minWithdraw: null,
    feeShape:    'percent',
    instant:     true,
  },
  paypal: {
    label:       'PayPal',
    deposit:     true,
    withdraw:    true,
    minDeposit:  5,
    minWithdraw: 5,
    feeShape:    'percent',
    instant:     true,
  },
  venmo: {
    label:       'Venmo',
    deposit:     true,
    withdraw:    true,
    minDeposit:  5,
    minWithdraw: 5,
    feeShape:    'percent',
    instant:     true,
  },
};

// ── Rollout switch ──────────────────────────────────────────────────────────
//
// Separate from capability. A method is listed above because the rail CAN do it
// and enabled here because a provider has approved us and the code is live.
// Ship one at a time and open the rest by editing this set — the same way
// DEPOSIT_COINS gates coins whose detector exists but whose provider does not.
//
// Empty means the whole fiat surface is off, which is the correct state until
// the first provider approval lands.
const ENABLED = new Set([]);

const isEnabled = (m) => ENABLED.has(m);

function canDeposit(method) {
  const m = METHODS[method];
  return Boolean(m && m.deposit && isEnabled(method));
}

function canWithdraw(method) {
  const m = METHODS[method];
  return Boolean(m && m.withdraw && isEnabled(method));
}

const depositMethods  = () => Object.keys(METHODS).filter(canDeposit);
const withdrawMethods = () => Object.keys(METHODS).filter(canWithdraw);

function minFor(method, direction) {
  const m = METHODS[method];
  if (!m) return null;
  return direction === 'deposit' ? m.minDeposit : m.minWithdraw;
}

/**
 * Everything the wallet page needs to render the fiat section, so it never
 * restates a number or a capability the server owns.
 */
function publicConfig() {
  const shape = (method, direction) => ({
    method,
    label: METHODS[method].label,
    min:   minFor(method, direction),
    instant: METHODS[method].instant,
  });
  return {
    deposit:  depositMethods().map(m => shape(m, 'deposit')),
    withdraw: withdrawMethods().map(m => shape(m, 'withdraw')),
    // Named so the page can warn at DEPOSIT time rather than leaving a player
    // to find out at cash-out that their method only goes one way.
    depositOnly: depositMethods().filter(m => !METHODS[m].withdraw),
  };
}

module.exports = {
  METHODS,
  ENABLED,
  isEnabled,
  canDeposit,
  canWithdraw,
  depositMethods,
  withdrawMethods,
  minFor,
  publicConfig,
};
