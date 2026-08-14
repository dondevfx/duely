// Every profile showed its owner up on the money. Two separate errors, both of
// which push in the same direction, which is why it was never once negative.
//
// 1. A deposit counted as a gain. Anyone who had ever funded their account
//    started deep in profit before playing a single hand.
//
// 2. A win was added at its GROSS payout. amount_c on a match_win returns the
//    player's own stake as well as their winnings, and the stake itself writes
//    no row — entry fees are taken with deduct_coins. So a break-even player
//    banked +1.9x per win against -1x per loss and drifted upward forever.
//
// The second is the one that matters: fixing only the deposit classification
// would still have shown almost everyone up, because the drift is structural.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = (p) => fs.readFileSync(p, 'utf8')
  .split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

const authSrc   = strip(path.join(__dirname, '..', 'src', 'routes', 'auth.js'));
const walletSrc = strip(path.join(__dirname, '..', 'src', 'services', 'walletService.js'));
const sqlSrc    = fs.readFileSync(path.join(__dirname, '..', '..', 'PENDING_SQL.sql'), 'utf8');

// Re-implementation of the endpoint's per-row rule, kept in step with the
// source by the assertions further down. Lets the arithmetic be tested without
// a database.
const LEGACY_MULT = 1.9;
function pnl(rows) {
  const CREDIT = new Set(['match_win', 'match_draw']);
  const DEBIT = new Set(['match_loss']);
  let running = 0;
  for (const tx of rows) {
    const amt = parseFloat(tx.amount_c) || 0;
    if (amt === 0) continue;
    let signed = null;
    if (CREDIT.has(tx.type)) {
      const stake = tx.stake_c != null ? parseFloat(tx.stake_c) || 0 : amt / LEGACY_MULT;
      signed = amt - stake;
    } else if (DEBIT.has(tx.type)) {
      signed = -amt;
    }
    if (signed === null) continue;
    running += signed;
  }
  return parseFloat(running.toFixed(2));
}

test('a deposit is not profit', () => {
  assert.equal(pnl([{ type: 'deposit', amount_c: 100 }]), 0);
});

test('withdrawals and tips are transfers, not performance', () => {
  assert.equal(pnl([
    { type: 'withdrawal',   amount_c: 50 },
    { type: 'tip_sent',     amount_c: 10 },
    { type: 'tip_received', amount_c: 10 },
  ]), 0);
});

test('a win counts winnings only, not the returned stake', () => {
  // $10 stake, 5% rake: payout 19, of which 10 is the player's own money back.
  assert.equal(pnl([{ type: 'match_win', amount_c: 19, stake_c: 10 }]), 9);
});

test('a loss costs the stake', () => {
  assert.equal(pnl([{ type: 'match_loss', amount_c: 10 }]), -10);
});

test('a break-even player is not shown up', () => {
  // The original bug in one line: one win and one loss at the same stake used to
  // read +9 because the win was banked gross. The house edge means it should be
  // slightly negative.
  const result = pnl([
    { type: 'match_win',  amount_c: 19, stake_c: 10 },
    { type: 'match_loss', amount_c: 10 },
  ]);
  assert.equal(result, -1);
  assert.ok(result < 0, 'a 50/50 player must not come out ahead of the rake');
});

test('a losing player is shown down', () => {
  const result = pnl([
    { type: 'deposit',    amount_c: 500 },   // used to bury the losses
    { type: 'match_loss', amount_c: 25 },
    { type: 'match_loss', amount_c: 25 },
    { type: 'match_win',  amount_c: 47.5, stake_c: 25 },
  ]);
  assert.equal(result, -27.5);
});

test('a draw is exactly neutral', () => {
  assert.equal(pnl([{ type: 'match_draw', amount_c: 10, stake_c: 10 }]), 0);
});

test('a legacy win with no stake recorded is inferred, not counted gross', () => {
  // Must not be +19. At 5% rake the inferred stake is exact.
  assert.equal(pnl([{ type: 'match_win', amount_c: 19 }]), 9);
});

test('the legacy estimate errs against the player, never for them', () => {
  // A Coin Flip rakes 2%, so a $10 stake pays 19.6 and the true profit is 9.6.
  // Inferring at the 5% multiplier gives a slightly lower number — understating
  // profit is the safe direction for a figure players will dispute.
  const estimated = pnl([{ type: 'match_win', amount_c: 19.6 }]);
  assert.ok(estimated < 9.6, 'the estimate must not flatter the player');
  assert.ok(estimated > 9.0, `estimate drifted too far: ${estimated}`);
});

// ── The source actually does the above ──────────────────────────────────────

test('the endpoint counts only gameplay', () => {
  assert.match(authSrc, /const CREDIT = new Set\(\['match_win', 'match_draw'\]\)/);
  assert.match(authSrc, /const DEBIT\s*= new Set\(\['match_loss'\]\)/);
  // The give-away for the old behaviour.
  assert.doesNotMatch(authSrc, /DEBITS = new Set\(\['withdrawal', 'match_loss'\]\)/,
    'deposits are being counted as profit again');
});

test('the endpoint subtracts the stake from a payout', () => {
  assert.match(authSrc, /signed = amt - stake/);
});

test('settling records the stake next to the payout', () => {
  // Without this the P&L can only ever estimate.
  const wins = walletSrc.match(/type: 'match_win',[^}]*/g) || [];
  const coinWins = wins.filter(w => /amount_c: (payout|winnerPayout)/.test(w));
  assert.ok(coinWins.length >= 3, `expected the coin win rows, found ${coinWins.length}`);
  for (const w of coinWins) {
    assert.match(w, /stake_c:/, `a coin win row records no stake: ${w.slice(0, 80)}`);
  }
});

test('recording money does not depend on the migration', () => {
  // A missing column must degrade the P&L, never drop a transaction.
  const fn = walletSrc.slice(walletSrc.indexOf('async function insertTx'));
  assert.match(fn.slice(0, 700), /stake_c/, 'insertTx must detect the missing column');
  assert.match(fn.slice(0, 700), /insert\(stripped\)/, 'it must retry without the column');
});

test('reading is resilient to the migration too', () => {
  assert.match(authSrc, /readTxs\(false\)/,
    'the profile must not 500 because stake_c does not exist yet');
});

test('the migration is written down and is re-runnable', () => {
  assert.match(sqlSrc, /ADD COLUMN IF NOT EXISTS stake_c numeric/);
  assert.match(sqlSrc, /t\.stake_c IS NULL/, 'the backfill must not overwrite live values');
});
