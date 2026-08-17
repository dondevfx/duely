// A tip is two writes: take from the sender, give to the recipient. They are
// not one transaction, so the second can fail after the first has committed —
// and when it did, the sender's coins were simply gone. The handler returned a
// 500 and nothing put them back.
//
// This asserts the credit is wrapped and the deduction reversed. It is a source
// scan because the handler is an Express route behind requireAuth and a real
// Supabase client; standing that up would test the stubs more than the code.
// The property it protects is structural anyway: a credit that is not inside a
// try has no reversal, whatever the runtime does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'wallet.js'), 'utf8');

// The tip handler only, so the withdrawal refund path cannot satisfy these.
function tipHandler() {
  const at = SRC.indexOf("router.post('/tip'");
  assert.notEqual(at, -1, "the /tip route is gone — was it renamed?");
  const open = SRC.indexOf('{', SRC.indexOf('=>', at));
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(open, i + 1);
  }
  assert.fail('unbalanced braces in the /tip handler');
}

test('a tip that cannot be credited refunds the sender', () => {
  const body = tipHandler();

  // Both currencies must have a reversal, not just one.
  assert.match(body, /creditCoins\s*\(\s*supabase\s*,\s*req\.user\.id/,
    'a failed coin tip does not credit the sender back — their coins are destroyed');
  assert.match(body, /creditDiamonds\s*\(\s*supabase\s*,\s*req\.user\.id/,
    'a failed diamond tip does not credit the sender back');

  // Every credit TO THE RECIPIENT has to sit inside a try, or there is nothing
  // to trigger the reversal from.
  for (const m of body.matchAll(/(credit(?:Coins|Diamonds))\s*\(\s*supabase\s*,\s*recipient\.id/g)) {
    const before = body.slice(0, m.index);
    const lastTry = before.lastIndexOf('try {');
    const lastDeduct = before.lastIndexOf('deduct');
    assert.ok(lastTry > lastDeduct,
      `${m[1]} to the recipient is not inside a try that follows the deduction — a failure there loses the sender's money`);
  }
});

test('a refund that itself fails is escalated rather than swallowed', () => {
  const body = tipHandler();
  assert.match(body, /CRITICAL/,
    'a tip where both the payout and the refund fail is real money owed to a real person and must be logged for a human');
});

// Guards against the extractor silently reading the wrong text.
test('the tip handler is extracted at a plausible size', () => {
  const len = tipHandler().length;
  assert.ok(len > 1000 && len < 20000, `tip handler came out at ${len} chars — the extractor is not reading the real route`);
});
