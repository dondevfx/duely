// Who earns on a match, when affiliate codes can be renamed.
//
// The earnings used to be resolved from the code STRING at settlement time.
// Codes are re-nameable, so that paid whoever held the string at that moment:
//
//   1. Alice owns 'ALICE'; a hundred players have applied it
//   2. Alice renames her code to 'ALICE2' — 'ALICE' is now unowned
//   3. Bob claims 'ALICE'
//   4. All hundred players start paying Bob
//
// The owner is now pinned when the code is applied. These run the real
// resolveAffiliates against a stub table, so they test the resolution itself
// rather than the shape of the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAffiliates } = require('../src/services/affiliateService');

const FUTURE = new Date(Date.now() + 86400_000).toISOString();
const PAST   = new Date(Date.now() - 86400_000).toISOString();

// Minimal stand-in for the two queries resolveAffiliates makes.
function stubDb(rows, { hasOwnerColumn = true } = {}) {
  return {
    from() {
      return {
        select(cols) {
          if (!hasOwnerColumn && /applied_code_owner_id/.test(cols)) {
            return { in: async () => ({ data: null, error: { message: 'column profiles.applied_code_owner_id does not exist' } }) };
          }
          return {
            in: async (col, vals) => ({
              data: rows.filter(r => vals.includes(r[col])).map(r => ({ ...r })),
              error: null,
            }),
          };
        },
      };
    },
  };
}

const player = (id, over = {}) => ({
  id, affiliate_code: null, applied_affiliate_code: null,
  applied_code_expires_at: null, applied_code_owner_id: null, ...over,
});

test('renaming a code does not hand your downstream to whoever claims it', async () => {
  const rows = [
    // Alice has renamed her code; 'ALICE' is now owned by Bob.
    player('alice', { affiliate_code: 'ALICE2' }),
    player('bob',   { affiliate_code: 'ALICE' }),
    // Carol signed up under Alice, back when Alice owned 'ALICE'.
    player('carol', { applied_affiliate_code: 'ALICE', applied_code_expires_at: FUTURE, applied_code_owner_id: 'alice' }),
    player('dave'),
  ];
  const { owner1, owner2 } = await resolveAffiliates(stubDb(rows), 'carol', 'dave');
  assert.equal(owner1, 'alice', 'the earnings must follow the owner Carol actually signed up under');
  assert.notEqual(owner1, 'bob', 'Bob claimed the freed string and must earn nothing from it');
  assert.equal(owner2, null);
});

test('an expired code earns nobody, pinned or not', async () => {
  const rows = [
    player('alice', { affiliate_code: 'ALICE' }),
    player('carol', { applied_affiliate_code: 'ALICE', applied_code_expires_at: PAST, applied_code_owner_id: 'alice' }),
  ];
  const { owner1 } = await resolveAffiliates(stubDb(rows), 'carol', null);
  assert.equal(owner1, null);
});

test('nobody earns on their own play', async () => {
  // Reachable by renaming: apply someone's code, they rename, you claim the
  // freed string — and the pin now points at you.
  const rows = [
    player('carol', { affiliate_code: 'ALICE', applied_affiliate_code: 'ALICE', applied_code_expires_at: FUTURE, applied_code_owner_id: 'carol' }),
  ];
  const { owner1 } = await resolveAffiliates(stubDb(rows), 'carol', null);
  assert.equal(owner1, null, 'a self-referral must pay nothing, however it was reached');
});

test('an unpinned row still resolves by string, so payouts survive the migration', async () => {
  const rows = [
    player('alice', { affiliate_code: 'ALICE' }),
    // Applied before section 8 ran: code set, owner never pinned.
    player('carol', { applied_affiliate_code: 'ALICE', applied_code_expires_at: FUTURE, applied_code_owner_id: null }),
  ];
  const { owner1 } = await resolveAffiliates(stubDb(rows), 'carol', null);
  assert.equal(owner1, 'alice', 'a row the backfill has not reached must still pay its affiliate');
});

test('a database without the column at all still pays affiliates', async () => {
  const rows = [
    player('alice', { affiliate_code: 'ALICE' }),
    player('carol', { applied_affiliate_code: 'ALICE', applied_code_expires_at: FUTURE }),
  ];
  const { owner1 } = await resolveAffiliates(stubDb(rows, { hasOwnerColumn: false }), 'carol', null);
  assert.equal(owner1, 'alice', 'paying an affiliate must never depend on a migration having been run');
});

test('both players can have different owners', async () => {
  const rows = [
    player('alice', { affiliate_code: 'A' }),
    player('bob',   { affiliate_code: 'B' }),
    player('carol', { applied_affiliate_code: 'A', applied_code_expires_at: FUTURE, applied_code_owner_id: 'alice' }),
    player('dave',  { applied_affiliate_code: 'B', applied_code_expires_at: FUTURE, applied_code_owner_id: 'bob' }),
  ];
  const { owner1, owner2 } = await resolveAffiliates(stubDb(rows), 'carol', 'dave');
  assert.equal(owner1, 'alice');
  assert.equal(owner2, 'bob');
});
