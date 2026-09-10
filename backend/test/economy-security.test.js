/**
 * The attacker owns the browser.
 *
 * Every test here is written from the position the real incident came from: a
 * player with a normal account, DevTools open, willing to send whatever they
 * like to whatever endpoint they can find. Nothing in the frontend counts as a
 * defence, so nothing in the frontend is tested here.
 *
 * The property being defended is narrow and absolute: an attacker who controls
 * the client cannot CREATE value. They can lose money, they can refuse to
 * play, they can send nonsense — but no sequence of requests they can make
 * should leave more coins or diamonds in the system than the server decided to
 * put there.
 *
 * These are unit-level: the routes and services are driven directly with a
 * fake Supabase that records every call. That is deliberate. An end-to-end
 * test against a live database would test the database's grants — which
 * scripts/check-anon-access.js already does, against production — while this
 * tests the thing that grants cannot: whether the server ASKS for the right
 * amount, for the right user, exactly once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');

const ATTACKER = '11111111-1111-1111-1111-111111111111';
const VICTIM   = '22222222-2222-2222-2222-222222222222';

// ── A session, without a real token ────────────────────────────────────────
//
// requireAuth verifies a bearer token against Supabase, which these tests have
// no way to produce. Patched BEFORE any route module is required, because the
// routes destructure it at load time and would otherwise keep the real one.
//
// This matters more than it looks: the first version of this file injected
// req.user in a middleware of its own and let the real requireAuth run after
// it, so every request 401'd — and the tests that walked "every rpc call the
// route made" walked an empty list and passed without testing anything. A
// security test that cannot fail is worse than no test, so `mount` now asserts
// the request actually got in.
const authMw = require('../src/middleware/auth');
let CURRENT_USER = ATTACKER;
authMw.requireAuth = (req, _res, next) => {
  req.user = { id: CURRENT_USER, email: 'a@b.c', email_confirmed_at: new Date().toISOString() };
  next();
};
authMw.optionalAuth = authMw.requireAuth;

// ── A Supabase that says yes to everything and remembers what it was asked ──
//
// Permissive on purpose. If a route only refuses an attack because the
// database would have refused it, that is worth knowing: the route is relying
// on a guard it does not own, and a schema change moves the hole back.
function fakeSupabase({ rows = {}, rpcResults = {} } = {}) {
  const calls = { rpc: [], insert: [], update: [] };
  const api = {
    calls,
    from(table) {
      const q = {
        _table: table, _filters: {},
        select: () => q,
        eq: (col, val) => { q._filters[col] = val; return q; },
        gte: () => q, lte: () => q, lt: () => q, gt: () => q, or: () => q,
        in: () => q, neq: () => q, not: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        single: async () => ({ data: rows[table] ?? null, error: null }),
        insert(payload) {
          calls.insert.push({ table, payload });
          const built = {
            select: () => Promise.resolve({ data: [{ id: 'row1' }], error: null }),
            then: (fn) => fn({ data: null, error: null }),
            catch: () => built,
          };
          return built;
        },
        update(patch) {
          calls.update.push({ table, patch, filters: { ...q._filters } });
          const built = {
            eq: (col, val) => { q._filters[col] = val; return built; },
            gte: () => built, or: () => built, lt: () => built, neq: () => built,
            select: () => Promise.resolve({ data: [{ id: 'row1' }], error: null }),
            then: (fn) => fn({ data: null, error: null }),
            catch: () => built,
          };
          return built;
        },
        then: (fn) => fn({ data: rows[table] ?? null, error: null }),
      };
      return q;
    },
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      if (fn in rpcResults) return rpcResults[fn];
      return { data: null, error: null };
    },
  };
  return api;
}

/** Mounts a router as a signed-in attacker. */
function mount(routerFactory, supabase, { as = ATTACKER, io = null } = {}) {
  CURRENT_USER = as;
  const app = express();
  app.use(express.json());
  app.use('/', routerFactory(supabase, io));
  return app;
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function call(port, method, path, body) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  // 401 means the harness never reached the handler, which would make every
  // assertion below it vacuously true. It is a broken test, not a pass.
  assert.notEqual(res.status, 401, `the request never got past auth: ${JSON.stringify(json)}`);
  return { status: res.status, body: json };
}

/** Every coin/diamond the fake database was asked to create, by any route. */
function credited(supabase) {
  const CREDITS = new Set([
    'credit_coins', 'credit_diamonds', 'credit_affiliate_c', 'credit_fee_balance',
    'claim_daily_bonus', 'claim_diamond_bonus',
    'claim_rakeback_instant', 'claim_rakeback_daily', 'claim_rakeback_weekly',
    'pay_referral_from_bank',
  ]);
  return supabase.calls.rpc.filter(c => CREDITS.has(c.fn));
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. "Give me coins" — the request the whole system exists to refuse
// ═══════════════════════════════════════════════════════════════════════════

test('no money route takes an amount from the client', async () => {
  // The rule, checked against the source rather than one request at a time:
  // a handler that reads an amount out of the body is a handler where the
  // amount is the attacker's to choose. The three that legitimately do —
  // withdrawals and tips — are spending the attacker's OWN balance, and are
  // tested separately below.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'routes');

  // wallet.js — withdrawals and tips spend the attacker's OWN balance, so the
  //             amount is theirs to choose. Tested separately below.
  // admin.js  — /users/:id/adjust-balance, behind requireAdmin, capped at
  //             50,000, note required, always written to the ledger. Tested
  //             separately below.
  const SPENDS_OWN_MONEY = new Set(['wallet.js', 'admin.js']);
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    if (SPENDS_OWN_MONEY.has(file)) continue;
    const code = fs.readFileSync(path.join(dir, file), 'utf8')
      .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
    for (const m of code.matchAll(/req\.(body|query)\.?\??\.?\s*(?:\.(\w+)|\[['"](\w+)['"]\])/g)) {
      const field = (m[2] || m[3] || '').toLowerCase();
      if (/^(amount|amountusd|coins|diamonds|balance|prize|payout|reward|fee|credit)$/.test(field)) {
        offenders.push(`${file}: req.${m[1]}.${field}`);
      }
    }
    for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.(body|query)/g)) {
      for (const nameRaw of m[1].split(',')) {
        const name = nameRaw.split(/[:=]/)[0].trim().toLowerCase();
        if (/^(amount|coins|diamonds|balance|prize|payout|reward|fee)$/.test(name)) {
          offenders.push(`${m[2]}: destructured ${name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `a route reads a money amount from the client:\n  ${offenders.join('\n  ')}`);
});

test('the spin prize is rolled by the server, whatever tier is asked for', async () => {
  const rewardRoutes = require('../src/routes/rewards');
  const supabase = fakeSupabase({ rows: { profiles: { elo: 3000 } } });
  const app = mount(rewardRoutes, supabase);
  const { server, port } = await listen(app);

  try {
    // A tier that does not exist, and a payload stuffed with everything an
    // attacker would try.
    for (const body of [
      { tier: 'jackpot' }, { tier: '__proto__' }, { tier: 1 }, { tier: null },
      { tier: 'bronze', amount: 999999, prize: 999999, coins: 999999, currency: 'coins' },
    ]) {
      const before = credited(supabase).length;
      const res = await call(port, 'POST', '/spin', body);
      const after = credited(supabase).slice(before);
      if (res.status !== 200) continue;
      // A legitimate spin is allowed to credit — but never the client's number.
      for (const c of after) {
        assert.ok(![999999, '999999'].includes(c.args.amount),
          `the client's amount was credited: ${JSON.stringify(c)}`);
      }
    }
  } finally { server.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. Acting as somebody else
// ═══════════════════════════════════════════════════════════════════════════

test('a client-supplied user id never decides who gets paid', async () => {
  // Every money route takes the account from the verified session. Sending a
  // different id in the body must change nothing about who is credited.
  const rewardRoutes = require('../src/routes/rewards');
  const supabase = fakeSupabase({ rows: { profiles: { elo: 3000 } } });
  const app = mount(rewardRoutes, supabase, { as: ATTACKER });
  const { server, port } = await listen(app);

  try {
    await call(port, 'POST', '/spin', {
      tier: 'bronze', user_id: VICTIM, userId: VICTIM, p_user_id: VICTIM, id: VICTIM,
    });
    for (const c of supabase.calls.rpc) {
      const target = c.args?.user_id ?? c.args?.p_user_id ?? c.args?.owner_id;
      if (target) {
        assert.equal(target, ATTACKER,
          `${c.fn} was pointed at another account by the request body`);
      }
    }
  } finally { server.close(); }
});

test('the tip sender is the session, and cannot be redirected', async () => {
  const walletRoutes = require('../src/routes/wallet');
  const supabase = fakeSupabase({ rows: { profiles: { id: VICTIM, username: 'victim', c_coins: 1000 } } });
  const app = mount(walletRoutes, supabase, { io: { sockets: { sockets: new Map() } } });
  const { server, port } = await listen(app);

  try {
    await call(port, 'POST', '/tip', {
      recipientUsername: 'victim', amount: 5,
      // Everything an attacker would try to reverse the direction.
      from: VICTIM, sender: VICTIM, user_id: VICTIM, userId: VICTIM,
    });
    const deducts = supabase.calls.rpc.filter(c => c.fn === 'deduct_coins');
    assert.ok(deducts.length > 0,
      `nothing was deducted, so nothing was tested — rpc calls: ${JSON.stringify(supabase.calls.rpc)}`);
    for (const d of deducts) {
      assert.equal(d.args.user_id, ATTACKER, 'the tip was taken from the wrong account');
    }
  } finally { server.close(); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. Numbers that are not numbers
// ═══════════════════════════════════════════════════════════════════════════

test('sanitizeAmount refuses everything that is not a plain positive number', () => {
  const { sanitizeAmount, sanitizeDiamondAmount } = require('../src/services/walletService');

  const POISON = [
    -1, -10000, 0, NaN, Infinity, -Infinity, null, undefined, '', 'abc', {}, [],
    '1e309', 1e309, '0x10', '  ', true, false, '1,000', '1.0.0',
    Number.MAX_SAFE_INTEGER + 1, 1e21, '-0', -0,
  ];
  for (const v of POISON) {
    assert.throws(() => sanitizeAmount(v, 0.01, 1000),
      `sanitizeAmount accepted ${String(v)} (${typeof v})`);
    assert.throws(() => sanitizeDiamondAmount(v, 1, 1000),
      `sanitizeDiamondAmount accepted ${String(v)} (${typeof v})`);
  }

  // And the shapes that are meant to work still do.
  assert.equal(sanitizeAmount('12.5', 0.01, 1000), 12.5);
  assert.equal(sanitizeAmount(12.5, 0.01, 1000), 12.5);
  assert.equal(sanitizeDiamondAmount('250', 1, 1000), 250);
});

test('a negative stake cannot be turned into a credit', () => {
  // deduct_coins(-100) would be a credit of 100 if the amount were not
  // whitelisted first. Every socket entry point that takes a stake runs it
  // through isValidFee, which is a Set of the real tiers — not a range check,
  // so there is nothing to be clever with.
  const fs = require('node:fs');
  const path = require('node:path');
  const handlers = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'socket', 'handlers.js'), 'utf8');

  const guard = handlers.slice(handlers.indexOf('function isValidFee'));
  assert.match(guard.slice(0, 300), /VALID_DIAMOND_FEES\.has\(Number\(fee\)\)/);
  assert.match(guard.slice(0, 300), /VALID_COIN_FEES\.has\(Number\(fee\)\)/);

  // Every handler that accepts a stake checks it. Counted rather than trusted:
  // a new game added without the guard is the whole hole.
  const starts = [...handlers.matchAll(
    /socket\.on\('(join_\w+_queue|play_\w+_vs_bot|create_private_room)'[^)]*\{/g)];
  assert.ok(starts.length >= 14, `only found ${starts.length} stake entry points`);

  let checked = 0;
  for (const m of starts) {
    // Read to the handler's own closing brace by counting depth. A fixed-size
    // window cut the longer handlers off before the guard and passed them by
    // accident, which is the opposite of what this test is for.
    // Up to the next handler. Counting braces from the match start stops at
    // the destructured PARAMETER list, which balances immediately and leaves a
    // handful of characters that of course contain no guard.
    const nextAt = handlers.indexOf("socket.on('", m.index + 1);
    const end = nextAt === -1 ? handlers.length : nextAt;
    const body = handlers.slice(m.index, end);
    // The parameter list can wrap across lines, so the matched signature alone
    // does not always contain the word — read the head of the handler instead.
    if (!/entryFee/.test(body.slice(0, 400))) continue;   // takes no stake
    checked++;
    assert.match(body, /isValidFee|rejectBadFee/,
      `${m[1]} takes a stake without validating it against the tier list`);
  }
  assert.ok(checked >= 14, `only ${checked} stake-taking entry points were checked`);
});

// ═══════════════════════════════════════════════════════════════════════════
//  4. Replay, and the failure that looks like a failure but is not
// ═══════════════════════════════════════════════════════════════════════════

test('a claim is never re-armed by a credit that only LOOKED like it failed', () => {
  // The subtle one, and it was present in four places.
  //
  // The shape was: stamp the cooldown (atomically, correctly), credit, and if
  // the credit reports an error, clear the stamp so the player can try again.
  // But an error is not proof that nothing happened — a response lost between
  // the app and Postgres reports an error for a statement that committed. On
  // that path the money was paid AND the claim was re-armed, so the next
  // request paid it again. On a spin, which is repeatable, that is a faucet.
  //
  // None of these may put a claim back after a credit whose outcome is unknown.
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');

  const spin = read('routes', 'rewards.js');
  assert.ok(!/resetCooldown/.test(spin), 'the spin still clears its own cooldown on failure');
  assert.match(spin, /SPIN UNRESOLVED/, 'the spin does not report an unresolved credit');

  const bonus = read('routes', 'bonus.js');
  assert.match(bonus, /rpc\('claim_diamond_bonus'/,
    'the diamond bonus still stamps and credits as two separate steps');
  assert.ok(!/last_diamond_bonus: null/.test(bonus),
    'the diamond bonus still clears its cooldown on failure');

  const aff = read('routes', 'affiliate.js');
  assert.match(aff, /COLLECT UNRESOLVED/, 'affiliate earnings are still restored after a failed credit');

  const ref = read('services', 'referralService.js');
  assert.match(ref, /PAYMENT UNRESOLVED/, 'a referral reward is still re-armed after a failed transfer');
  // A definite refusal — the bank being short — IS safe to re-arm, and must be.
  assert.match(ref, /unclaim\('platform fee balance too low'\)/,
    'a reward the bank could not pay is no longer collectable later');
});

test('the daily bonus stamps and credits in a single statement', () => {
  // Not two. The cooldown and the coin move together or not at all, which is
  // what makes replaying it — a hundred times, concurrently — pay once.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'SCHEMA.sql'), 'utf8');
  const fn = schema.slice(schema.indexOf('FUNCTION claim_daily_bonus'));
  const body = fn.slice(0, fn.indexOf('$$;'));

  assert.match(body, /UPDATE profiles[\s\S]*c_coins\s*=\s*c_coins \+ 1[\s\S]*last_bonus_claimed = now\(\)/,
    'the credit and the stamp are not the same UPDATE');
  assert.match(body, /now\(\) - last_bonus_claimed >= INTERVAL '24 hours'/,
    'the cooldown is not part of the WHERE, so it does not serialise');
  assert.match(body, /ROW_COUNT[\s\S]*RAISE EXCEPTION 'already_claimed'/,
    'a claim that changed no row is not reported as a failure');
});

// ═══════════════════════════════════════════════════════════════════════════
//  5. Concurrency — the database is the only thing that can settle this
// ═══════════════════════════════════════════════════════════════════════════

test('spending is a conditional UPDATE, not a read followed by a write', () => {
  // 100 simultaneous wagers against a balance of 1 must leave the balance at
  // 1 or 0, never negative. That property is not in the application — it is in
  // this one statement, and it is why there is no lock in the Node code.
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'SCHEMA.sql'), 'utf8');

  const deduct = schema.slice(schema.indexOf('FUNCTION deduct_coins'));
  const body = deduct.slice(0, deduct.indexOf('$$;'));
  assert.match(body, /IF amount <= 0 THEN RAISE EXCEPTION/, 'a negative deduction would be a credit');
  assert.match(body, /UPDATE profiles SET c_coins = c_coins - amount\s*\n?\s*WHERE id = user_id AND c_coins >= amount/,
    'the balance check is not part of the UPDATE, so two requests can both pass it');
  assert.match(body, /IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient balance'/,
    'a deduction that changed nothing is reported as success');

  // And crediting refuses a negative, or every credit is a withdrawal.
  const credit = schema.slice(schema.indexOf('FUNCTION credit_coins'));
  assert.match(credit.slice(0, credit.indexOf('$$;')),
    /IF amount <= 0 THEN RAISE EXCEPTION/);
});

test('the application never reads a balance and writes it back', () => {
  // The pattern that cannot be made safe from Node. Balances move through
  // credit_/deduct_ RPCs, which are conditional single statements; a direct
  // write to a balance column from application code is the bug this forbids.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src');

  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const code = fs.readFileSync(full, 'utf8')
        .split(/\r?\n/).filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      for (const m of code.matchAll(/\.update\(\s*\{[^}]*\b(c_coins|diamonds|fee_balance|affiliate_earnings_c)\s*:/g)) {
        offenders.push(`${path.relative(dir, full)}: sets ${m[1]} directly`);
      }
    }
  };
  walk(dir);

  // The two that are allowed, and why:
  //   admin.js       — clearing a balance to zero is an admin action, audited.
  //   wallet.js      — a demo account setting its own play money; isDemo is an
  //                    env allowlist, and a demo can neither tip nor withdraw.
  //   affiliate.js   — zeroing earnings as part of the collect claim.
  const allowed = /^(routes[\\/]admin\.js|routes[\\/]wallet\.js|routes[\\/]affiliate\.js)/;
  const unexpected = offenders.filter(o => !allowed.test(o));
  assert.deepEqual(unexpected, [],
    `application code writes a balance directly:\n  ${unexpected.join('\n  ')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
//  6. Deposits — the one place value legitimately enters
// ═══════════════════════════════════════════════════════════════════════════

test('an unsigned deposit webhook credits nobody', () => {
  const { verifyWebhook } = require('../src/services/cryptomusService');
  const body = { uuid: 'x', order_id: `dep_${ATTACKER}_usdc`, status: 'paid', merchant_amount: '10000' };

  assert.equal(verifyWebhook(body), false, 'a body with no signature was accepted');
  assert.equal(verifyWebhook({ ...body, sign: 'x'.repeat(32) }), false, 'a made-up signature was accepted');
  assert.equal(verifyWebhook({}), false);
  assert.equal(verifyWebhook(null), false);
});

test('a missing webhook secret rejects everything instead of trusting everything', () => {
  // The dangerous shape: with no key, the expected signature is an MD5 over
  // `payload + undefined`, which anyone can compute — the algorithm is in
  // Cryptomus's public documentation. The endpoint is mounted unconditionally
  // and credits a deposit to whatever user id the order_id names, so an
  // environment missing one variable would hand balances to anyone who posted
  // to it.
  const before = process.env.CRYPTOMUS_PAYMENT_KEY;
  delete require.cache[require.resolve('../src/services/cryptomusService')];
  process.env.CRYPTOMUS_PAYMENT_KEY = '';
  try {
    const { verifyWebhook } = require('../src/services/cryptomusService');
    const body = { uuid: 'x', order_id: `dep_${ATTACKER}_usdc`, status: 'paid', merchant_amount: '10000' };
    const sorted = Object.keys(body).sort().reduce((a, k) => (a[k] = body[k], a), {});
    const forged = crypto.createHash('md5')
      .update(Buffer.from(JSON.stringify(sorted)).toString('base64') + '')
      .digest('hex');
    assert.equal(verifyWebhook({ ...body, sign: forged }), false,
      'a forged signature was accepted because no key is configured');
  } finally {
    if (before === undefined) delete process.env.CRYPTOMUS_PAYMENT_KEY;
    else process.env.CRYPTOMUS_PAYMENT_KEY = before;
    delete require.cache[require.resolve('../src/services/cryptomusService')];
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  7. Withdrawals — value leaving
// ═══════════════════════════════════════════════════════════════════════════

test('a demo account cannot withdraw its own invented balance', () => {
  // A demo sets its balance directly through the tip form — that is the point
  // of it — so the one thing it must never do is take that money out, or the
  // play money becomes real. Checked at the top of the guard, before anything
  // else can go wrong.
  const fs = require('node:fs');
  const path = require('node:path');
  const wallet = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
  const guards = wallet.slice(wallet.indexOf('async function withdrawalGuards'));

  assert.match(guards.slice(0, 400), /isDemo\(req\.user\.id\)[\s\S]{0,120}Demo accounts cannot withdraw/,
    'the demo check is not the first thing a withdrawal does');
  // And both withdrawal routes run the guards before anything else.
  for (const route of ["router.post('/withdraw'", "router.post('/withdraw-fiat'"]) {
    const at = wallet.indexOf(route);
    assert.ok(at > 0, `${route} not found`);
    assert.match(wallet.slice(at, at + 260), /const blocked = await withdrawalGuards\(req\);/,
      `${route} does not run the withdrawal guards first`);
  }
});

test('a demo account cannot move its invented balance to a real one', () => {
  // Both directions. A demo tipping out would launder play money into the real
  // economy; a real account tipping in would be burning real money for it.
  const fs = require('node:fs');
  const path = require('node:path');
  const wallet = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');
  const tip = wallet.slice(wallet.indexOf("router.post('/tip'"));

  const demoBranch = tip.indexOf('if (isDemo(req.user.id))');
  const recipientLookup = tip.indexOf('.eq(\'username\', recipientUsername');
  assert.ok(demoBranch > 0 && demoBranch < recipientLookup,
    'a demo account reaches the tip path instead of the balance-setter');
  assert.match(tip, /if \(isDemo\(recipient\.id\)\) return res\.status\(404\)/,
    'a real account can tip a demo, turning play money into real money');
  assert.match(tip, /recipient\.id === req\.user\.id[\s\S]{0,80}cannot tip yourself/,
    'a player can tip themselves');
});

// ═══════════════════════════════════════════════════════════════════════════
//  8. Admin
// ═══════════════════════════════════════════════════════════════════════════

test('every admin route is behind the admin check, and it is not a client flag', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');

  // The identity comes from the verified session, compared against an env var.
  // Not a column on the profile — a user who could set that would be an admin.
  assert.match(admin, /req\.user\.id !== process\.env\.ADMIN_USER_ID/,
    'admin is decided by something other than the session identity');

  const routes = [...admin.matchAll(/router\.(get|post|put|patch|delete)\(([^)]*)/g)];
  assert.ok(routes.length > 20, `only found ${routes.length} admin routes`);
  for (const r of routes) {
    assert.match(r[2], /requireAuth,\s*requireAdmin/,
      `an admin route is not guarded: ${r[0].slice(0, 90)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  9. The socket layer — anything the browser can emit
// ═══════════════════════════════════════════════════════════════════════════

test('no socket event lets a client announce its own result', () => {
  // A client can emit anything, so the question is what the server is willing
  // to be told. It accepts scores and progress — which are clamped against a
  // server-tracked value — and nothing that names a winner, a payout or an
  // amount.
  const fs = require('node:fs');
  const path = require('node:path');
  const handlers = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'socket', 'handlers.js'), 'utf8');

  const events = [...handlers.matchAll(/socket\.on\('([a-z_0-9]+)'/g)].map(m => m[1]);
  assert.ok(events.length > 40, `only found ${events.length} socket events`);

  const FORBIDDEN = /^(win|winner|i_won|match_?complete|game_?complete|award|award_?coins|update_?balance|claim_?reward|payout|set_?balance|credit)$/;
  const bad = events.filter(e => FORBIDDEN.test(e));
  assert.deepEqual(bad, [], `a socket event announces a result or a payout: ${bad.join(', ')}`);

  // The result-bearing events are score submissions, and every one of them is
  // resolved against the server's own tracking rather than the number sent.
  assert.match(handlers, /socket\.on\('block_blast_complete'/);
  const engine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockBlastEngine.js'), 'utf8');
  assert.match(engine,
    /const verifiedScore = room\.pingScores\[socketId\] \?\? 0;/,
    'the submitted score is trusted instead of the tracked one');
});

test('a socket cannot act on a room it is not in', () => {
  // Without this an outsider who guessed a room id could write into another
  // match's score and timing maps. The socket id itself cannot be forged — the
  // server assigns it — so membership is the check that matters.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['blockBlastEngine.js', 'colorRushEngine.js', 'carDashEngine.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
    assert.match(code, /function _isPlayer\(room, socketId\)/, `${f} has no membership check`);
    assert.match(code, /if \(!_isPlayer\(room, socketId\)\) return/, `${f} does not use it`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  10. Defence in depth — and the limits of it
// ═══════════════════════════════════════════════════════════════════════════

test('the money endpoints are rate limited, per session and not per user id', () => {
  // The key matters more than the limit. Reading a user id out of an
  // unverified token would let anyone spend a victim's budget by sending the
  // victim's id — a rate limit turned into a way to lock somebody out of their
  // own wallet. A session token cannot be guessed, so there is nothing to
  // forge; per-IP would put a whole household in one bucket.
  const fs = require('node:fs');
  const path = require('node:path');
  const limiter = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'rateLimit.js'), 'utf8');

  assert.match(limiter, /const moneyLimiter = rateLimit\(/);
  assert.match(limiter, /createHash\('sha256'\)\.update\(header\.slice\(7\)\)/,
    'the limiter key is not derived from the session token');
  assert.ok(!/req\.user\?\.id \|\| req\.ip/.test(limiter),
    'the key falls back to a user id that has not been verified yet');

  // And it is actually in front of everything that moves a balance.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  for (const mount of ['wallet', 'bonus', 'rewards', 'affiliate', 'tournaments', 'rakeback']) {
    assert.ok(index.includes(`app.use('/api/${mount}', moneyLimiter`),
      `/api/${mount} is not behind the money limiter`);
  }
});

test('the ledger can be reconciled against the balances', () => {
  // "The hole is closed" and "no money was created" are different claims, and
  // only a reconciliation answers the second. The original incident left an
  // account holding 9,990 coins with no transaction row behind them — a state
  // nothing in the system compared, so nothing in the system noticed.
  const fs = require('node:fs');
  const path = require('node:path');
  const script = path.join(__dirname, '..', 'scripts', 'reconcile-balances.js');
  assert.ok(fs.existsSync(script), 'there is no way to check the books');

  const code = fs.readFileSync(script, 'utf8');
  assert.match(code, /balance - explained/, 'it does not compare the balance to the ledger');
  assert.match(code, /process\.exit\(findings\.some\(f => f\.drift > TOLERANCE\) \? 1 : 0\)/,
    'unexplained coins do not fail the check');
  // A transaction type nobody has modelled makes the answer wrong, so it says so
  // rather than reporting a clean run.
  assert.match(code, /Transaction types this report does not model/);
});
