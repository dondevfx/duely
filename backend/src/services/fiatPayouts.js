/**
 * Fiat payout providers, behind one interface.
 *
 * Every rail reports differently and none of them agree on what "sent" means.
 * The watcher should not know any of that, so the translation lives here: a
 * provider's own vocabulary in, one of five states out.
 *
 * ── The five states ──
 *
 *   pending      submitted, still moving. Keep watching.
 *   settled      the money reached them. For a wallet this is final; for ACH it
 *                is final-ish, see the note on returns below.
 *   returned     it came back. Nothing was delivered, but we know that for sure.
 *   unclaimed    PayPal-specific and neither success nor failure — the recipient
 *                has no account, funds sit ~30 days, then bounce. Treated as its
 *                own thing precisely because guessing either way is wrong.
 *   unknown      we could not find out. Never treated as a failure.
 *
 * ── ACH returns are not a polling problem ──
 *
 * An ACH debit can be returned up to 60 days after it settles. Polling for
 * sixty days per payout is absurd, so the poller covers the first week and a
 * late return arrives by webhook and reopens the row. Anything that only polls
 * will eventually miss one.
 */

// ── Provider adapters ───────────────────────────────────────────────────────
//
// Each supplies `send` and `status`. Nothing is implemented yet because no
// provider has approved us — and a stub that returned a plausible-looking
// success would be worse than nothing, so these throw loudly instead.
//
// Bridge is the expected first integration: a virtual US account number per
// customer, ACH in converting to USDC, USDC out paying by ACH, so the treasury
// never holds dollars.

// ── Submitting is not the same as failing to submit ─────────────────────────
//
// The same distinction chainSend needed for Solana. A provider call that times
// out may or may not have created the payout, and refunding on the error alone
// is how a player ends up paid twice.
//
// So a failure carries whether the request definitely never left. Only
// `submitted === false` is safe to refund; anything else goes to a person.
class PayoutSubmitError extends Error {
  constructor(message, submitted, payoutId = null) {
    super(message);
    this.name = 'PayoutSubmitError';
    this.submitted = submitted;   // false = certainly not sent; true/undefined = unknown
    this.payoutId = payoutId;
  }
}

const NOT_CONFIGURED = (name) => {
  const e = new PayoutSubmitError(
    `Fiat payout provider "${name}" is not configured. ` +
    `No credentials, no integration — refusing rather than pretending to send.`,
    false);   // nothing was contacted, so refunding here is safe
  e.code = 'PROVIDER_NOT_CONFIGURED';
  return e;
};

const providers = {
  bridge: {
    label: 'Bridge',
    rails: ['bank'],
    async send()   { throw NOT_CONFIGURED('bridge'); },
    async status() { throw NOT_CONFIGURED('bridge'); },
    // Bridge reports its own transfer states; mapped when the integration lands.
    map: (raw) => raw,
  },
  paypal: {
    label: 'PayPal Payouts',
    rails: ['paypal', 'venmo'],
    async send()   { throw NOT_CONFIGURED('paypal'); },
    async status() { throw NOT_CONFIGURED('paypal'); },
    // PayPal's batch item statuses. UNCLAIMED is the one that matters: it is a
    // real, common, long-lived state that is neither success nor failure, and
    // reading it as either is how money goes quiet.
    map: (raw) => ({
      PENDING:    'pending',
      PROCESSING: 'pending',
      ONHOLD:     'pending',
      SUCCESS:    'settled',
      UNCLAIMED:  'unclaimed',
      RETURNED:   'returned',
      REFUNDED:   'returned',
      REVERSED:   'returned',
      DENIED:     'returned',
      BLOCKED:    'returned',
      FAILED:     'returned',
    }[String(raw || '').toUpperCase()] || 'unknown'),
  },
};

// Which provider serves which method.
const RAIL_PROVIDER = {
  bank:   'bridge',
  paypal: 'paypal',
  venmo:  'paypal',
};

function providerFor(method) {
  const key = RAIL_PROVIDER[method];
  const p = key && providers[key];
  if (!p) throw new Error(`No payout provider for method "${method}"`);
  return p;
}

const isConfigured = (method) => {
  try { providerFor(method); return false; } catch { return false; }
  // Deliberately false until an integration exists. Flipping this on is part of
  // wiring a provider, not a config toggle.
};

// ── How long a payout may legitimately take ─────────────────────────────────
//
// Per rail, because "overdue" is meaningless as one number. ACH crossing a
// weekend takes longer than ACH on a Tuesday, and a PayPal payout that is
// unclaimed is not late at all — it is waiting for a person who may never come.
const OVERDUE_MS = {
  bank:   7  * 24 * 60 * 60 * 1000,   // 1-3 business days, plus weekend slack
  paypal: 32 * 24 * 60 * 60 * 1000,   // covers the ~30-day unclaimed window
  venmo:  32 * 24 * 60 * 60 * 1000,
};
const DEFAULT_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;

const overdueMsFor = (method) => OVERDUE_MS[method] ?? DEFAULT_OVERDUE_MS;

/**
 * Poll spacing, by age. Fast while an answer is plausibly imminent, then slow.
 *
 * A PayPal payout resolves in seconds or sits unclaimed for a month; polling
 * that every 30 seconds for 32 days is ~92,000 calls for one payout. The
 * backoff is what makes a long watch window affordable.
 */
function pollDelay(ageMs) {
  if (ageMs < 5  * 60_000)      return 30_000;      // first 5 min — wallets land here
  if (ageMs < 60 * 60_000)      return 5  * 60_000; // first hour
  if (ageMs < 24 * 3600_000)    return 60 * 60_000; // first day — ACH settles here
  return 6 * 60 * 60_000;                           // beyond that — the unclaimed wait
}

module.exports = {
  PayoutSubmitError,
  providers,
  providerFor,
  isConfigured,
  RAIL_PROVIDER,
  overdueMsFor,
  pollDelay,
  OVERDUE_MS,
};
