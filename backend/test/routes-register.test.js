// Every route module must actually mount its routes.
//
// This exists because a file can parse perfectly and still be wrong. Moving
// kycApproved in wallet.js left its two closing braces behind, which the parser
// happily read as closing the `catch` instead — so withdrawalGuards, the
// /withdraw route registration and validateDestination all ended up nested
// INSIDE a catch block. Nothing would have registered. `node --check` passed.
//
// Every other test in this suite reads source as text, so none of them could
// see it. This one loads the modules for real and counts what comes out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');

// A supabase stand-in that answers any call with itself, so module setup that
// touches the client does not need a database.
const fakeSupabase = new Proxy({}, { get: () => () => fakeSupabase });
const fakeIo = { emit() {}, to() { return fakeIo; }, on() {} };

function mount(file) {
  const factory = require(path.join(ROUTES_DIR, file));
  const router = factory(fakeSupabase, fakeIo);
  assert.ok(router?.stack, `${file} did not return a router`);
  return router.stack
    .filter(layer => layer.route)
    .map(layer => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
}

const FILES = fs.readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'));

test('there are route modules to check', () => {
  assert.ok(FILES.length >= 5, 'the routes directory looks wrong');
});

for (const file of FILES) {
  test(`${file} registers its routes`, () => {
    const routes = mount(file);
    assert.ok(routes.length > 0,
      `${file} mounted zero routes — the file parses but its registrations are unreachable`);
  });
}

// The ones where a silent non-registration costs money rather than a 404.
test('the withdrawal routes are both mounted', () => {
  const routes = mount('wallet.js');
  assert.ok(routes.includes('POST /withdraw'),      'the crypto withdrawal route is not registered');
  assert.ok(routes.includes('POST /withdraw-fiat'), 'the bank withdrawal route is not registered');
});

test('the identity routes are mounted', () => {
  const kyc = mount('kyc.js');
  assert.ok(kyc.includes('GET /status'),   'the status route is not registered');
  assert.ok(kyc.includes('POST /session'), 'nothing could start a verification');

  const hooks = mount('webhooks.js');
  assert.ok(hooks.includes('POST /didit'),
    'no webhook means Didit decides and nobody ever hears the answer');
});
