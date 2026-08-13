// claimDeposit is the single gate every deposit route passes through before
// anything irreversible happens — swapping, forwarding funds, or crediting.
//
// It has to do three things and get all three right: let exactly one caller
// through, let a genuinely abandoned attempt be retried, and refuse to say
// "claimed" when it could not actually record anything (because the caller
// treats 'claimed' as permission to credit real money).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { claimDeposit } = require('../src/services/blockchainMonitor');

// A supabase stub that enforces the partial unique index from PENDING_SQL:
// unique on tx_hash where type in ('deposit','deposit_raw').
function makeDb({ unique = true, insertError = null } = {}) {
  const rows = [];
  const covered = (r) => ['deposit', 'deposit_raw'].includes(r.type) && r.tx_hash != null;

  return {
    rows,
    from() {
      return {
        insert(row) {
          if (insertError) return Promise.resolve({ error: insertError });
          if (unique && covered(row) && rows.some((r) => covered(r) && r.tx_hash === row.tx_hash)) {
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value' } });
          }
          rows.push({ ...row });
          return Promise.resolve({ error: null });
        },
        update(patch) {
          const filters = [];
          const q = {
            eq(col, val) { filters.push((r) => r[col] === val); return q; },
            in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
            select() {
              const hit = rows.filter((r) => filters.every((f) => f(r)));
              hit.forEach((r) => Object.assign(r, patch));
              return Promise.resolve({ data: hit.map((r) => ({ id: r.tx_hash })), error: null });
            },
          };
          return q;
        },
      };
    },
  };
}

const solRow = (txHash) => ({
  user_id: 'u1', type: 'deposit', amount_c: 0,
  crypto_amount: 1.5, crypto_symbol: 'SOL', tx_hash: txHash, status: 'converting',
});

test('the first caller claims it', async () => {
  const db = makeDb();
  assert.equal(await claimDeposit(db, solRow('tx-1')), 'claimed');
  assert.equal(db.rows.length, 1);
});

test('a second pass over the same deposit is refused', async () => {
  const db = makeDb();
  await claimDeposit(db, solRow('tx-1'));
  assert.equal(await claimDeposit(db, solRow('tx-1')), 'taken',
    'a duplicate must never be told it may credit');
  assert.equal(db.rows.length, 1);
});

test('concurrent passes let exactly one through', async () => {
  const db = makeDb();
  const results = await Promise.all([
    claimDeposit(db, solRow('tx-1')),
    claimDeposit(db, solRow('tx-1')),
    claimDeposit(db, solRow('tx-1')),
  ]);
  assert.equal(results.filter((r) => r === 'claimed').length, 1,
    `three passes produced ${results.filter((r) => r === 'claimed').length} claims`);
});

test('an abandoned attempt can be retried', async () => {
  // The swap failed and the coin is still sitting in the deposit wallet. That
  // deposit must not be stranded forever.
  const db = makeDb();
  await claimDeposit(db, solRow('tx-1'));
  db.rows[0].status = 'pending_retry';

  assert.equal(await claimDeposit(db, solRow('tx-1')), 'claimed',
    'a pending_retry row must be takeable');
  assert.equal(db.rows[0].status, 'converting', 'and flipped back to in-progress');
  assert.equal(db.rows.length, 1, 'without duplicating the row');
});

test('only one retry can take over an abandoned attempt', async () => {
  const db = makeDb();
  await claimDeposit(db, solRow('tx-1'));
  db.rows[0].status = 'pending_retry';

  const results = await Promise.all([
    claimDeposit(db, solRow('tx-1')),
    claimDeposit(db, solRow('tx-1')),
  ]);
  assert.equal(results.filter((r) => r === 'claimed').length, 1,
    'the conditional update is what keeps the takeover atomic');
});

test('a confirmed deposit is never retaken', async () => {
  const db = makeDb();
  await claimDeposit(db, { ...solRow('tx-1'), status: 'confirmed' });
  assert.equal(await claimDeposit(db, solRow('tx-1')), 'taken',
    'already-credited money must not be re-claimable');
});

test('a DB fault reports error, not claimed', async () => {
  // The caller reads 'claimed' as permission to credit. Anything that is not a
  // clean claim has to come back as an error so nothing is paid out.
  const db = makeDb({ insertError: { code: '08006', message: 'connection failure' } });
  assert.equal(await claimDeposit(db, solRow('tx-1')), 'error');
});

test('the unique index is what makes the claim atomic', async () => {
  const db = makeDb({ unique: false });
  const results = await Promise.all([
    claimDeposit(db, solRow('tx-1')),
    claimDeposit(db, solRow('tx-1')),
    claimDeposit(db, solRow('tx-1')),
  ]);
  assert.ok(results.filter((r) => r === 'claimed').length > 1,
    'without uniq_deposit_tx_hash this cannot be atomic — the migration is load-bearing');
});

test('no deposit path uses an unsupported ON CONFLICT target', () => {
  // Postgres cannot infer a PARTIAL unique index from a bare ON CONFLICT
  // (tx_hash). An upsert written that way errors, and every such call site here
  // swallowed the error — silently skipping the row that stops a double credit.
  const code = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\.upsert\(/.test(code),
    'upsert needs a conflict target the partial index cannot satisfy — claim by insert instead');
});

test('claims are checked before anything irreversible', () => {
  // Line endings normalised first. The repo stores LF but Windows checks out
  // CRLF, so a pattern anchored on a bare newline matches nothing locally —
  // the test would pass in CI and fail on a dev machine for a reason that has
  // nothing to do with the code being tested.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8')
    .split('\r\n').join('\n');
  // Every claim must be followed by a guard; a claim whose result is ignored is
  // the same as having no claim at all.
  const claims = src.match(/claimDeposit\(supabase, \{[\s\S]*?\}\);\n([\s\S]{0,400})/g) || [];
  assert.equal(claims.length, 3, 'expected the USDC, SOL and ChangeNow deposit routes');
  for (const c of claims) {
    assert.ok(/!==\s*'claimed'/.test(c),
      `a claim result is not being checked:\n${c.slice(0, 200)}`);
  }
});

test('a permanently unswappable deposit becomes visible, not an endless retry', () => {
  // A ChangeNow error is usually transient, but it is ALSO what a deposit under
  // the exchange's minimum looks like — and that never resolves. Releasing the
  // claim every time deleted the row, so a stranded deposit left no record at
  // all: invisible to the admin queue, just a log line twice a minute.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  const block = src.slice(src.indexOf('const fails = (_swapFailures.get(txHash)'),
                          src.indexOf('_swapFailures.delete(txHash);\n  const { watch }'));

  assert.match(block, /if \(fails < SWAP_FAIL_LIMIT\)/,
    'early failures must still retry — most are transient');
  assert.match(block, /status: 'stuck'/,
    'a persistent failure must end up in a status the attention queue lists');
  assert.match(block, /notes: `swap creation failed/,
    'without the exchange error an operator cannot tell why');

  // The give-up path must NOT delete the row, or it stays invisible.
  const giveUp = block.slice(block.indexOf('giving up'));
  assert.ok(!/\.delete\(\)/.test(giveUp),
    'the claim must be kept on give-up — deleting it is what hid the problem');
  assert.match(giveUp, /_seenTxs\.add\(txHash\)/,
    'and the retry loop must stop');
});

test('a cleared failure does not count toward a later give-up', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'blockchainMonitor.js'), 'utf8');
  // After the catch block, a success path resets the counter.
  const after = src.slice(src.indexOf('// Cleared it — do not let a past blip'));
  assert.match(after.slice(0, 200), /_swapFailures\.delete\(txHash\)/,
    'two unrelated blips months apart must not add up to a give-up');
});

test("'stuck' is a status the admin queue actually surfaces", () => {
  const admin = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  const listed = admin.match(/const ATTENTION_STATUSES = \[([^\]]+)\]/)[1];
  assert.ok(listed.includes("'stuck'"),
    'marking it stuck only helps if the queue lists stuck');
});
