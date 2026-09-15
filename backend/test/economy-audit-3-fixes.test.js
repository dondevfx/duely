// Audit #3 follow-up: every remaining risk that can be fixed in code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const R = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

test('the backend is pinned to one instance', () => {
  for (const p of ['railway.json', 'backend/railway.json']) {
    assert.equal(JSON.parse(R(p)).deploy.numReplicas, 1, `${p} can scale past one instance`);
  }
});

test('the schema files no longer let a browser write profiles or high scores', () => {
  for (const p of ['SCHEMA.sql', 'backend/schema.sql']) {
    const s = R(p);
    assert.ok(!/CREATE POLICY "profiles_update"/.test(s), `${p} lets a user update their own balance`);
    assert.ok(!/CREATE POLICY "profiles_insert"/.test(s), `${p}`);
    assert.ok(/REVOKE INSERT, UPDATE, DELETE ON profiles FROM anon, authenticated;/.test(s));
  }
  assert.ok(!/highscores_(insert|update)" ON game_highscores FOR (INSERT|UPDATE) (WITH CHECK|USING) \(true\)/.test(R('SCHEMA.sql')));
});

test('section 26: tip keys are unique, new types allowed, the minting function dropped', () => {
  const sec = R('PENDING_SQL.sql').slice(R('PENDING_SQL.sql').indexOf('26. Tip idempotency'));
  assert.ok(/tip_requests \(\s*key\s+uuid\s+PRIMARY KEY/.test(sec));
  for (const t of ['tournament_entry', 'tournament_refund', 'rakeback_claim', 'affiliate_payout']) assert.ok(sec.includes(`'${t}'`), t);
  assert.ok(sec.includes('DROP FUNCTION IF EXISTS claim_daily_bonus(uuid);'));
});

function tipApp({ keyTaken = false, balance = 100 } = {}) {
  const moved = [];
  const keys = new Set(keyTaken ? ['11111111-1111-1111-1111-111111111111'] : []);
  const q = (table) => {
    const o = {};
    o.select = () => o; o.eq = () => o;
    o.single = async () => ({ data: table === 'profiles' ? { id: 'rcpt', username: 'bob' } : null, error: null });
    o.insert = async (row) => {
      if (table !== 'tip_requests') return { error: null };
      if (keys.has(row.key)) return { error: { code: '23505', message: 'duplicate key' } };
      keys.add(row.key); return { error: null };
    };
    o.delete = () => ({ eq: async (_c, k) => { keys.delete(k); return { error: null }; } });
    o.then = (res) => res({ error: null });
    return o;
  };
  const supabase = { from: q, rpc: async () => ({ error: null }) };
  const stub = (mod, exp) => { const p = require.resolve(mod); const real = require(mod); require.cache[p].exports = { ...real, ...exp }; return () => { require.cache[p].exports = real; }; };
  const restore = [
    stub('../src/middleware/auth', { requireAuth: (req, _r, next) => { req.user = { id: 'sender' }; next(); } }),
    stub('../src/services/walletService', {
      deductCoins: async (_s, uid, amt) => { if (amt > balance) throw new Error('Insufficient balance'); moved.push(['out', uid, amt]); },
      creditCoins: async (_s, uid, amt) => { moved.push(['in', uid, amt]); },
    }),
    stub('../src/services/demoAccounts', { isDemo: () => false }),
    stub('../src/services/lockService', { isLocked: () => false }),
    stub('../src/services/selfExclusion', { rejectIfExcluded: async () => false }),
  ];
  delete require.cache[require.resolve('../src/routes/wallet')];
  const app = express(); app.use(express.json());
  app.use('/w', require('../src/routes/wallet')(supabase, null));
  restore.forEach(r => r());
  delete require.cache[require.resolve('../src/routes/wallet')];
  return { app, moved, keys };
}
const post = (port, body) => fetch(`http://127.0.0.1:${port}/w/tip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('the same tip delivered ten times at once moves coins once', async () => {
  const { app, moved } = tipApp();
  const server = app.listen(0); const port = server.address().port;
  try {
    const key = '22222222-2222-2222-2222-222222222222';
    const res = await Promise.all(Array.from({ length: 10 }, () => post(port, { recipientUsername: 'bob', amount: 5, idempotencyKey: key })));
    assert.equal(res.filter(r => r.status === 200).length, 1, `${res.filter(r => r.status === 200).length} tips went through`);
    assert.equal(res.filter(r => r.status === 409 && r.body.duplicate).length, 9, 'a replay was not recognised as one');
    assert.equal(moved.filter(m => m[0] === 'out').length, 1, 'coins left the sender more than once');
  } finally { server.close(); }
});

test('a tip refused for balance frees its key; a malformed key is refused', async () => {
  const { app, keys } = tipApp({ balance: 1 });
  const server = app.listen(0); const port = server.address().port;
  try {
    const key = '33333333-3333-3333-3333-333333333333';
    const r = await post(port, { recipientUsername: 'bob', amount: 5, idempotencyKey: key });
    assert.equal(r.status, 400);
    assert.ok(!keys.has(key), 'a tip that never happened kept its key');
    assert.equal((await post(port, { recipientUsername: 'bob', amount: 5, idempotencyKey: 'nope' })).status, 400);
  } finally { server.close(); }
});

test('both tip forms send a fresh key', () => {
  assert.ok(R('frontend/src/components/ChatSidebar.jsx').includes('idempotencyKey: crypto.randomUUID()'));
  assert.ok(R('frontend/src/pages/Tip.jsx').includes('idempotencyKey: crypto.randomUUID()'));
});

test('the wheel coin is paid from the fee balance, never minted', () => {
  const r = R('backend/src/routes/rewards.js');
  const coin = r.slice(r.indexOf("if (roll.kind === 'coins') {"), r.indexOf('} else {', r.indexOf("if (roll.kind === 'coins') {")));
  assert.ok(coin.includes("rpc('pay_referral_from_bank'"), 'the coin prize is not paid from the bank');
  assert.ok(!coin.includes('creditCoins('), 'the coin prize still creates coins');
});

test('tournament entries/refunds, rakeback and affiliate payouts write a named row', () => {
  const tr = R('backend/src/services/tournamentRunner.js');
  assert.ok(tr.includes("type: 'tournament_entry'") && tr.includes("type: 'tournament_refund'"));
  assert.ok(R('backend/src/routes/tournaments.js').includes("type: 'tournament_refund'"));
  assert.ok(R('backend/src/routes/rakeback.js').includes("type: 'rakeback_claim'"));
  assert.ok(R('backend/src/routes/affiliate.js').includes("type: 'affiliate_payout'"));
});

test('reconciliation does not count a tournament entry twice', () => {
  const { reconcile } = require('../scripts/reconcile-ledger');
  const f = reconcile({
    profiles: [{ id: 'p', c_coins: 5, diamonds: 0 }],
    ledger: [
      { user_id: 'p', kind: 'opening', coins_delta: 10, diamonds_delta: 0 },
      { user_id: 'p', kind: 'change', coins_delta: -5, diamonds_delta: 0 },
    ],
    transactions: [
      { user_id: 'p', type: 'tournament_entry', amount_c: 5 },
      { user_id: 'p', type: 'match_loss', amount_c: 5, notes: 'Tournament entry' },
    ],
  });
  assert.equal(f.unattributed.length, 0, 'a tournament entry was counted twice');
});
