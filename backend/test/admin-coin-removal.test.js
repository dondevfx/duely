// Zeroing a balance leaves a record.
//
// /admin/clear-coins and /admin/remove-coins set c_coins to 0 and wrote
// nothing. A balance went from 9.55 to 0 with no withdrawal, no match and no
// transaction — the only way to establish what had happened was to read the
// codebase and eliminate everything that could not have done it.
//
// This table IS the record of what players are owed. An admin action that
// changes a balance invisibly is the one thing that must not be possible.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const ADMIN = '423d2b0c-1dae-4947-8340-b07575954383';

// A profiles/transactions pair that answers what these two routes ask.
function fakeDb({ balance }) {
  const inserted = [];
  const profiles = { [ADMIN]: { c_coins: balance } };
  return {
    inserted,
    profiles,
    from(table) {
      const q = { table, filters: {} };
      const api = {
        select: () => api,
        insert: (row) => { inserted.push(row); return Promise.resolve({ error: null }); },
        update: (patch) => { q.patch = patch; return api; },
        eq: (col, val) => {
          q.filters[col] = val;
          // update() resolves on its terminal .eq()
          if (q.patch && col === 'id') {
            if (profiles[val]) Object.assign(profiles[val], q.patch);
            return Promise.resolve({ error: null });
          }
          return api;
        },
        maybeSingle: async () => ({ data: profiles[q.filters.id] || null, error: null }),
      };
      return api;
    },
  };
}

function boot(db, actor = ADMIN) {
  const app = express();
  app.use(express.json());

  const authPath = require.resolve('../src/middleware/auth');
  const realAuth = require(authPath);
  require.cache[authPath].exports = {
    ...realAuth,
    requireAuth: (req, _res, next) => { req.user = { id: actor }; next(); },
    requireAdmin: (_req, _res, next) => next(),
  };
  delete require.cache[require.resolve('../src/routes/admin')];
  const routes = require('../src/routes/admin');
  app.use('/api/admin', routes(db));
  require.cache[authPath].exports = realAuth;
  delete require.cache[require.resolve('../src/routes/admin')];

  const server = app.listen(0);
  return { server, port: server.address().port };
}

const post = (port, path) =>
  fetch(`http://127.0.0.1:${port}/api/admin${path}`, { method: 'POST' })
    .then(async r => ({ status: r.status, body: await r.json() }));

for (const route of ['/clear-coins', '/remove-coins']) {
  test(`${route} records the coins it removes`, async () => {
    process.env.ADMIN_USER_ID = ADMIN;
    const db = fakeDb({ balance: 9.55 });
    const { server, port } = boot(db);
    try {
      const res = await post(port, route);
      assert.equal(res.status, 200);
      assert.equal(db.profiles[ADMIN].c_coins, 0, 'the balance was not cleared');

      const row = db.inserted.find(r => r.type === 'admin_adjustment');
      assert.ok(row, `${route} cleared a balance and recorded nothing`);
      assert.equal(row.user_id, ADMIN);
      assert.equal(row.amount_c, 9.55,
        'the recorded amount must be what was actually removed');
      assert.match(String(row.notes), /9\.55/, 'the note should carry the amount');
      assert.match(String(row.notes), /-> 0/, 'and the direction');
    } finally { server.close(); }
  });

  test(`${route} reports how much it removed`, async () => {
    // So the caller — and the admin looking at the screen — sees the number.
    process.env.ADMIN_USER_ID = ADMIN;
    const db = fakeDb({ balance: 12.34 });
    const { server, port } = boot(db);
    try {
      const res = await post(port, route);
      assert.equal(res.body.removed, 12.34);
    } finally { server.close(); }
  });

  test(`${route} writes no row when there was nothing to remove`, async () => {
    // Clearing an empty balance is not an event, and a row for it is noise in
    // the one place that has to stay readable.
    process.env.ADMIN_USER_ID = ADMIN;
    const db = fakeDb({ balance: 0 });
    const { server, port } = boot(db);
    try {
      await post(port, route);
      assert.equal(db.inserted.filter(r => r.type === 'admin_adjustment').length, 0,
        'recorded a removal of nothing');
    } finally { server.close(); }
  });
}

test('the type is one the database actually accepts', () => {
  // transactions.type has a check constraint. Probed against production: it
  // allows admin_adjustment, and rejects adjustment, admin_debit, correction
  // and every other obvious name. A type outside it makes the insert fail and
  // the balance change silent again — the exact bug this fixes.
  const src = require('node:fs').readFileSync(
    require.resolve('../src/routes/admin.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function recordCoinRemoval'),
                       src.indexOf('// ── Clear admin coins'));
  assert.match(fn, /type:\s*'admin_adjustment'/,
    'must use a type the check constraint permits');
});

test('a failed insert does not break the action the admin asked for', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../src/routes/admin.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function recordCoinRemoval'),
                       src.indexOf('// ── Clear admin coins'));
  assert.match(fn, /if \(error\) console\.error/,
    'the record is best-effort; it must log rather than throw');
});

test('the balance is read before it is cleared', () => {
  // Read it afterwards and the amount removed is always zero, which is a record
  // that says nothing — the failure this is meant to fix, with extra steps.
  const src = require('node:fs').readFileSync(
    require.resolve('../src/routes/admin.js'), 'utf8');
  for (const route of ["'/clear-coins'", "'/remove-coins'"]) {
    const start = src.indexOf(`router.post(${route}`);
    const body = src.slice(start, src.indexOf('});', src.indexOf('res.json', start)));
    const read = body.indexOf('.select(\'c_coins\')');
    const write = body.indexOf('update({ c_coins: 0 })');
    assert.ok(read > 0 && write > read,
      `${route} clears the balance before reading what it was`);
  }
});
