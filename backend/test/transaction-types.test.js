// Every transaction type the code writes must be allowed by the database.
//
// This is here because it was not, and it silently broke every BTC, ETH, LTC,
// DOGE, BNB and TRX deposit:
//
//   [monitor] claim failed — new row for relation "transactions" violates
//             check constraint "transactions_type_check"
//
// 'deposit_raw' was added to the code — non-SOL coins claim the on-chain
// transaction before forwarding it to ChangeNow — and the CHECK constraint was
// never updated to allow it. Postgres rejected the row, the claim failed, the
// deposit was never forwarded and never credited, and the monitor retried every
// 45 seconds forever.
//
// The deposit path fails SAFE — the claim is taken before any funds move, so a
// rejected claim means nothing was forwarded and nothing was credited. But it
// fails silently unless somebody is reading the logs, which is why this exists:
// adding a type in code without the matching migration now fails the suite
// instead of quietly stopping deposits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'PENDING_SQL.sql'), 'utf8');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : (e.name.endsWith('.js') ? [p] : []);
  });
}

// Types the backend writes to `transactions`.
//
// Matched as `type: '...'` while excluding `game_type: '...'`, which is a
// different column on a different table and would otherwise drag in the game
// names (blackjack, tower, scrabble, coin_flip) and produce false failures.
function typesUsedInCode() {
  const found = new Map();   // type -> file that uses it
  for (const file of sourceFiles(SRC_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(\w*)type:\s*'([a-z_]+)'/g)) {
      if (m[1] === 'game_' || m[1] === 'crypto_') continue;
      if (!found.has(m[2])) found.set(m[2], path.relative(SRC_DIR, file));
    }
  }
  return found;
}

// The types the migration permits.
function typesAllowedBySql() {
  const at = SQL.indexOf('transactions_type_check CHECK (type IN (');
  assert.notEqual(at, -1, 'the transactions_type_check migration is missing from PENDING_SQL.sql');
  const block = SQL.slice(at, SQL.indexOf('));', at));
  return new Set([...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
}

test('every transaction type the code writes is allowed by the constraint', () => {
  const allowed = typesAllowedBySql();
  const used = typesUsedInCode();

  // Values that are genuinely not transaction types — socket/game plumbing that
  // happens to use the same key name. Listed explicitly so a real new type
  // cannot hide among them.
  const NOT_A_TRANSACTION = new Set([
    'blackjack', 'coin_flip', 'scrabble', 'tower', 'blockblast', 'cardash',
  ]);

  const missing = [...used].filter(([t]) => !allowed.has(t) && !NOT_A_TRANSACTION.has(t));
  assert.deepEqual(missing.map(([t]) => t), [],
    'these types are written by the code but rejected by the database — ' +
    'inserts using them fail, and for deposits that means the coins never move: ' +
    missing.map(([t, f]) => `${t} (${f})`).join(', '));
});

test("the type that broke deposits is specifically allowed", () => {
  const allowed = typesAllowedBySql();
  assert.ok(allowed.has('deposit_raw'),
    'without deposit_raw, every coin that routes through ChangeNow — BTC, ETH, LTC, DOGE, BNB, TRX — fails to deposit');
  assert.ok(allowed.has('deposit'), 'plain deposits must still be allowed');
});

test('the claim happens before any funds move', () => {
  // This is what made the failure safe rather than a loss. If the forward ever
  // moved ahead of the claim, a rejected claim would mean coins sent to
  // ChangeNow with no record and no credit.
  const mon = fs.readFileSync(path.join(SRC_DIR, 'services', 'blockchainMonitor.js'), 'utf8');
  const claimAt   = mon.indexOf("type: 'deposit_raw'");
  const forwardAt = mon.indexOf('createDepositSwap(', claimAt);
  assert.ok(claimAt !== -1 && forwardAt !== -1, 'the deposit_raw claim or the forward is gone');
  assert.ok(claimAt < forwardAt,
    'the claim must be taken before the swap is created, or a rejected claim strands funds');
});

test('a rejected claim does not credit the player', () => {
  const mon = fs.readFileSync(path.join(SRC_DIR, 'services', 'blockchainMonitor.js'), 'utf8');
  const fn = mon.slice(mon.indexOf('async function claimDeposit'), mon.indexOf('async function processDeposit'));
  assert.match(fn, /return 'error'/,
    'a failed claim must be distinguishable from a successful one');
  // And every caller must act on it.
  for (const m of mon.matchAll(/const (\w*[Cc]laim) = await claimDeposit\(/g)) {
    const after = mon.slice(m.index, m.index + 700);
    assert.match(after, new RegExp(`${m[1]} !== 'claimed'`),
      'every claim result must be checked before crediting');
  }
});
