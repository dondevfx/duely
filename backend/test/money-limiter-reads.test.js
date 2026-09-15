// The money limiter counts writes, not polling reads. The tournament waiting
// room reads every 3 seconds and used to lock the account out of tournaments.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { moneyLimiter } = require('../src/middleware/rateLimit');

test('100 polling reads go through; a burst of writes is still limited', async () => {
  const app = express();
  app.use('/api/t', moneyLimiter, (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const port = server.address().port;
  const auth = { Authorization: 'Bearer ' + 'x'.repeat(40) };
  try {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/t/pool`, { headers: auth });
      assert.equal(r.status, 200, `read ${i + 1} was refused`);
    }
    let refused = 0;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/t/join`, { method: 'POST', headers: auth });
      if (r.status === 429) refused++;
    }
    assert.ok(refused >= 10, 'writes are no longer rate limited');
  } finally { server.close(); }
});
