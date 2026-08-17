// A correct transaction must never flash an error on its way through.
//
// Withdrawing showed "Exceeds your balance of 0 coins" in red for about half a
// second on a withdrawal that was working. The cause is a race the UI creates
// for itself:
//
//   1. click Withdraw — the amount field still holds "20", balance is 20
//   2. the server deducts and pushes the new balance down the socket
//   3. React re-renders: 20 > 0, so the affordability warning renders
//   4. the response arrives, the amount field clears, the warning disappears
//
// Nothing was wrong. The check is a PRE-SUBMIT guard being evaluated mid-submit,
// against a balance that has already moved. Once a request is in flight the
// server is the authority and the form must stop second-guessing it.
//
// Tipping had the identical shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', f), 'utf8');

// Anchored on the CONDITION that renders the warning, not on its text — the
// comment explaining this bug quotes the message, and matching on the text
// found the comment instead of the code.
function conditionLine(src, needle) {
  const line = src.split(/\r?\n/).find(l => l.includes(needle) && l.trimStart().startsWith('{'));
  assert.ok(line, `no JSX condition containing ${needle}`);
  return line;
}

test('the withdraw form stops checking affordability once it has submitted', () => {
  const line = conditionLine(read('Wallet.jsx'), 'parseFloat(witAmountUsd) > (profile?.c_coins');
  assert.match(line, /!witLoading/,
    'the affordability warning renders while the request is in flight, so a working withdrawal flashes an error');
});

test('the withdraw minimum warning is gated the same way', () => {
  const line = conditionLine(read('Wallet.jsx'), 'parseFloat(witAmountUsd) < getWithdrawMin');
  assert.match(line, /!witLoading/,
    'every pre-submit warning must go quiet on submit, not just the balance one');
});

test('the tip form stops checking affordability once it has submitted', () => {
  const src = read('Tip.jsx');
  const line = src.split('\n').find(l => l.includes('const insufficient'));
  assert.ok(line, 'the insufficient check is gone — was it renamed?');
  assert.match(line, /!sending/,
    'a tip that is going through flashes "Insufficient balance" while it is in flight');
});

test('the submit buttons stay disabled during the request regardless', () => {
  // Relaxing the warning must not accidentally re-enable the button and allow
  // a second submission against a balance that has already been spent.
  const wallet = read('Wallet.jsx');
  const btn = wallet.slice(wallet.indexOf('onClick={handleWithdraw}'), wallet.indexOf('Withdraw ${witCoin.label}'));
  assert.match(btn, /witLoading/, 'the withdraw button must be disabled while in flight');

  const tip = read('Tip.jsx');
  const at = tip.indexOf('onClick={handleSend}');
  const tipBtn = tip.slice(at, tip.indexOf('}', tip.indexOf('disabled={', at)) + 1);
  assert.match(tipBtn, /sending/, 'the tip button must be disabled while in flight');
});

test('the real outcome is still reported', () => {
  // Silencing the warning must not silence the actual result.
  const src = read('Wallet.jsx');
  assert.match(src, /setWitMsg\(\{ type: 'error'/, 'a genuine failure must still be shown');
  assert.match(src, /setWitMsg\(\{ type: 'success'/, 'and so must success');
});

// ── The same race on the betting screen ────────────────────────────────────
//
// Worse here than on the withdraw form, because this button also changes what
// it DOES: while it reads "Insufficient", it navigates to the top-up page. The
// stake is deducted and pushed down the socket before the lobby is replaced by
// the match, so a second tap in that window — and people do tap again when a
// button looks unresponsive — threw the player onto the rewards page while the
// match they had just paid for was starting.

const lobby = () => fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'GameLobby.jsx'), 'utf8');

test('starting a match freezes the lobby affordability check', () => {
  const line = lobby().split(/\r?\n/).find(l => l.includes('const insufficient'));
  assert.ok(line, 'the insufficient check is gone — was it renamed?');
  assert.match(line, /!committing/,
    'the button flips to "Insufficient" mid-start, and in that state it navigates away instead of playing');
});

test('every action that spends the stake sets the in-flight flag', () => {
  // Miss one and that button keeps the old behaviour, which is exactly how
  // this drifted across six games before.
  const src = lobby();
  // String match, not a regex: the parentheses here are literal, and escaping
  // them through a template string is how this test silently passed on
  // "commitonQueue" the first time it was written.
  for (const handler of ['onQueue', 'onBot', 'onBotFree']) {
    assert.ok(src.includes(`commit(${handler})`),
      `${handler} does not freeze the check, so starting a match through it still flashes`);
  }
});

test('the freeze releases itself', () => {
  // There is no single "it started" callback to hang this on, so it is bounded
  // by time. Without release, a failed start would leave the button lying about
  // affordability for the rest of the session.
  const src = lobby();
  assert.match(src, /setTimeout\(\(\) => setCommitting\(false\)/, 'the freeze must expire');
  assert.match(src, /clearTimeout\(commitTimer\.current\)/, 'and must not outlive the component');
});
