// Nothing checked, before this, whether the coins leaving the platform were
// ever actually backed by a real deposit or a real match. The RLS hole let a
// direct-database write mint a balance with neither behind it — that specific
// route in is closed (PENDING_SQL sections 15/16) — but the same shape of
// problem was still open through routes that are legitimate: deposit a stolen
// card and withdraw before the chargeback lands, or tip a fresh account and
// cash it straight out. Both move real money out for coins nothing on the
// platform actually backs.
//
// A near-identical function already existed for exactly this — getWithdrawable
// in walletService.js — deliberately left unenforced with a comment
// explaining the reasoning ("no free coin faucet... every coin traces back to
// a real deposit, real rake, or a zero-sum transfer"). That reasoning was
// correct on its own terms; the RLS hole proved its premise false, since it
// minted a balance through neither of the paths that reasoning was about.
// This replaces the stub with the real check rather than building a second,
// competing one — it is what the original comment already said to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const WALLET  = strip(read('src', 'routes', 'wallet.js'));
const SERVICE = strip(read('src', 'services', 'walletService.js'));

function fn(body, at) {
  const open = body.indexOf('{', body.indexOf('(', at));
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) return body.slice(open, i + 1);
  }
  assert.fail('unbalanced braces reading getWithdrawable');
}

function getWithdrawableSrc() {
  const at = SERVICE.indexOf('async function getWithdrawable');
  assert.notEqual(at, -1, 'getWithdrawable is gone');
  return fn(SERVICE, at);
}

// ── The one real implementation ─────────────────────────────────────────

test('getWithdrawable is implemented once, not duplicated in wallet.js', () => {
  assert.ok(!/async function withdrawEligibility/.test(WALLET),
    'a second, parallel implementation must not exist alongside getWithdrawable — ' +
    'this app already learned that lesson once (ETH/BNB on different API keys)');
});

test('both withdrawal routes call the real function, each with its own request\'s amount', () => {
  for (const routeStart of ["router.post('/withdraw'", "router.post('/withdraw-fiat'"]) {
    const at = WALLET.indexOf(routeStart);
    assert.notEqual(at, -1, `${routeStart} is gone`);
    const nextRoute = WALLET.indexOf("router.post('/withdraw", at + 10);
    const body = WALLET.slice(at, nextRoute === -1 ? at + 4000 : nextRoute);
    assert.match(body, /await getWithdrawable\(supabase, req\.user\.id\)/,
      `${routeStart} must call getWithdrawable — a route with no call has no protection at all`);
    // Both halves of the rule now go through one builder — "never played" and
    // "this much of the deposit is unwagered" were two refusals in two
    // wordings, and neither said how much wagering would clear it. The
    // builder returns null when the rule is switched off, so this is still
    // the switch as well as the guard.
    assert.match(body, /const blocked = playthroughMessage\(src\);/,
      `${routeStart} must build its refusal from the shared message`);
    assert.match(body, /if \(blocked && \(!src\.hasPlayed \|\| amount > src\.withdrawable\)\)/,
      `${routeStart} must refuse on either half of the rule`);
    assert.match(body, /amount > src\.withdrawable/, `${routeStart} must cap on src.withdrawable`);
  }
});

test('the source-of-funds check runs after the amount is known, not in the shared pre-check', () => {
  // withdrawalGuards runs before either route parses its own amount, and the
  // two routes use different field names for it (amountUsd vs amount) — a
  // shared check reading either name generically risks silently reading the
  // wrong one. Each route must own this call after its OWN sanitizeAmount.
  const guardsAt = WALLET.indexOf('async function withdrawalGuards');
  const guardsEnd = WALLET.indexOf("router.post('/withdraw'", guardsAt);
  const guards = WALLET.slice(guardsAt, guardsEnd);
  assert.ok(!/getWithdrawable/.test(guards),
    'withdrawalGuards must not call getWithdrawable itself — see the two per-route tests above instead');
});

test('an account with zero matches played is blocked outright, not just capped', () => {
  for (const routeStart of ["router.post('/withdraw'", "router.post('/withdraw-fiat'"]) {
    const at = WALLET.indexOf(routeStart);
    const nextRoute = WALLET.indexOf("router.post('/withdraw", at + 10);
    const body = WALLET.slice(at, nextRoute === -1 ? at + 4000 : nextRoute);
    const hasPlayedAt = body.indexOf('!src.hasPlayed');
    const cappedAt = body.indexOf('amount > src.withdrawable');
    assert.ok(hasPlayedAt !== -1 && hasPlayedAt < cappedAt,
      `${routeStart}: the never-played check must run before the amount cap, not after`);
  }
});

// ── The formula itself ──────────────────────────────────────────────────

test('getWithdrawable computes every rule from real, tracked data', () => {
  const src = getWithdrawableSrc();
  assert.match(src, /wins.*losses|losses.*wins/s, 'hasPlayed must read real match history');
  assert.match(src, /entry_fee_c/, 'lifetimeWagered must come from real matches, not a guess');

  // The ledger is read in ONE query and classified in JS, rather than a query
  // per type. Confirmed rows only — a pending or failed row is not money.
  assert.match(src, /\.eq\('status', 'confirmed'\)/,
    'the ledger must only count confirmed rows');
  assert.match(src, /crypto_symbol !== 'diamonds'/,
    'diamonds are not withdrawable and must not count toward a coin balance');

  // What carries the playthrough requirement.
  for (const [type, why] of [
    ["'deposit'",      'deposits must be wagered before they can be withdrawn'],
    ["'tip_received'", 'without this: deposit, tip to a second account, withdraw, for free'],
    ["'rewards_spin'", 'wheel prizes are coins that were never risked'],
  ]) {
    assert.ok(src.includes(`sumOf(${type})`), why);
  }
  assert.match(src, /rakeback_claimed_total/, 'claimed rakeback carries it too');
  assert.match(src,
    /playthroughOwed =\s+lifetimeDeposited \+ lifetimeTipped \+ lifetimeSpun \+ lifetimeRakeback/,
    'the requirement is deposits plus tips plus wheel prizes plus claimed rakeback');
  assert.match(src, /Math\.max\(0, playthroughOwed - lifetimeWagered\)/,
    'unplayedDeposits must never go negative — a player who has wagered MORE than ' +
    'they took in must not create a negative cap');

  // And the separate question of whether the money exists at all.
  assert.match(src, /const accounted\s+= Math\.min\(balance, explainedBalance\)/,
    'a balance can never be more withdrawable than the ledger can explain — ' +
    'without this, coins written straight onto a profile walk out after one win');
  assert.match(src, /ledgerOut = sumOf\('withdrawal', 'match_loss', 'tip_sent'\)/,
    'money already out has to be subtracted, or a spent history explains new coins');
  assert.match(src, /lifetimeAffiliate/,
    'affiliate earnings write no transaction row; missing them freezes real earnings');
  assert.ok(!/'admin_adjustment'/.test(src.slice(src.indexOf('ledgerIn'), src.indexOf('ledgerOut'))),
    'an admin grant must not count as explained money, or the hole reopens through the panel');
  assert.match(src, /Math\.max\(0, REQUIRE_PLAYTHROUGH/,
    'withdrawable must never go negative either');
});

// ── The formula's behaviour, replicated in isolation ────────────────────
//
// getWithdrawable is a closure needing a live Supabase client to run for
// real. Verified against the exact scenarios this was built for instead.

function withdrawable({ deposited, wagered, balance }) {
  const unplayedDeposits = Math.max(0, deposited - wagered);
  return Math.max(0, balance - unplayedDeposits);
}

test('deposit then immediately try to withdraw the same amount: blocked', () => {
  const w = withdrawable({ deposited: 100, wagered: 0, balance: 100 });
  assert.equal(w, 0, 'an entirely unplayed deposit must not be withdrawable at all');
});

test('deposit, wager it once, then withdraw: allowed', () => {
  const w = withdrawable({ deposited: 100, wagered: 100, balance: 100 });
  assert.equal(w, 100, 'a deposit that has been wagered at least once must be fully withdrawable');
});

test('pure match winnings with zero deposits: fully withdrawable regardless of how little was wagered', () => {
  const w = withdrawable({ deposited: 0, wagered: 5, balance: 30 });
  assert.equal(w, 30, 'match winnings must never be capped by the deposit check — only real deposits are');
});

test('partial playthrough caps the withdrawal, does not block it outright', () => {
  const w = withdrawable({ deposited: 100, wagered: 40, balance: 100 });
  assert.equal(w, 40, 'the cap must be proportional to what has actually been wagered, not all-or-nothing');
});

test('winnings on top of an unplayed deposit are still reachable', () => {
  const w = withdrawable({ deposited: 100, wagered: 0, balance: 130 });
  assert.equal(w, 30, 'winnings sitting on top of an unplayed deposit must not get locked up with it');
});

test('a withdrawal request under the eligible amount is not blocked', () => {
  const w = withdrawable({ deposited: 100, wagered: 40, balance: 100 });
  assert.ok(!(40 > w), 'a request exactly at the eligible cap must be allowed, not rejected as over it');
});
