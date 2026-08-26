// Code that selects a column added by an un-run migration takes down far
// more than the feature it belongs to.
//
// PostgREST rejects the ENTIRE query for one unknown column — it does not
// return the other columns and omit the missing one. So shipping a select
// with `banned` ahead of PENDING_SQL section 17 meant socket authentication
// returned no profile at all, and every player on mobile and desktop saw
// "Connecting…" then "Profile not found" and could not play. The ban feature
// was not the thing that broke; sign-in was.
//
// The match-history route already guarded against exactly this for
// ended_by_forfeit and documented why. This test exists so the next column
// added to a hot-path select cannot skip that lesson again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read  = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const strip = (s) => s.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

const HANDLERS = strip(read('src', 'socket', 'handlers.js'));
const WALLET   = strip(read('src', 'routes', 'wallet.js'));
const ADMIN    = strip(read('src', 'routes', 'admin.js'));

// Columns that exist only after a PENDING_SQL section the user may not have
// run yet. Any select touching one of these needs a fallback.
const PENDING_COLS = ['banned', 'ban_reason', 'banned_at'];

test('socket authentication survives a pending migration', () => {
  // Generalised from a single banned/ban_reason fallback to a list of
  // optional column GROUPS, peeled off newest-first. Adding avatar_url as a
  // second pending group to the old two-query shape would have meant a third
  // hand-written retry — and the times this pattern was written by hand are
  // the times it got forgotten.
  const at = HANDLERS.indexOf("socket.on('authenticate'");
  const body = HANDLERS.slice(at, HANDLERS.indexOf("socket.on('", at + 20));

  assert.match(body, /CORE_COLS/,
    'the columns this handler cannot work without must be separable from the optional ones');
  assert.match(body, /OPTIONAL/,
    'optional column groups must be declared, not hardcoded into one retry');
  assert.match(body, /banned,ban_reason/, 'the ban columns must be an optional group');
  assert.match(body, /avatar_url/,        'avatar_url must be an optional group');

  // Peels one group at a time rather than giving up after a single retry.
  assert.match(body, /for \(let drop = 0; drop <= OPTIONAL\.length; drop\+\+\)/,
    'the fallback must handle EVERY pending group, not just the newest one');

  // The retries have to finish BEFORE the "Profile not found" bail, or the
  // fallback is unreachable and the bug is unchanged.
  const loopAt     = body.indexOf('for (let drop = 0');
  const notFoundAt = body.indexOf("'Profile not found'");
  assert.ok(loopAt !== -1 && loopAt < notFoundAt,
    'the fallback must run before the not-found bail, or players still get locked out');
});

test('the withdrawal ban check does not hard-fail on the missing column', () => {
  const at = WALLET.indexOf('async function withdrawalGuards');
  const body = WALLET.slice(at, WALLET.indexOf("router.post('/withdraw'", at));
  assert.match(body, /banErr && \/banned\|ban_reason\/\.test/,
    'a missing migration must not break withdrawals for everyone');
  assert.match(body, /console\.warn\(.*Ban enforcement is NOT active/,
    'a money guard failing open must be logged loudly, never silently');
});

test('the admin player panel survives the missing column', () => {
  const at = ADMIN.indexOf("router.get('/users/:id'");
  const body = ADMIN.slice(at, ADMIN.indexOf('res.json({', at) + 200);
  assert.match(body, /PROFILE_BASE/, 'base columns must be separable');
  assert.match(body, /pErr && \/banned\|ban_reason\|banned_at\/\.test/,
    'must detect the missing-column error specifically');
  assert.match(body, /\.select\(PROFILE_BASE\)/, 'must re-query without the pending columns');
});

test('no hot-path select embeds a pending column with no fallback beside it', () => {
  // Catches the shape of the original mistake anywhere it reappears: a
  // select naming one of these columns, in a file with no matching
  // missing-column recovery.
  for (const [name, src] of [['handlers.js', HANDLERS], ['wallet.js', WALLET], ['admin.js', ADMIN]]) {
    const selectsPending = PENDING_COLS.some(c => new RegExp(`select\\([^)]*\\b${c}\\b`).test(src));
    if (!selectsPending) continue;
    assert.match(src, /does not exist|banned\|ban_reason|PENDING_SQL section 17/,
      `${name} selects a not-yet-migrated column with no fallback — one unknown column rejects the whole query`);
  }
});
